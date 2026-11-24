import { PassThrough } from "node:stream";

import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { TenantActionRunner } from "../auth/request-access-guard.js";
import { loadConfig } from "../config.js";
import type {
  TenantEstablishmentAdministration,
  TenantMutationRateLimiter,
} from "./admin-establishments.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "22222222-2222-4222-8222-222222222222";
const ESTABLISHMENT_ID = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://app.test";
const COOKIE = "renave_session=opaque-session";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function runnerWith(
  outcome: "allowed" | "denied" | "mfa" = "allowed",
): TenantActionRunner {
  return {
    run: vi.fn(async (input, work) => {
      if (outcome !== "allowed") {
        return {
          allowed: false,
          reason: outcome === "mfa" ? "MFA_REQUIRED" : "ACCESS_DENIED",
        } as const;
      }
      return {
        allowed: true,
        value: await work({
          authorization: { allowed: true } as never,
          client: {} as never,
          session: input.session,
        }),
      } as const;
    }),
  };
}

function setup(
  options: {
    administration?: TenantEstablishmentAdministration;
    authenticated?: boolean;
    logger?: boolean;
    logStream?: PassThrough;
    mfaVerified?: boolean;
    mutationRateLimiter?: TenantMutationRateLimiter;
    runner?: TenantActionRunner;
  } = {},
) {
  const getSession = vi.fn(async () =>
    options.authenticated === false
      ? undefined
      : {
          expiresAt: Date.now() + 60_000,
          mfaVerified: options.mfaVerified ?? true,
          roles: ["untrusted-idp-role"],
          subject: "oidc|administrator-secret",
        },
  );
  const identity = {
    config: { publicOrigin: ORIGIN },
    getSession,
  } as unknown as IdentityService;
  const administration =
    options.administration ??
    ({
      create: vi.fn(async () => ({
        establishment: {
          id: ESTABLISHMENT_ID,
          tradeName: "Loja Centro",
        },
        replayed: false,
      })),
    } satisfies TenantEstablishmentAdministration);
  const mutationRateLimiter =
    options.mutationRateLimiter ??
    ({
      acquire: vi.fn(async () => ({ allowed: true as const })),
    } satisfies TenantMutationRateLimiter);
  const tenantActionRunner = options.runner ?? runnerWith();
  const app = buildApp({
    config: loadConfig(),
    identity,
    logger: options.logger ?? false,
    ...(options.logStream ? { logStream: options.logStream } : {}),
    tenantActionRunner,
    tenantEstablishmentAdministration: administration,
    tenantMutationRateLimiter: mutationRateLimiter,
  });
  apps.push(app);
  return {
    administration,
    app,
    getSession,
    mutationRateLimiter,
    tenantActionRunner,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: {
      cookie: COOKIE,
      "idempotency-key": IDEMPOTENCY_KEY,
      origin: ORIGIN,
    },
    method: "POST",
    payload: { cnpj: "11.222.333/0001-81", tradeName: "  Loja Centro  " },
    url: `/api/tenants/${TENANT_ID}/establishments`,
    ...overrides,
  } as never;
}

describe("POST administrativo de estabelecimento", () => {
  it("recusa Origin ausente ou divergente antes da sessão e do negócio", async () => {
    for (const origin of [undefined, "https://evil.test"]) {
      const {
        administration,
        app,
        getSession,
        mutationRateLimiter,
        tenantActionRunner,
      } = setup();
      const response = await app.inject(
        request({
          headers: {
            cookie: COOKIE,
            "idempotency-key": IDEMPOTENCY_KEY,
            ...(origin ? { origin } : {}),
          },
        }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "CSRF_ORIGIN_MISMATCH" });
      expect(getSession).not.toHaveBeenCalled();
      expect(mutationRateLimiter.acquire).not.toHaveBeenCalled();
      expect(tenantActionRunner.run).not.toHaveBeenCalled();
      expect(administration.create).not.toHaveBeenCalled();
    }
  });

  it("exige sessão e MFA antes de consumir o limitador", async () => {
    const unauthenticated = setup({ authenticated: false });
    const noSession = await unauthenticated.app.inject(request());
    expect(noSession.statusCode).toBe(401);
    expect(unauthenticated.mutationRateLimiter.acquire).not.toHaveBeenCalled();

    const withoutMfa = setup({ mfaVerified: false });
    const noMfa = await withoutMfa.app.inject(request());
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json()).toEqual({ code: "MFA_REQUIRED" });
    expect(withoutMfa.mutationRateLimiter.acquire).not.toHaveBeenCalled();
  });

  it("não distingue tenant inválido, inexistente ou não autorizado", async () => {
    const malformed = setup();
    const invalid = await malformed.app.inject(
      request({ url: "/api/tenants/not-a-uuid/establishments" }),
    );
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(malformed.mutationRateLimiter.acquire).not.toHaveBeenCalled();

    const denied = setup({ runner: runnerWith("denied") });
    const unavailable = await denied.app.inject(request());
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(denied.mutationRateLimiter.acquire).not.toHaveBeenCalled();
    expect(denied.administration.create).not.toHaveBeenCalled();
  });

  it("rejeita chave de idempotência inválida e mass assignment", async () => {
    const { administration, app, mutationRateLimiter } = setup();
    const badKey = await app.inject(
      request({
        headers: {
          cookie: COOKIE,
          "idempotency-key": "guessable-key",
          origin: ORIGIN,
        },
      }),
    );
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json()).toEqual({ code: "INVALID_IDEMPOTENCY_KEY" });

    const extraField = await app.inject(
      request({
        payload: {
          cnpj: "11222333000181",
          tenantId: "attacker-selected",
          tradeName: "Loja Centro",
        },
      }),
    );
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json()).toEqual({
      code: "INVALID_ESTABLISHMENT_INPUT",
    });
    expect(mutationRateLimiter.acquire).not.toHaveBeenCalled();
    expect(administration.create).not.toHaveBeenCalled();
  });

  it.each([
    { cnpj: "x".repeat(33), tradeName: "Loja" },
    { cnpj: "11222333000180", tradeName: "Loja" },
    { cnpj: "11222333000181", tradeName: "" },
    { cnpj: "11222333000181", tradeName: `Loja${String.fromCharCode(0)}` },
    { cnpj: "11222333000181", tradeName: "x".repeat(161) },
  ])("rejeita entrada fora do contrato: %j", async (payload) => {
    const { app } = setup();
    const response = await app.inject(request({ payload }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_ESTABLISHMENT_INPUT" });
  });

  it("normaliza entrada, usa runner e retorna somente a projeção mínima", async () => {
    const { administration, app, tenantActionRunner } = setup();
    const response = await app.inject(request());

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(
      `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}`,
    );
    expect(response.json()).toEqual({
      establishment: { id: ESTABLISHMENT_ID, tradeName: "Loja Centro" },
      renaveLink: { status: "not_started" },
    });
    expect(response.body).not.toContain("11222333000181");
    expect(tenantActionRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.establishment.manage",
        tenantId: TENANT_ID,
      }),
      expect.any(Function),
    );
    expect(tenantActionRunner.run).toHaveBeenCalledTimes(2);
    expect(administration.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorSubject: "oidc|administrator-secret",
        cnpj: "11222333000181",
        idempotencyKey: IDEMPOTENCY_KEY,
        tradeName: "Loja Centro",
      }),
    );
  });

  it("repete RBAC após o limite e bloqueia revogação antes da escrita", async () => {
    let authorizationAttempt = 0;
    const runner: TenantActionRunner = {
      run: vi.fn(async (input, work) => {
        authorizationAttempt += 1;
        if (authorizationAttempt === 2) {
          return { allowed: false, reason: "ACCESS_DENIED" } as const;
        }
        return {
          allowed: true,
          value: await work({
            authorization: { allowed: true } as never,
            client: {} as never,
            session: input.session,
          }),
        } as const;
      }),
    };
    const { administration, app, mutationRateLimiter } = setup({ runner });

    const response = await app.inject(request());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(mutationRateLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(administration.create).not.toHaveBeenCalled();
  });

  it("marca replay sem executar uma resposta de criação nova", async () => {
    const administration: TenantEstablishmentAdministration = {
      create: vi.fn(async () => ({
        establishment: { id: ESTABLISHMENT_ID, tradeName: "Loja Centro" },
        replayed: true,
      })),
    };
    const { app } = setup({ administration });
    const response = await app.inject(request());
    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotency-replayed"]).toBe("true");
  });

  it("falha fechado quando o limitador falta, nega ou está indisponível", async () => {
    const missing = buildApp({
      config: loadConfig(),
      identity: {
        config: { publicOrigin: ORIGIN },
        getSession: vi.fn(async () => ({
          expiresAt: Date.now() + 60_000,
          mfaVerified: true,
          roles: [],
          subject: "subject",
        })),
      } as unknown as IdentityService,
      logger: false,
    });
    apps.push(missing);
    const notConfigured = await missing.inject(request());
    expect(notConfigured.statusCode).toBe(503);
    expect(notConfigured.json()).toEqual({
      code: "TENANT_ADMINISTRATION_NOT_CONFIGURED",
    });

    const limited = setup({
      mutationRateLimiter: {
        acquire: vi.fn(async () => ({
          allowed: false,
          retryAfterSeconds: 17,
        })),
      },
    });
    const denied = await limited.app.inject(request());
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["retry-after"]).toBe("17");
    expect(limited.tenantActionRunner.run).toHaveBeenCalledTimes(1);
    expect(limited.administration.create).not.toHaveBeenCalled();

    const failed = setup({
      mutationRateLimiter: {
        acquire: vi.fn(async () => {
          throw new Error("postgres secret");
        }),
      },
    });
    const unavailable = await failed.app.inject(request());
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      code: "TENANT_MUTATION_LIMIT_UNAVAILABLE",
    });
    expect(failed.tenantActionRunner.run).toHaveBeenCalledTimes(1);
    expect(failed.administration.create).not.toHaveBeenCalled();

    const malformedDecision = setup({
      mutationRateLimiter: {
        acquire: vi.fn(async () => ({
          allowed: false,
          retryAfterSeconds: 0,
        })),
      },
    });
    const invalidDecision = await malformedDecision.app.inject(request());
    expect(invalidDecision.statusCode).toBe(503);
    expect(invalidDecision.json()).toEqual({
      code: "TENANT_MUTATION_LIMIT_UNAVAILABLE",
    });
    expect(malformedDecision.tenantActionRunner.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TenantAdminCnpjConflictError", 409, "ESTABLISHMENT_CNPJ_CONFLICT"],
    ["TenantAdminIdempotencyConflictError", 409, "IDEMPOTENCY_KEY_REUSED"],
    ["TenantAdminAccessDeniedError", 404, "TENANT_RESOURCE_NOT_FOUND"],
    ["TenantAdminStorageError", 503, "TENANT_ADMINISTRATION_UNAVAILABLE"],
  ])("mapeia %s para erro estável", async (name, status, code) => {
    const error = new Error("postgres://secret@db/private");
    error.name = name;
    const { app } = setup({
      administration: {
        create: vi.fn(async () => {
          throw error;
        }),
      },
    });
    const response = await app.inject(request());
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain("secret");
  });

  it("não registra CNPJ, nome, subject, chave ou erro de banco", async () => {
    const stream = new PassThrough();
    let logs = "";
    stream.on("data", (chunk) => {
      logs += chunk.toString();
    });
    const error = new Error("postgres://private-secret@db/internal");
    error.name = "TenantAdminStorageError";
    const { app } = setup({
      administration: {
        create: vi.fn(async () => {
          throw error;
        }),
      },
      logger: true,
      logStream: stream,
    });
    const response = await app.inject(request());
    await new Promise<void>((resolve, reject) =>
      stream.write("", (error) => (error ? reject(error) : resolve())),
    );
    expect(response.statusCode).toBe(503);
    for (const secret of [
      "11222333000181",
      "Loja Centro",
      "administrator-secret",
      IDEMPOTENCY_KEY,
      "private-secret",
      "opaque-session",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("recusa corpo maior que 8 KiB antes da administração", async () => {
    const { administration, app } = setup();
    const response = await app.inject(
      request({
        payload: { cnpj: "11222333000181", tradeName: "x".repeat(9_000) },
      }),
    );
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: "REQUEST_BODY_TOO_LARGE" });
    expect(administration.create).not.toHaveBeenCalled();
  });
});
