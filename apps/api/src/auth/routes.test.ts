import { Writable } from "node:stream";

import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { LoginRateLimiter } from "./routes.js";
import type { SessionLookupGate } from "./routes.js";
import { LocalSessionLookupGate } from "./session-lookup-gate.js";
import type { AppConfig } from "../config.js";

const config: AppConfig = {
  appEnvironment: "homologation",
  authMode: "oidc",
  oidc: {
    issuer: "https://idp.test",
    clientId: "client",
    clientSecret: undefined,
    redirectUri: "https://app.test/api/auth/callback",
    postLogoutRedirectUri: undefined,
    scopes: ["openid"],
    publicOrigin: "https://app.test",
    loginAttemptTtlSeconds: 300,
    sessionIdleTtlSeconds: 1_800,
    sessionAbsoluteTtlSeconds: 43_200,
    httpTimeoutMs: 5_000,
  },
  sessionStore: undefined,
  identityDatabaseUrl: undefined,
  identityDatabaseTlsCaFile: undefined,
  loginRateLimitHmacKeyBase64: undefined,
  sessionLookupMaxConcurrency: 4,
  serproQueryLimitHmacKeyBase64: undefined,
  databaseUrl: undefined,
  databaseTlsCaFile: undefined,
  renave: undefined,
  host: "127.0.0.1",
  port: 3000,
  proxyTrust: { mode: "direct" },
};

function identity(overrides: Partial<IdentityService> = {}): IdentityService {
  return {
    config: { publicOrigin: "https://app.test" },
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://idp.test/authorize?state=opaque",
      bindingSecret: "binding-secret",
      bindingMaxAgeSeconds: 300,
    })),
    completeLogin: vi.fn(async () => ({
      ok: true as const,
      sessionId: "s".repeat(43),
      sessionMaxAgeSeconds: 43_200,
      returnTo: "/painel",
    })),
    getSession: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    buildEndSessionUrl: vi.fn(async () => undefined),
    ...overrides,
  };
}

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function app(
  service: IdentityService,
  logStream?: NodeJS.WritableStream,
  loginRateLimiter: LoginRateLimiter = {
    consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  },
  sessionLookupGate: SessionLookupGate = new LocalSessionLookupGate(4),
) {
  const instance = buildApp({
    config,
    identity: service,
    logger: logStream !== undefined,
    ...(logStream ? { logStream } : {}),
    loginRateLimiter,
    sessionLookupGate,
  });
  apps.push(instance);
  return instance;
}

function cookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers["set-cookie"];
  return Array.isArray(value)
    ? value.map(String)
    : value
      ? [String(value)]
      : [];
}

describe("rotas OIDC", () => {
  it("recusa OIDC não local sem gate de consulta de sessão", () => {
    expect(() =>
      buildApp({
        config,
        identity: identity(),
        logger: false,
        loginRateLimiter: {
          consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
        },
      }),
    ).toThrow("gate de consulta de sessão");
  });

  it("inicia login com redirect e cookie de vínculo protegido", async () => {
    const service = identity();
    const response = await app(service).inject({
      method: "GET",
      url: "/api/auth/login?returnTo=%2Fveiculos",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://idp.test/authorize");
    expect(cookies(response)[0]).toContain(
      "__Host-renave_login=binding-secret",
    );
    expect(cookies(response)[0]).toContain("HttpOnly");
    expect(cookies(response)[0]).toContain("SameSite=Lax");
    expect(cookies(response)[0]).toContain("Secure");
    expect(service.startLogin).toHaveBeenCalledWith({ returnTo: "/veiculos" });
  });

  it("retorna 429 antes do IdP quando o bucket é esgotado", async () => {
    const service = identity();
    const limiter: LoginRateLimiter = {
      consume: vi.fn(async () => ({
        allowed: false as const,
        retryAfterSeconds: 17,
        scope: "client" as const,
      })),
    };
    const response = await app(service, undefined, limiter).inject({
      method: "GET",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.200" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.json()).toEqual({ code: "AUTH_RATE_LIMITED" });
    expect(limiter.consume).toHaveBeenCalledWith("127.0.0.1");
    expect(service.startLogin).not.toHaveBeenCalled();
  });

  it("confia X-Forwarded-For somente quando o socket está no CIDR declarado", async () => {
    const service = identity();
    const limiter: LoginRateLimiter = {
      consume: vi.fn(async () => ({
        allowed: true as const,
        retryAfterSeconds: 0 as const,
      })),
    };
    const instance = buildApp({
      config: {
        ...config,
        proxyTrust: { cidrs: ["10.0.0.0/8"], mode: "trusted-proxy" },
      },
      identity: service,
      logger: false,
      loginRateLimiter: limiter,
      sessionLookupGate: new LocalSessionLookupGate(4),
    });
    apps.push(instance);

    await instance.inject({
      method: "GET",
      url: "/api/auth/login",
      remoteAddress: "10.1.2.3",
      headers: { "x-forwarded-for": "198.51.100.20" },
    });
    expect(limiter.consume).toHaveBeenLastCalledWith("198.51.100.20");

    await instance.inject({
      method: "GET",
      url: "/api/auth/login",
      remoteAddress: "192.0.2.9",
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(limiter.consume).toHaveBeenLastCalledWith("192.0.2.9");
  });

  it("falha fechado sem chamar o IdP quando o limitador está indisponível", async () => {
    const service = identity();
    const limiter: LoginRateLimiter = {
      consume: vi.fn(async () => {
        throw new Error("database secret unavailable");
      }),
    };
    const response = await app(service, undefined, limiter).inject({
      method: "GET",
      url: "/api/auth/login",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "AUTH_RATE_LIMIT_UNAVAILABLE" });
    expect(service.startLogin).not.toHaveBeenCalled();
    expect(response.body).not.toContain("secret");
  });

  it("conclui callback, rotaciona cookie e encaminha os valores ao serviço", async () => {
    const service = identity();
    const response = await app(service).inject({
      method: "GET",
      url: "/api/auth/callback?state=state&code=code",
      headers: {
        cookie:
          "__Host-renave_login=binding; __Host-renave_session=old-session",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/painel");
    expect(cookies(response)).toHaveLength(2);
    expect(cookies(response).join("\n")).toContain("Max-Age=0");
    expect(cookies(response).join("\n")).toContain("__Host-renave_session=");
    expect(service.completeLogin).toHaveBeenCalledWith({
      state: "state",
      code: "code",
      providerError: undefined,
      bindingSecret: "binding",
      previousSessionId: "old-session",
    });
  });

  it("limita callback público antes de consultar state ou store", async () => {
    const service = identity();
    const limiter: LoginRateLimiter = {
      consume: vi.fn(async () => ({
        allowed: false as const,
        retryAfterSeconds: 9,
        scope: "global" as const,
      })),
    };
    const response = await app(service, undefined, limiter).inject({
      method: "GET",
      url: "/api/auth/callback?state=random&code=random",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(service.completeLogin).not.toHaveBeenCalled();
  });

  it("trata falhas de callback e logout como indisponibilidade controlada", async () => {
    const service = identity({
      completeLogin: vi.fn(async () => {
        throw new Error("postgres://secret@identity/private");
      }),
      logout: vi.fn(async () => {
        throw new Error("postgres://secret@identity/private");
      }),
    });
    const instance = app(service);
    const callback = await instance.inject({
      method: "GET",
      url: "/api/auth/callback?state=state&code=code",
    });
    const logout = await instance.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "https://app.test" },
    });

    expect(callback.statusCode).toBe(503);
    expect(callback.json()).toEqual({ code: "AUTH_CALLBACK_UNAVAILABLE" });
    expect(logout.statusCode).toBe(503);
    expect(logout.json()).toEqual({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(callback.body + logout.body).not.toContain("secret");
  });

  it("não expõe subject na sessão pública", async () => {
    const service = identity({
      getSession: vi.fn(async () => ({
        subject: "internal-stable-subject",
        name: "Maria",
        email: "maria@example.invalid",
        roles: ["untrusted-idp-role"],
        expiresAt: Date.now() + 60_000,
      })),
    });
    const response = await app(service).inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `__Host-renave_session=${"s".repeat(43)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: true,
      user: { name: "Maria" },
    });
    expect(response.body).not.toContain("internal-stable-subject");
    expect(response.body).not.toContain("untrusted-idp-role");
  });

  it("não consulta o store quando não existe cookie de sessão", async () => {
    const service = identity();
    const response = await app(service).inject({
      method: "GET",
      url: "/api/session",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: false });
    expect(service.getSession).not.toHaveBeenCalled();
  });

  it("limita concorrência de sessão sem consumir o bucket de login", async () => {
    let finishLookup!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const service = identity({
      getSession: vi.fn(async () => {
        await blocked;
        return undefined;
      }),
    });
    const loginLimiter: LoginRateLimiter = {
      consume: vi.fn(async () => ({
        allowed: true as const,
        retryAfterSeconds: 0 as const,
      })),
    };
    const instance = app(
      service,
      undefined,
      loginLimiter,
      new LocalSessionLookupGate(1),
    );
    const request = {
      method: "GET" as const,
      url: "/api/session",
      headers: { cookie: `__Host-renave_session=${"s".repeat(43)}` },
    };

    const first = instance.inject(request);
    await vi.waitFor(() => expect(service.getSession).toHaveBeenCalledTimes(1));
    const saturated = await instance.inject(request);
    expect(saturated.statusCode).toBe(429);
    expect(saturated.headers["retry-after"]).toBe("1");
    expect(saturated.json()).toMatchObject({ code: "SESSION_LOOKUP_BUSY" });
    expect(loginLimiter.consume).not.toHaveBeenCalled();

    finishLookup();
    expect((await first).statusCode).toBe(200);
    expect((await instance.inject(request)).statusCode).toBe(200);
  });

  it("falha fechado quando o gate de sessão falha", async () => {
    const service = identity();
    const response = await app(service, undefined, undefined, {
      tryAcquire() {
        throw new Error("internal capacity state");
      },
    }).inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `__Host-renave_session=${"s".repeat(43)}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "SESSION_LOOKUP_UNAVAILABLE",
    });
    expect(service.getSession).not.toHaveBeenCalled();
    expect(response.body).not.toContain("internal");
  });

  it("trata falha do store de sessão sem vazar erro interno", async () => {
    const service = identity({
      getSession: vi.fn(async () => {
        throw new Error("postgres://secret@identity/private");
      }),
    });
    const response = await app(service).inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `__Host-renave_session=${"s".repeat(43)}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      authenticated: false,
      code: "SESSION_STORE_UNAVAILABLE",
    });
    expect(response.body).not.toContain("secret");
  });

  it("preserva a sessão anterior quando o callback é rejeitado", async () => {
    const service = identity({
      completeLogin: vi.fn(async () => ({
        ok: false as const,
        reason: "invalid_state" as const,
      })),
    });
    const response = await app(service).inject({
      method: "GET",
      url: "/api/auth/callback?state=bad&code=bad",
      headers: {
        cookie:
          "__Host-renave_login=binding; __Host-renave_session=valid-session",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/?auth_error=invalid_state");
    expect(cookies(response)).toHaveLength(1);
    expect(cookies(response)[0]).toContain("__Host-renave_login=");
    expect(cookies(response)[0]).not.toContain("__Host-renave_session=");
  });

  it("protege logout por Origin e limpa os dois cookies", async () => {
    const service = identity({
      buildEndSessionUrl: vi.fn(async () => "https://idp.test/logout"),
    });
    const instance = app(service);
    const rejected = await instance.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "https://evil.test" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(service.logout).not.toHaveBeenCalled();

    const accepted = await instance.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://app.test",
        cookie: `__Host-renave_session=${"s".repeat(43)}`,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      loggedOut: true,
      endSessionUrl: "https://idp.test/logout",
    });
    expect(cookies(accepted)).toHaveLength(2);
    expect(
      cookies(accepted).every((value) => value.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("remove query, cookies e redirects dos logs", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const service = identity({
      completeLogin: vi.fn(async () => ({
        ok: false as const,
        reason: "invalid_state" as const,
      })),
    });
    await app(service, stream).inject({
      method: "GET",
      url: "/api/auth/callback?state=SUPER_STATE&code=SUPER_CODE",
      headers: { cookie: "__Host-renave_login=SUPER_COOKIE" },
    });

    expect(output).toContain("/api/auth/callback");
    expect(output).not.toContain("SUPER_STATE");
    expect(output).not.toContain("SUPER_CODE");
    expect(output).not.toContain("SUPER_COOKIE");
  });
});
