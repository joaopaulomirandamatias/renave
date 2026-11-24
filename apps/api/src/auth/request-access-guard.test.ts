import type { IdentityService } from "@seu-renave/identity";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRequestAccessGuard,
  createTenantActionRunner,
  type SessionLookupGate,
} from "./request-access-guard.js";

const SESSION_COOKIE = `renave_session=${"s".repeat(43)}`;
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_A = "22222222-2222-4222-8222-222222222222";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function identity(getSession: IdentityService["getSession"]): IdentityService {
  return {
    buildEndSessionUrl: vi.fn(async () => undefined),
    completeLogin: vi.fn(),
    config: { publicOrigin: "https://app.test" },
    getSession,
    logout: vi.fn(async () => undefined),
    startLogin: vi.fn(),
  } as unknown as IdentityService;
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    expiresAt: Date.now() + 60_000,
    issuer: "https://idp.test",
    mfaVerified: false,
    roles: ["idp-role-must-not-authorize"],
    subject: "oidc|admin-a",
    ...overrides,
  };
}

function guardApp(options: {
  gate?: SessionLookupGate;
  getSession?: IdentityService["getSession"];
}) {
  const getSession =
    options.getSession ?? vi.fn(async () => session() as never);
  const guard = createRequestAccessGuard({
    identity: identity(getSession),
    secure: false,
    ...(options.gate ? { sessionLookupGate: options.gate } : {}),
  });
  const app = Fastify({ logger: false });
  app.get("/required", async (request, reply) => {
    const result = await guard.authenticate(request, reply);
    if (!result.ok) return;
    return { subject: result.session?.subject };
  });
  app.get("/optional", async (request, reply) => {
    const result = await guard.authenticate(request, reply, {
      required: false,
      responseBase: { authenticated: false },
    });
    if (!result.ok) return;
    return { authenticated: Boolean(result.session) };
  });
  app.get("/mfa", async (request, reply) => {
    const result = await guard.authenticate(request, reply, {
      mfa: "required",
    });
    if (!result.ok) return;
    return { allowed: true };
  });
  app.get("/mfa-recent", async (request, reply) => {
    const result = await guard.authenticate(request, reply, {
      mfa: "required",
      mfaMaxAgeSeconds: 300,
    });
    if (!result.ok) return;
    return { allowed: true };
  });
  apps.push(app);
  return { app, getSession };
}

describe("RequestAccessGuard", () => {
  it("recusa sessão obrigatória ausente sem consultar o store", async () => {
    const { app, getSession } = guardApp({});

    const response = await app.inject({ method: "GET", url: "/required" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("permite lookup opcional ausente sem consultar o store", async () => {
    const { app, getSession } = guardApp({});

    const response = await app.inject({ method: "GET", url: "/optional" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("aplica backpressure antes do store e anuncia retry", async () => {
    const { app, getSession } = guardApp({
      gate: { tryAcquire: () => undefined },
    });

    const response = await app.inject({
      method: "GET",
      url: "/required",
      headers: { cookie: SESSION_COOKIE },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({ code: "SESSION_LOOKUP_BUSY" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falha fechado quando o gate lança sem consultar o store", async () => {
    const { app, getSession } = guardApp({
      gate: {
        tryAcquire() {
          throw new Error("gate internals");
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/required",
      headers: { cookie: SESSION_COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "SESSION_LOOKUP_UNAVAILABLE" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("libera o permit exatamente uma vez quando o store falha", async () => {
    const release = vi.fn();
    const { app } = guardApp({
      gate: { tryAcquire: () => release },
      getSession: vi.fn(async () => {
        throw new Error("postgres://secret@identity/private");
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/required",
      headers: { cookie: SESSION_COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(response.body).not.toContain("secret");
    expect(release).toHaveBeenCalledOnce();
  });

  it("trata cookie inválido ou sessão expirada como anônimo e libera o permit", async () => {
    const release = vi.fn();
    const getSession = vi.fn(async () => undefined);
    const { app } = guardApp({
      gate: { tryAcquire: () => release },
      getSession,
    });

    const response = await app.inject({
      method: "GET",
      url: "/required",
      headers: { cookie: "renave_session=invalid-or-expired" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(getSession).toHaveBeenCalledWith("invalid-or-expired");
    expect(release).toHaveBeenCalledOnce();
  });

  it("exige MFA explicitamente e falha fechado quando o campo está ausente", async () => {
    const lowAssurance = guardApp({
      getSession: vi.fn(async () => session() as never),
    });
    const legacy = guardApp({
      getSession: vi.fn(async () => {
        const { mfaVerified: _omitted, ...oldSession } = session();
        return oldSession as never;
      }),
    });

    for (const app of [lowAssurance.app, legacy.app]) {
      const response = await app.inject({
        method: "GET",
        url: "/mfa",
        headers: { cookie: SESSION_COOKIE },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "MFA_REQUIRED" });
    }
  });

  it("aceita a sessão somente quando a garantia interna está comprovada", async () => {
    const release = vi.fn();
    const { app } = guardApp({
      gate: { tryAcquire: () => release },
      getSession: vi.fn(async () => session({ mfaVerified: true }) as never),
    });

    const response = await app.inject({
      method: "GET",
      url: "/mfa",
      headers: { cookie: SESSION_COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ allowed: true });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["ausente", undefined],
    ["antiga", Date.now() - 301_000],
    ["futura", Date.now() + 1_000],
  ])("recusa prova MFA recente %s", async (_label, mfaVerifiedAt) => {
    const { app } = guardApp({
      getSession: vi.fn(
        async () => session({ mfaVerified: true, mfaVerifiedAt }) as never,
      ),
    });
    const response = await app.inject({
      method: "GET",
      url: "/mfa-recent",
      headers: { cookie: SESSION_COOKIE },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "MFA_RECENT_REQUIRED" });
  });
});

interface FakeTenantDatabase {
  events: string[];
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
}

function tenantDatabase(
  authorizationRows: readonly Record<string, unknown>[],
): FakeTenantDatabase {
  const events: string[] = [];
  const release = vi.fn();
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized === "begin") events.push("begin");
      else if (normalized.startsWith("select set_config"))
        events.push("tenant");
      else if (normalized.includes("from renave.tenant_user")) {
        events.push("authorize");
        return { rows: authorizationRows };
      } else if (normalized === "commit") events.push("commit");
      else if (normalized === "rollback") events.push("rollback");
      else throw new Error(`SQL inesperado: ${normalized}`);
      return { rows: [] };
    },
    release,
  };
  return {
    events,
    release,
    pool: {
      connect: vi.fn(async () => client),
    } as unknown as Pool,
  };
}

function authorizationRow(
  role: "tenant_admin" | "renave_operator" | "compliance_auditor",
  tenantId = TENANT_A,
  establishmentId: string | null = null,
) {
  return {
    establishment_id: establishmentId,
    role,
    subject: "oidc|admin-a",
    tenant_id: tenantId,
  };
}

describe("TenantActionRunner", () => {
  it.each(["tenant.establishment.manage", "tenant.user.manage"] as const)(
    "exige MFA por política para %s antes de abrir o banco",
    async (action) => {
      const database = tenantDatabase([authorizationRow("tenant_admin")]);
      const work = vi.fn();

      const result = await createTenantActionRunner(database.pool).run(
        {
          action,
          session: session() as never,
          tenantId: TENANT_A,
        },
        work,
      );

      expect(result).toEqual({ allowed: false, reason: "MFA_REQUIRED" });
      expect(database.pool.connect).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    },
  );

  it("mantém autorização e trabalho no mesmo contexto transacional", async () => {
    const database = tenantDatabase([authorizationRow("tenant_admin")]);
    const work = vi.fn(async ({ authorization }) => {
      database.events.push("work");
      expect(authorization).toMatchObject({
        matchedRole: "tenant_admin",
        subject: "oidc|admin-a",
        tenantId: TENANT_A,
      });
      return { created: true };
    });

    const result = await createTenantActionRunner(database.pool).run(
      {
        action: "tenant.establishment.manage",
        session: session({ mfaVerified: true }) as never,
        tenantId: TENANT_A,
      },
      work,
    );

    expect(result).toEqual({ allowed: true, value: { created: true } });
    expect(database.events).toEqual([
      "begin",
      "tenant",
      "authorize",
      "work",
      "commit",
    ]);
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("não exige MFA de leitura RENAVE autorizada pelo escopo local", async () => {
    const database = tenantDatabase([
      authorizationRow("renave_operator", TENANT_A, ESTABLISHMENT_A),
    ]);
    const work = vi.fn(async () => "stock-visible");

    const result = await createTenantActionRunner(database.pool).run(
      {
        action: "renave.stock.read",
        establishmentId: ESTABLISHMENT_A,
        session: session() as never,
        tenantId: TENANT_A,
      },
      work,
    );

    expect(result).toEqual({ allowed: true, value: "stock-visible" });
    expect(work).toHaveBeenCalledOnce();
    expect(database.events).toEqual(["begin", "tenant", "authorize", "commit"]);
  });

  it("não usa role arbitrária da sessão e nega papel local incompatível", async () => {
    const database = tenantDatabase([authorizationRow("renave_operator")]);
    const work = vi.fn();

    const result = await createTenantActionRunner(database.pool).run(
      {
        action: "tenant.establishment.manage",
        session: session({
          mfaVerified: true,
          roles: ["tenant_admin", "platform_superuser"],
        }) as never,
        tenantId: TENANT_A,
      },
      work,
    );

    expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
    expect(work).not.toHaveBeenCalled();
    expect(database.events).toEqual(["begin", "tenant", "authorize", "commit"]);
  });

  it("não distingue tenant sem membership e nunca executa o callback", async () => {
    const database = tenantDatabase([]);
    const work = vi.fn();

    const result = await createTenantActionRunner(database.pool).run(
      {
        action: "tenant.establishment.manage",
        session: session({ mfaVerified: true }) as never,
        tenantId: TENANT_A,
      },
      work,
    );

    expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
    expect(work).not.toHaveBeenCalled();
  });

  it("faz rollback e libera a conexão quando o trabalho autorizado falha", async () => {
    const database = tenantDatabase([authorizationRow("tenant_admin")]);
    const work = vi.fn(async () => {
      database.events.push("work");
      throw new Error("audit unavailable");
    });

    await expect(
      createTenantActionRunner(database.pool).run(
        {
          action: "tenant.establishment.manage",
          session: session({ mfaVerified: true }) as never,
          tenantId: TENANT_A,
        },
        work,
      ),
    ).rejects.toThrow("audit unavailable");
    expect(database.events).toEqual([
      "begin",
      "tenant",
      "authorize",
      "work",
      "rollback",
    ]);
    expect(database.release).toHaveBeenCalledOnce();
  });
});
