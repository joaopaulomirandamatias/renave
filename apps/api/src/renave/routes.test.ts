import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { SerproQueryLimiter } from "./routes.js";
import type { EligibilityUseCase } from "./use-case.js";
import type { RenaveLinkPreflightUseCase } from "./preflight-use-case.js";
import type { RenaveLinkStatusUseCase } from "./link-status-use-case.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://app.test";
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    authenticated?: boolean;
    sessionLookupGate?: { tryAcquire(): (() => void) | undefined };
  } = {},
) {
  const authorizeEligibility = vi.fn<EligibilityUseCase["authorize"]>(
    async () => undefined,
  );
  const execute = vi.fn<EligibilityUseCase["execute"]>(async (_input) => ({
    diagnostico: { veiculoApto: true },
  }));
  const getSession = vi.fn(async () =>
    options.authenticated === false
      ? undefined
      : {
          expiresAt: Date.now() + 60_000,
          roles: ["idp-role-must-not-authorize"],
          subject: "oidc|operator-1",
        },
  );
  const identity = {
    buildEndSessionUrl: vi.fn(),
    completeLogin: vi.fn(),
    config: { publicOrigin: ORIGIN },
    getSession,
    logout: vi.fn(),
    startLogin: vi.fn(),
  } as unknown as IdentityService;
  const eligibility = {
    authorize: authorizeEligibility,
    execute,
  } as EligibilityUseCase;
  const authorizePreflight = vi.fn<RenaveLinkPreflightUseCase["authorize"]>(
    async () => undefined,
  );
  const preflightExecute = vi.fn<RenaveLinkPreflightUseCase["execute"]>(
    async () => ({ environment: "homologation", status: "ready" }),
  );
  const linkStatusExecute = vi.fn<RenaveLinkStatusUseCase["execute"]>(
    async () => ({ status: "not_started" }),
  );
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn<SerproQueryLimiter["acquire"]>(async () => ({
    allowed: true,
    permit: { release },
  }));
  const app = buildApp({
    config: loadConfig(),
    eligibility,
    identity,
    logger: false,
    linkStatus: { execute: linkStatusExecute },
    preflight: { authorize: authorizePreflight, execute: preflightExecute },
    serproQueryLimiter: { acquire },
    ...(options.sessionLookupGate
      ? { sessionLookupGate: options.sessionLookupGate }
      : {}),
  });
  apps.push(app);
  return {
    acquire,
    app,
    authorizeEligibility,
    authorizePreflight,
    execute,
    getSession,
    linkStatusExecute,
    preflightExecute,
    release,
  };
}

async function request(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
) {
  return await app.inject({
    method: "POST",
    url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/vehicle-eligibility`,
    headers: {
      cookie: "renave_session=opaque-session",
      origin: ORIGIN,
    },
    payload: body,
  });
}

describe("rota autenticada de aptidão", () => {
  it("lê somente o estado público do vínculo autorizado", async () => {
    const { app, linkStatusExecute } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/renave-link`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      preflightAvailable: true,
      status: "not_started",
    });
    expect(response.body).not.toMatch(/cnpj|subject|hash/iu);
    expect(linkStatusExecute).toHaveBeenCalledWith({
      establishmentId: ESTABLISHMENT_ID,
      subject: "oidc|operator-1",
      tenantId: TENANT_ID,
    });
  });

  it("executa preflight read-only sem expor os CNPJs confirmados", async () => {
    const { app, preflightExecute, release } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/renave-link-preflight`,
      headers: {
        cookie: "renave_session=opaque-session",
        origin: ORIGIN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      environment: "homologation",
      status: "ready",
    });
    expect(response.body).not.toMatch(/cnpj|85106037|69418503/iu);
    expect(preflightExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        establishmentId: ESTABLISHMENT_ID,
        subject: "oidc|operator-1",
        tenantId: TENANT_ID,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("usa o subject da sessão e envia seletores apenas ao caso de uso", async () => {
    const { acquire, app, execute, getSession, release } = setup();
    const response = await request(app, {
      plate: "abc1d23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ diagnostico: { veiculoApto: true } });
    expect(getSession).toHaveBeenCalledWith("opaque-session");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        crvType: "DIGITAL",
        establishmentId: ESTABLISHMENT_ID,
        plate: "ABC1D23",
        subject: "oidc|operator-1",
        tenantId: TENANT_ID,
      }),
    );
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("roles");
    expect(acquire).toHaveBeenCalledWith({
      establishmentId: ESTABLISHMENT_ID,
      subject: "oidc|operator-1",
      tenantId: TENANT_ID,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("recusa sessão ausente antes de executar o caso de uso", async () => {
    const { app, execute } = setup({ authenticated: false });
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("não executa o caso de uso quando o store de sessão falha", async () => {
    const { app, execute, getSession } = setup();
    getSession.mockRejectedValueOnce(new Error("identity database secret"));
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(response.body).not.toContain("secret");
    expect(execute).not.toHaveBeenCalled();
  });

  it("aplica Origin e valida o corpo sem registrar placa em URL", async () => {
    const { app, execute } = setup();
    const csrf = await app.inject({
      method: "POST",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/vehicle-eligibility`,
      headers: {
        cookie: "renave_session=opaque-session",
        origin: "https://evil.test",
      },
      payload: { plate: "ABC1D23", crvType: "DIGITAL" },
    });
    expect(csrf.statusCode).toBe(403);

    const invalid = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
      tenantOverride: TENANT_ID,
    });
    expect(invalid.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("mapeia autorização local sem expor a mensagem interna", async () => {
    const { acquire, app, authorizeEligibility, execute, release } = setup();
    authorizeEligibility.mockRejectedValueOnce(
      Object.assign(new Error("tenant secreto não existe"), {
        code: "AUTHORIZATION_DENIED",
      }),
    );
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(response.body).not.toContain("tenant secreto");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("protege as rotas RENAVE com o mesmo gate da sessão", async () => {
    const { app, execute, getSession } = setup({
      sessionLookupGate: { tryAcquire: () => undefined },
    });
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({ code: "SESSION_LOOKUP_BUSY" });
    expect(getSession).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("retorna 429 antes do caso de uso quando o limite é atingido", async () => {
    const { acquire, app, execute } = setup();
    acquire.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 11,
      scope: "tenant_concurrency",
    });
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("11");
    expect(response.json()).toEqual({ code: "RENAVE_QUERY_LIMITED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("falha fechado sem executar quando o limitador está indisponível", async () => {
    const { acquire, app, execute } = setup();
    acquire.mockRejectedValueOnce(new Error("database secret unavailable"));
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "RENAVE_QUERY_LIMIT_UNAVAILABLE" });
    expect(response.body).not.toContain("secret");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserva o resultado principal se a liberação do lease falhar", async () => {
    const { app, execute, release } = setup();
    release.mockRejectedValueOnce(new Error("database secret unavailable"));
    const response = await request(app, {
      plate: "ABC1D23",
      crvType: "DIGITAL",
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(response.body).not.toContain("secret");
  });
});
