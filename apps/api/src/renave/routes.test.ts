import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type {
  SerproQueryLimiter,
  StockQueryUseCase,
  VehicleLookupUseCase,
} from "./routes.js";
import type { EligibilityUseCase } from "./use-case.js";
import type { RenaveLinkPreflightUseCase } from "./preflight-use-case.js";
import type { RenaveLinkStatusUseCase } from "./link-status-use-case.js";
import type { RenaveReadinessUseCase } from "./readiness-use-case.js";

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
    detranUnavailable: false,
    impediments: [],
    status: "eligible",
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
  const authorizeStockQuery = vi.fn<StockQueryUseCase["authorize"]>(
    async () => undefined,
  );
  const stockQueryExecute = vi.fn<StockQueryUseCase["execute"]>(async () => [
    { estado: "CONFIRMADO", id: 7, placa: "ABC1D23" },
  ]);
  const authorizeVehicleLookup = vi.fn<VehicleLookupUseCase["authorize"]>(
    async () => undefined,
  );
  const vehicleLookupExecute = vi.fn<VehicleLookupUseCase["execute"]>(
    async () => ({
      chassi: "9BWZZZ377VT004251",
      placa: "ABC1D23",
      renavam: "00607701676",
      restricoes: [],
      veiculoAcabado: true,
    }),
  );
  const authorizePreflight = vi.fn<RenaveLinkPreflightUseCase["authorize"]>(
    async () => undefined,
  );
  const preflightExecute = vi.fn<RenaveLinkPreflightUseCase["execute"]>(
    async () => ({ environment: "homologation", status: "ready" }),
  );
  const linkStatusExecute = vi.fn<RenaveLinkStatusUseCase["execute"]>(
    async () => ({ status: "not_started" }),
  );
  const readinessExecute = vi.fn<RenaveReadinessUseCase["execute"]>(
    async () => ({
      certificate: "warning",
      environment: "homologation",
      establishmentContact: "pending",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    }),
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
    renaveReadiness: { execute: readinessExecute },
    serproQueryLimiter: { acquire },
    stockQuery: {
      authorize: authorizeStockQuery,
      execute: stockQueryExecute,
    },
    vehicleLookup: {
      authorize: authorizeVehicleLookup,
      execute: vehicleLookupExecute,
    },
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
    authorizeStockQuery,
    authorizeVehicleLookup,
    execute,
    getSession,
    linkStatusExecute,
    preflightExecute,
    readinessExecute,
    release,
    stockQueryExecute,
    vehicleLookupExecute,
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

async function stockRequest(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
  origin = ORIGIN,
) {
  return await app.inject({
    method: "POST",
    url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/stocks/search`,
    headers: {
      cookie: "renave_session=opaque-session",
      origin,
    },
    payload: body,
  });
}

async function vehicleRequest(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
  origin = ORIGIN,
) {
  return await app.inject({
    method: "POST",
    url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/vehicles/search`,
    headers: {
      cookie: "renave_session=opaque-session",
      origin,
    },
    payload: body,
  });
}

describe("rota autenticada de aptidão", () => {
  it("expõe prontidão local sanitizada sem consultar o SERPRO", async () => {
    const { app, preflightExecute, readinessExecute, stockQueryExecute } =
      setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/renave-readiness?subject=oidc%7Cattacker`,
      headers: { cookie: "renave_session=opaque-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      certificate: "warning",
      environment: "homologation",
      establishmentContact: "pending",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    });
    expect(response.body).not.toMatch(
      /cnpj|cpf|email|profileId|verifier|thumbprint|fingerprint|serial|expires|notAfter|verifiedAt|version|source|keyId|hmac|cipher|\.pem|\/run\/secrets/iu,
    );
    expect(readinessExecute).toHaveBeenCalledWith({
      establishmentId: ESTABLISHMENT_ID,
      subject: "oidc|operator-1",
      tenantId: TENANT_ID,
    });
    expect(preflightExecute).not.toHaveBeenCalled();
    expect(stockQueryExecute).not.toHaveBeenCalled();
  });

  it("recusa prontidão sem sessão antes de executar o caso de uso", async () => {
    const { app, readinessExecute } = setup({ authenticated: false });
    const response = await app.inject({
      method: "GET",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/renave-readiness`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(readinessExecute).not.toHaveBeenCalled();
  });

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
    expect(response.json()).toEqual({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });
    expect(response.body).not.toMatch(
      /autorizacao|boleto|chassi|cpf|debito|motivo|placa|renavam|valor/iu,
    );
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

    for (const attemptedAuthority of [
      { tenantOverride: TENANT_ID },
      { serviceNature: "ite" },
      { jurisdictionUf: "SP" },
    ]) {
      const invalid = await request(app, {
        plate: "ABC1D23",
        crvType: "DIGITAL",
        ...attemptedAuthority,
      });
      expect(invalid.statusCode).toBe(400);
    }

    const queryOverride = await app.inject({
      method: "POST",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/vehicle-eligibility?serviceNature=ite`,
      headers: {
        cookie: "renave_session=opaque-session",
        origin: ORIGIN,
      },
      payload: { plate: "ABC1D23", crvType: "DIGITAL" },
    });
    expect(queryOverride.statusCode).toBe(400);

    const headerOverride = await app.inject({
      method: "POST",
      url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/vehicle-eligibility`,
      headers: {
        cookie: "renave_session=opaque-session",
        origin: ORIGIN,
        "x-renave-service-nature": "ite",
      },
      payload: { plate: "ABC1D23", crvType: "DIGITAL" },
    });
    expect(headerOverride.statusCode).toBe(400);
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

  it.each(["not_started", "pending", "rejected", "deactivated"] as const)(
    "bloqueia vínculo %s antes de adquirir lease ou chamar o SERPRO",
    async () => {
      const { acquire, app, authorizeEligibility, execute, release } = setup();
      authorizeEligibility.mockRejectedValueOnce(
        Object.assign(new Error("estado interno do vínculo"), {
          code: "RENAVE_LINK_NOT_READY",
        }),
      );

      const response = await request(app, {
        plate: "ABC1D23",
        crvType: "DIGITAL",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: "RENAVE_LINK_NOT_READY" });
      expect(response.body).not.toContain("estado interno");
      expect(acquire).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );

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

describe("rota autenticada de consulta pontual de estoque", () => {
  it("normaliza a placa e devolve somente a projeção pública", async () => {
    const { acquire, app, authorizeStockQuery, release, stockQueryExecute } =
      setup();

    const response = await stockRequest(app, { plate: " abc1d23 " });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { estado: "CONFIRMADO", id: 7, placa: "ABC1D23" },
    ]);
    expect(response.body).not.toMatch(
      /cpf|renavam|chassi|crv|nfe|cancelamento|codigoSeguranca/iu,
    );
    const executionInput = expect.objectContaining({
      establishmentId: ESTABLISHMENT_ID,
      plate: "ABC1D23",
      subject: "oidc|operator-1",
      tenantId: TENANT_ID,
    });
    expect(authorizeStockQuery).toHaveBeenCalledWith(executionInput);
    expect(stockQueryExecute).toHaveBeenCalledWith(executionInput);
    expect(acquire).toHaveBeenCalledWith({
      establishmentId: ESTABLISHMENT_ID,
      subject: "oidc|operator-1",
      tenantId: TENANT_ID,
    });
    expect(release).toHaveBeenCalledOnce();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("aplica Origin e recusa corpo extra antes de autorizar", async () => {
    const { acquire, app, authorizeStockQuery, stockQueryExecute } = setup();

    const csrf = await stockRequest(
      app,
      { plate: "ABC1D23" },
      "https://evil.test",
    );
    const extra = await stockRequest(app, {
      includeSensitive: true,
      plate: "ABC1D23",
    });
    const invalid = await stockRequest(app, { plate: "ABC-1234" });

    expect(csrf.statusCode).toBe(403);
    expect(extra.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(authorizeStockQuery).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(stockQueryExecute).not.toHaveBeenCalled();
  });

  it("nega BOLA antes de adquirir lease ou consultar", async () => {
    const { acquire, app, authorizeStockQuery, release, stockQueryExecute } =
      setup();
    authorizeStockQuery.mockRejectedValueOnce(
      Object.assign(new Error("estabelecimento secreto"), {
        code: "AUTHORIZATION_DENIED",
      }),
    );

    const response = await stockRequest(app, { plate: "ABC1D23" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "AUTHORIZATION_DENIED" });
    expect(response.body).not.toContain("estabelecimento secreto");
    expect(authorizeStockQuery).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(stockQueryExecute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("retorna 429 com Retry-After sem executar a consulta", async () => {
    const { acquire, app, authorizeStockQuery, release, stockQueryExecute } =
      setup();
    acquire.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 17,
      scope: "establishment_rate",
    });

    const response = await stockRequest(app, { plate: "ABC1D23" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.json()).toEqual({ code: "RENAVE_QUERY_LIMITED" });
    expect(authorizeStockQuery).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(stockQueryExecute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("libera o lease quando a consulta falha e não expõe a mensagem", async () => {
    const { app, release, stockQueryExecute } = setup();
    stockQueryExecute.mockRejectedValueOnce(
      Object.assign(new Error("placa e CPF não podem vazar"), {
        code: "RENAVE_PROTOCOL_ERROR",
      }),
    );

    const response = await stockRequest(app, { plate: "ABC1D23" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "RENAVE_PROTOCOL_ERROR" });
    expect(response.body).not.toMatch(/placa|cpf/iu);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("rota autenticada de consulta do veículo", () => {
  it("autoriza antes do único lease e devolve DTO com no-store", async () => {
    const {
      acquire,
      app,
      authorizeVehicleLookup,
      release,
      vehicleLookupExecute,
    } = setup();

    const response = await vehicleRequest(app, { plate: " abc1d23 " });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      chassi: "9BWZZZ377VT004251",
      placa: "ABC1D23",
      renavam: "00607701676",
      restricoes: [],
      veiculoAcabado: true,
    });
    expect(authorizeVehicleLookup.mock.invocationCallOrder[0]).toBeLessThan(
      acquire.mock.invocationCallOrder[0]!,
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(vehicleLookupExecute).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("recusa Origin, corpo extra e BOLA antes do limitador", async () => {
    const { acquire, app, authorizeVehicleLookup, vehicleLookupExecute } =
      setup();

    expect(
      (await vehicleRequest(app, { plate: "ABC1D23" }, "https://evil.test"))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await vehicleRequest(app, {
          plate: "ABC1D23",
          stockId: 7,
        })
      ).statusCode,
    ).toBe(400);
    authorizeVehicleLookup.mockRejectedValueOnce(
      Object.assign(new Error("recurso secreto"), {
        code: "AUTHORIZATION_DENIED",
      }),
    );
    expect((await vehicleRequest(app, { plate: "ABC1D23" })).statusCode).toBe(
      403,
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(vehicleLookupExecute).not.toHaveBeenCalled();
  });

  it.each(["not-confirmed", "cancelled", "ambiguous", "upstream-404"])(
    "uniformiza indisponibilidade %s e libera o lease",
    async () => {
      const { app, release, vehicleLookupExecute } = setup();
      vehicleLookupExecute.mockRejectedValueOnce(
        Object.assign(new Error("detalhe interno"), {
          code: "VEHICLE_NOT_AVAILABLE",
        }),
      );

      const response = await vehicleRequest(app, { plate: "ABC1D23" });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "VEHICLE_NOT_AVAILABLE" });
      expect(response.body).not.toContain("detalhe interno");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("traduz falha técnica para 502 e libera o lease", async () => {
    const { app, release, vehicleLookupExecute } = setup();
    vehicleLookupExecute.mockRejectedValueOnce(
      Object.assign(new Error("veículo sigiloso"), {
        code: "RENAVE_PROTOCOL_ERROR",
      }),
    );

    const response = await vehicleRequest(app, { plate: "ABC1D23" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "RENAVE_PROTOCOL_ERROR" });
    expect(response.body).not.toContain("sigiloso");
    expect(release).toHaveBeenCalledOnce();
  });
});
