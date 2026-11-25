import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { TenantActionRunner } from "../auth/request-access-guard.js";
import { loadConfig } from "../config.js";
import type { TenantDirectory } from "./routes.js";

const apps: ReturnType<typeof buildApp>[] = [];
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    authenticated?: boolean;
    directory?: TenantDirectory;
    mfaVerified?: boolean;
    sessionLookupGate?: { tryAcquire(): (() => void) | undefined };
    tenantActionRunner?: TenantActionRunner;
  } = {},
) {
  const getSession = vi.fn(async () =>
    options.authenticated === false
      ? undefined
      : {
          expiresAt: Date.now() + 60_000,
          mfaVerified: options.mfaVerified ?? true,
          roles: ["idp-role-must-not-authorize"],
          subject: "oidc|tenant-user",
        },
  );
  const identity = {
    config: { publicOrigin: "https://app.test" },
    getSession,
  } as unknown as IdentityService;
  const app = buildApp({
    config: loadConfig(),
    identity,
    logger: false,
    ...(options.sessionLookupGate
      ? { sessionLookupGate: options.sessionLookupGate }
      : {}),
    ...(options.directory ? { tenantDirectory: options.directory } : {}),
    ...(options.tenantActionRunner
      ? { tenantActionRunner: options.tenantActionRunner }
      : {}),
  });
  apps.push(app);
  return { app, getSession };
}

function directoryWith(
  overrides: Partial<TenantDirectory> = {},
): TenantDirectory {
  return {
    discover: vi.fn(async () => []),
    getEstablishment: vi.fn(async () => null),
    listEstablishments: vi.fn(async () => ({
      canManageEstablishments: false,
      establishments: [],
    })),
    ...overrides,
  };
}

describe("diretório autenticado de tenants", () => {
  it("usa somente o subject da sessão e retorna a projeção mínima", async () => {
    const discover = vi.fn<TenantDirectory["discover"]>(async () => [
      { displayName: "Organização A", tenantId: "tenant-a" },
    ]);
    const { app } = setup({ directory: directoryWith({ discover }) });
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants?subject=attacker&email=attacker@example.invalid",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenants: [{ displayName: "Organização A", tenantId: "tenant-a" }],
    });
    expect(discover).toHaveBeenCalledWith("oidc|tenant-user");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(response.body).not.toContain("attacker");
  });

  it("recusa sessão ausente antes de consultar o diretório", async () => {
    const discover = vi.fn<TenantDirectory["discover"]>();
    const { app } = setup({
      authenticated: false,
      directory: directoryWith({ discover }),
    });
    const response = await app.inject({ method: "GET", url: "/api/tenants" });

    expect(response.statusCode).toBe(401);
    expect(discover).not.toHaveBeenCalled();
  });

  it("trata indisponibilidade da sessão como 503 sem consultar negócio", async () => {
    const discover = vi.fn<TenantDirectory["discover"]>();
    const { app, getSession } = setup({
      directory: directoryWith({ discover }),
    });
    getSession.mockRejectedValueOnce(new Error("identity database secret"));
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(discover).not.toHaveBeenCalled();
    expect(response.body).not.toContain("secret");
  });

  it("aplica o gate antes de consultar a sessão do diretório", async () => {
    const discover = vi.fn<TenantDirectory["discover"]>();
    const { app, getSession } = setup({
      directory: directoryWith({ discover }),
      sessionLookupGate: { tryAcquire: () => undefined },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({ code: "SESSION_LOOKUP_BUSY" });
    expect(getSession).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("falha fechado quando o banco SaaS não está configurado", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "TENANT_DIRECTORY_NOT_CONFIGURED",
    });
  });

  it("não revela erro interno quando o diretório falha", async () => {
    const directory: TenantDirectory = {
      discover: vi.fn(async () => {
        throw new Error("postgres://secret@db/tenant-private");
      }),
      getEstablishment: vi.fn(async () => null),
      listEstablishments: vi.fn(async () => ({
        canManageEstablishments: false,
        establishments: [],
      })),
    };
    const { app } = setup({ directory });
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "TENANT_DIRECTORY_UNAVAILABLE",
    });
    expect(response.body).not.toContain("secret");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("lista somente estabelecimentos autorizados calculados no servidor", async () => {
    const listEstablishments = vi.fn<TenantDirectory["listEstablishments"]>(
      async () => ({
        canManageEstablishments: true,
        establishments: [{ id: "store-a", tradeName: "Loja A" }],
      }),
    );
    const { app } = setup({
      directory: directoryWith({ listEstablishments }),
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments?roles=tenant_admin`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      capabilities: { establishmentManagement: "available" },
      establishments: [{ id: "store-a", tradeName: "Loja A" }],
    });
    expect(listEstablishments).toHaveBeenCalledWith({
      subject: "oidc|tenant-user",
      tenantId: TENANT_ID,
    });
  });

  it("não distingue tenant inválido de tenant sem membership", async () => {
    const listEstablishments = vi.fn<TenantDirectory["listEstablishments"]>(
      async () => null,
    );
    const { app } = setup({
      directory: directoryWith({ listEstablishments }),
    });
    const guessed = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/api/tenants/not-a-uuid/establishments",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(guessed.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(guessed.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(malformed.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
  });

  it("projeta capability sem expor roles e distingue MFA ausente", async () => {
    const manageable = vi.fn<TenantDirectory["listEstablishments"]>(
      async () => ({ canManageEstablishments: true, establishments: [] }),
    );
    const withMfaMissing = setup({
      directory: directoryWith({ listEstablishments: manageable }),
      mfaVerified: false,
    });
    const mfaRequired = await withMfaMissing.app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments?role=tenant_admin`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(mfaRequired.json()).toEqual({
      capabilities: { establishmentManagement: "mfa_required" },
      establishments: [],
    });
    expect(mfaRequired.body).not.toContain("tenant_admin");

    const deniedDirectory = directoryWith({
      listEstablishments: vi.fn(async () => ({
        canManageEstablishments: false,
        establishments: [],
      })),
    });
    const deniedApp = setup({ directory: deniedDirectory });
    const denied = await deniedApp.app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(denied.json()).toEqual({
      capabilities: { establishmentManagement: "denied" },
      establishments: [],
    });
  });

  it("expõe fila mínima de vínculos após MFA e autorização administrativa", async () => {
    const run = vi.fn(async () => ({
      allowed: true as const,
      value: {
        entries: [
          {
            establishmentId: ESTABLISHMENT_ID,
            status: "pending" as const,
            tradeName: "Loja Centro",
            updatedAt: new Date("2026-11-24T12:00:00.000Z"),
          },
          {
            establishmentId: "33333333-3333-4333-8333-333333333333",
            status: "not_started" as const,
            tradeName: "Loja Norte",
            updatedAt: null,
          },
        ],
        truncated: true,
      },
    }));
    const { app } = setup({
      tenantActionRunner: { run } as unknown as TenantActionRunner,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/renave-link-queue?cnpj=secret`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        {
          establishment: {
            id: ESTABLISHMENT_ID,
            tradeName: "Loja Centro",
          },
          renaveLink: {
            status: "pending",
            updatedAt: "2026-11-24T12:00:00.000Z",
          },
        },
        {
          establishment: {
            id: "33333333-3333-4333-8333-333333333333",
            tradeName: "Loja Norte",
          },
          renaveLink: { status: "not_started" },
        },
      ],
      truncated: true,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.establishment.manage",
        mfa: "required",
        tenantId: TENANT_ID,
      }),
      expect.any(Function),
    );
    expect(response.body).not.toContain("cnpj");
    expect(response.body).not.toContain("tenantId");
    expect(response.body).not.toContain("version");
  });

  it("oculta a fila fora do papel administrativo e exige MFA", async () => {
    const deniedRun = vi.fn(async () => ({
      allowed: false as const,
      reason: "ACCESS_DENIED" as const,
    }));
    const denied = setup({
      tenantActionRunner: { run: deniedRun } as unknown as TenantActionRunner,
    });
    const deniedResponse = await denied.app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/renave-link-queue`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(deniedResponse.statusCode).toBe(404);
    expect(deniedResponse.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });

    const mfaRun = vi.fn();
    const withoutMfa = setup({
      mfaVerified: false,
      tenantActionRunner: { run: mfaRun } as unknown as TenantActionRunner,
    });
    const mfaResponse = await withoutMfa.app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/renave-link-queue`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(mfaResponse.statusCode).toBe(403);
    expect(mfaResponse.json()).toEqual({ code: "MFA_REQUIRED" });
    expect(mfaRun).not.toHaveBeenCalled();
  });

  it("retorna detalhe mínimo e torna o Location administrativo dereferenciável", async () => {
    const getEstablishment = vi.fn<TenantDirectory["getEstablishment"]>(
      async () => ({
        establishment: { id: ESTABLISHMENT_ID, tradeName: "Loja Centro" },
        renaveLink: { status: "not_started" },
      }),
    );
    const { app } = setup({
      directory: directoryWith({ getEstablishment }),
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}?cnpj=secret`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      establishment: { id: ESTABLISHMENT_ID, tradeName: "Loja Centro" },
      renaveLink: { status: "not_started" },
    });
    expect(getEstablishment).toHaveBeenCalledWith({
      establishmentId: ESTABLISHMENT_ID,
      subject: "oidc|tenant-user",
      tenantId: TENANT_ID,
    });
    expect(response.body).not.toContain("cnpj");
    expect(response.body).not.toContain("tenant_admin");
  });

  it("não distingue IDs inválidos, inexistentes ou fora do escopo no detalhe", async () => {
    const getEstablishment = vi.fn<TenantDirectory["getEstablishment"]>(
      async () => null,
    );
    const { app } = setup({
      directory: directoryWith({ getEstablishment }),
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    const malformed = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/not-a-uuid`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(malformed.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(getEstablishment).toHaveBeenCalledTimes(1);
  });
});

describe("trilha de auditoria paginada do tenant", () => {
  const OTHER_ESTABLISHMENT_ID = "33333333-3333-4333-8333-333333333333";

  function runnerWithAuditRows(
    rows: readonly Record<string, unknown>[],
    options: {
      authRows?: readonly Record<string, unknown>[];
      deny?: boolean;
    } = {},
  ) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("from renave.tenant_user")) {
        return {
          rows: options.authRows ?? [
            {
              establishment_id: null,
              role: "compliance_auditor",
              subject: "oidc|tenant-user",
              tenant_id: TENANT_ID,
            },
          ],
        };
      }
      return { rows };
    });
    const runSpy = vi.fn();
    const runner: TenantActionRunner = {
      async run(input, work) {
        runSpy(input, work);
        if (options.deny) return { allowed: false, reason: "ACCESS_DENIED" };
        const value = await work({
          authorization: {
            allowed: true,
            matchedRole: "compliance_auditor",
            subject: input.session.subject,
            tenantId: input.tenantId,
          },
          client: { query } as never,
          session: input.session,
        });
        return { allowed: true, value };
      },
    };
    return { query, runSpy, runner };
  }

  it("retorna página sanitizada com paginação, filtros e Cache-Control: no-store", async () => {
    const { query, runSpy, runner } = runnerWithAuditRows([
      {
        action: "renave.stock.read",
        actor_ip: "198.51.100.99",
        actor_subject: "oidc|sensitive-actor",
        cnpj_sent: "11222333000181",
        establishment_id: ESTABLISHMENT_ID,
        event_hash_prefix: "abcdef0123456789",
        occurred_at: new Date("2026-11-24T12:02:00.000Z"),
        outcome: "succeeded",
        payload: { cpf: "12345678901", secret: "must-not-leak" },
        payload_reference: "pev1_11111111-1111-4111-8111-111111111111",
        sequence: "25",
        trace_id: "trace-25",
      },
      {
        action: "renave.stock.read",
        establishment_id: ESTABLISHMENT_ID,
        event_hash_prefix: "fedcba987654",
        occurred_at: new Date("2026-11-24T12:01:00.000Z"),
        outcome: "succeeded",
        sequence: "24",
        trace_id: null,
      },
    ]);
    const { app } = setup({ tenantActionRunner: runner });

    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/audit-events?limit=1&beforeSequence=30&establishmentId=${ESTABLISHMENT_ID}&action=renave.stock.read&outcome=succeeded`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      hasMore: true,
      items: [
        {
          action: "renave.stock.read",
          entityType: "renave",
          establishmentId: ESTABLISHMENT_ID,
          eventHashPrefix: "abcdef012345",
          occurredAt: "2026-11-24T12:02:00.000Z",
          outcome: "succeeded",
          sequence: 25,
          traceId: "trace-25",
        },
      ],
      nextBeforeSequence: 25,
    });
    expect(response.body).not.toContain("actorSubject");
    expect(response.body).not.toContain("actorIp");
    expect(response.body).not.toContain("sensitive-actor");
    expect(response.body).not.toContain("198.51.100.99");
    expect(response.body).not.toContain("must-not-leak");
    expect(response.body).not.toContain("11222333000181");
    expect(response.body).not.toContain("pev1_");
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "audit.read",
        tenantId: TENANT_ID,
      }),
      expect.any(Function),
    );
    const auditCall = query.mock.calls.find(([sql]) =>
      sql.includes("from renave.audit_event"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toEqual([
      30,
      ESTABLISHMENT_ID,
      "renave.stock.read",
      "succeeded",
      2,
    ]);
  });

  it("recusa sessão ausente com 401", async () => {
    const { runSpy, runner } = runnerWithAuditRows([]);
    const { app } = setup({
      authenticated: false,
      tenantActionRunner: runner,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/audit-events`,
    });

    expect(response.statusCode).toBe(401);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("nega acesso (deny-by-default) quando RBAC ou papel não autoriza audit.read", async () => {
    const denied = runnerWithAuditRows([], { deny: true });
    const { app: appDenied } = setup({ tenantActionRunner: denied.runner });
    const responseDenied = await appDenied.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/audit-events`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(responseDenied.statusCode).toBe(404);
    expect(responseDenied.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });

    const operatorOnly = runnerWithAuditRows([], {
      authRows: [
        {
          establishment_id: OTHER_ESTABLISHMENT_ID,
          role: "renave_operator",
          subject: "oidc|tenant-user",
          tenant_id: TENANT_ID,
        },
      ],
    });
    const { app: appOperator } = setup({
      tenantActionRunner: operatorOnly.runner,
    });
    const responseOperator = await appOperator.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/audit-events`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(responseOperator.statusCode).toBe(404);
    expect(responseOperator.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });
  });

  it.each([
    ["parâmetro desconhecido", "unknown=1"],
    ["parâmetro repetido", "limit=10&limit=20"],
    ["limit zero", "limit=0"],
    ["limit acima de 50", "limit=51"],
    ["limit não numérico", "limit=abc"],
    ["beforeSequence zero", "beforeSequence=0"],
    ["beforeSequence negativo", "beforeSequence=-5"],
    ["establishmentId inválido", "establishmentId=not-a-uuid"],
    ["action inválida", "action=INVALID%20ACTION"],
    ["outcome inválido", "outcome=unknown"],
  ])(
    "rejeita query inválida (%s) com 400 antes do banco",
    async (_label, qs) => {
      const { runSpy, runner } = runnerWithAuditRows([]);
      const { app } = setup({ tenantActionRunner: runner });
      const response = await app.inject({
        method: "GET",
        url: `/api/tenants/${TENANT_ID}/audit-events?${qs}`,
        headers: { cookie: "renave_session=opaque-session" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_AUDIT_QUERY" });
      expect(runSpy).not.toHaveBeenCalled();
    },
  );

  it("rejeita tenantId malformado com 404 sem consultar banco", async () => {
    const { runSpy, runner } = runnerWithAuditRows([]);
    const { app } = setup({ tenantActionRunner: runner });
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants/not-a-uuid/audit-events",
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("usuários e perfis do tenant", () => {
  const OTHER_ESTABLISHMENT_ID = "33333333-3333-4333-8333-333333333333";

  function runnerWithMemberRows(
    rows: readonly Record<string, unknown>[],
    options: { deny?: boolean } = {},
  ) {
    const query = vi.fn(async () => ({ rows }));
    const runSpy = vi.fn();
    const runner: TenantActionRunner = {
      async run(input, work) {
        runSpy(input, work);
        if (options.deny) return { allowed: false, reason: "ACCESS_DENIED" };
        const value = await work({
          authorization: {
            allowed: true,
            matchedRole: "tenant_admin",
            subject: input.session.subject,
            tenantId: input.tenantId,
          },
          client: { query } as never,
          session: input.session,
        });
        return { allowed: true, value };
      },
    };
    return { query, runSpy, runner };
  }

  it("retorna vínculos sanitizados agrupados por estabelecimento com Cache-Control: no-store", async () => {
    const { runSpy, runner } = runnerWithMemberRows([
      {
        created_at: new Date("2026-11-20T09:00:00.000Z"),
        establishment_id: null,
        member_digest:
          "1111111111111111111111111111111111111111111111111111111111111111",
        role: "tenant_admin",
        status: "active",
        subject: "oidc|admin-secret-subject",
        subject_hash: "raw-subject-hash-secret",
      },
      {
        created_at: new Date("2026-11-21T09:00:00.000Z"),
        establishment_id: OTHER_ESTABLISHMENT_ID,
        member_digest:
          "2222222222222222222222222222222222222222222222222222222222222222",
        role: "renave_operator",
        status: "active",
      },
      {
        created_at: new Date("2026-11-21T09:00:00.000Z"),
        establishment_id: ESTABLISHMENT_ID,
        member_digest:
          "2222222222222222222222222222222222222222222222222222222222222222",
        role: "renave_operator",
        status: "active",
      },
    ]);
    const { app } = setup({ tenantActionRunner: runner });

    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/users`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const payload = response.json() as {
      items: {
        active: boolean;
        createdAt: string;
        establishmentIds: string[];
        memberId: string;
        role: string;
        status: string;
      }[];
    };
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toEqual({
      active: true,
      createdAt: "2026-11-20T09:00:00.000Z",
      establishmentIds: [],
      memberId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      role: "tenant_admin",
      status: "active",
    });
    expect(payload.items[1]).toEqual({
      active: true,
      createdAt: "2026-11-21T09:00:00.000Z",
      establishmentIds: [ESTABLISHMENT_ID, OTHER_ESTABLISHMENT_ID],
      memberId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      role: "renave_operator",
      status: "active",
    });
    expect(response.body).not.toContain("subject");
    expect(response.body).not.toContain("subject_hash");
    expect(response.body).not.toContain("admin-secret-subject");
    expect(response.body).not.toContain("raw-subject-hash-secret");
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.user.manage",
        mfa: "required",
        tenantId: TENANT_ID,
      }),
      expect.any(Function),
    );
  });

  it("recusa sessão ausente com 401 e sessão sem MFA com 403", async () => {
    const unauth = runnerWithMemberRows([]);
    const { app: appUnauth } = setup({
      authenticated: false,
      tenantActionRunner: unauth.runner,
    });
    const resUnauth = await appUnauth.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/users`,
    });
    expect(resUnauth.statusCode).toBe(401);
    expect(unauth.runSpy).not.toHaveBeenCalled();

    const noMfa = runnerWithMemberRows([]);
    const { app: appNoMfa } = setup({
      mfaVerified: false,
      tenantActionRunner: noMfa.runner,
    });
    const resNoMfa = await appNoMfa.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/users`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(resNoMfa.statusCode).toBe(403);
    expect(noMfa.runSpy).not.toHaveBeenCalled();
  });

  it("nega acesso (deny-by-default) com 404 para operador/auditor e tenantId inválido", async () => {
    const denied = runnerWithMemberRows([], { deny: true });
    const { app } = setup({ tenantActionRunner: denied.runner });

    const resDenied = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/users`,
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(resDenied.statusCode).toBe(404);
    expect(resDenied.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });

    const resMalformed = await app.inject({
      method: "GET",
      url: "/api/tenants/not-a-uuid/users",
      headers: { cookie: "renave_session=opaque-session" },
    });
    expect(resMalformed.statusCode).toBe(404);
    expect(resMalformed.json()).toEqual({ code: "TENANT_RESOURCE_NOT_FOUND" });
  });
});
