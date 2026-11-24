import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
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
