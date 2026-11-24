import { EvidenceCipher } from "@seu-renave/protected-evidence";
import type { RenaveConnector } from "@seu-renave/renave-connector";
import {
  createEstablishment,
  createPool,
  getCredentialLink,
  grantTenantUserAccess,
  listAuditEvents,
  listCredentialLinkHistory,
  provisionTenant,
  transitionCredentialLink,
  withTenant,
  type CredentialLinkStatus,
  type Establishment,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { PostgresVehicleEligibilityUseCase } from "../renave/use-case.js";
import { PostgresRenaveLinkPreflightUseCase } from "../renave/preflight-use-case.js";
import { PostgresRenaveLinkStatusUseCase } from "../renave/link-status-use-case.js";
import { PostgresStockQueryUseCase } from "../renave/stock-query-use-case.js";
import { createPostgresTenantDirectory } from "../tenant/directory.js";

interface DbUrls {
  admin: string;
  app: string;
  identity: string;
  maintenance: string;
  migrator: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

const urls = inject("dbUrls");
const OPERATOR = "oidc|composition-operator";
const ADMIN = "oidc|composition-admin";
const AUDITOR = "oidc|composition-auditor";
const INTEGRATOR_CNPJ = "12ABC34501DE35";

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let tenant: Tenant;
let operatorStore: Establishment;
let otherStore: Establishment;

interface PreflightScenario {
  store: Establishment;
  tenant: Tenant;
}

interface EvidenceState {
  failure_code: string | null;
  response_ciphertext_present: boolean;
  status: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function createPreflightScenario(
  slug: string,
): Promise<PreflightScenario> {
  const scenarioTenant = await provisionTenant(migratorPool, {
    displayName: `Preflight ${slug}`,
    slug: `preflight-${slug}`,
  });
  const store = await withTenant(appPool, scenarioTenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11222333000181",
      tradeName: `Loja ${slug}`,
    }),
  );
  await withTenant(migratorPool, scenarioTenant.id, (client) =>
    grantTenantUserAccess(client, ADMIN, [{ role: "tenant_admin" }]),
  );
  return { store, tenant: scenarioTenant };
}

function createPreflightUseCase(
  connector: Pick<RenaveConnector, "verifyIdentity">,
): PostgresRenaveLinkPreflightUseCase {
  return new PostgresRenaveLinkPreflightUseCase({
    certificateThumbprintSha256: "e".repeat(64),
    cipher: new EvidenceCipher({
      activeKeyId: "preflight-failure-key",
      keys: new Map([["preflight-failure-key", Buffer.alloc(32, 9)]]),
    }),
    connector: connector as RenaveConnector,
    integratorCnpj: INTEGRATOR_CNPJ,
    pool: appPool,
  });
}

async function prepareCredentialLink(
  scenario: PreflightScenario,
  status: CredentialLinkStatus | "not_started",
): Promise<void> {
  if (status === "not_started") return;
  const path: CredentialLinkStatus[] =
    status === "rejected"
      ? ["pending", "rejected"]
      : status === "deactivated"
        ? ["pending", "confirmed", "enabled", "deactivated"]
        : ["pending", "confirmed", "enabled"];
  for (const nextStatus of path) {
    await withTenant(appPool, scenario.tenant.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: ADMIN,
        establishmentId: scenario.store.id,
        source: "manual",
        status: nextStatus,
      }),
    );
    if (nextStatus === status) return;
  }
}

async function evidenceState(
  scenario: PreflightScenario,
): Promise<EvidenceState[]> {
  const { rows } = await adminPool.query<EvidenceState>(
    `select status, failure_code,
            response_ciphertext is not null as response_ciphertext_present
       from renave.protected_evidence
      where tenant_id = $1
        and establishment_id = $2
        and action = 'renave.identity.verify'
      order by created_at`,
    [scenario.tenant.id, scenario.store.id],
  );
  return rows;
}

async function preflightAuditOutcomes(
  scenario: PreflightScenario,
): Promise<string[]> {
  const audits = await withTenant(appPool, scenario.tenant.id, (client) =>
    listAuditEvents(client),
  );
  return audits
    .filter(({ action }) => action === "renave.identity.verify")
    .map(({ outcome }) => outcome);
}

function preflightInput(scenario: PreflightScenario, traceId: string) {
  return {
    actorIp: "198.51.100.12",
    establishmentId: scenario.store.id,
    subject: ADMIN,
    tenantId: scenario.tenant.id,
    traceId,
  };
}

function eligibilityInput(scenario: PreflightScenario, traceId: string) {
  return {
    actorIp: "198.51.100.10",
    crvType: "DIGITAL" as const,
    establishmentId: scenario.store.id,
    plate: "ABC1D23",
    subject: ADMIN,
    tenantId: scenario.tenant.id,
    traceId,
  };
}

function createEligibilityUseCase(
  getVehicleEligibility: ReturnType<typeof vi.fn>,
): PostgresVehicleEligibilityUseCase {
  return new PostgresVehicleEligibilityUseCase({
    certificateThumbprintSha256: "c".repeat(64),
    cipher: new EvidenceCipher({
      activeKeyId: "eligibility-integration-key",
      keys: new Map([["eligibility-integration-key", Buffer.alloc(32, 7)]]),
    }),
    connector: { getVehicleEligibility } as unknown as RenaveConnector,
    integratorCnpj: INTEGRATOR_CNPJ,
    pool: appPool,
  });
}

function eligibilityResponse(scenario: PreflightScenario) {
  return {
    result: {
      diagnostico: { veiculoApto: true, veiculoComRecall: false },
    },
    verifiedIdentity: {
      confirmedEstablishmentCnpj: scenario.store.cnpj,
      confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
      environment: "homologation" as const,
      establishmentId: scenario.store.id,
      tenantId: scenario.tenant.id,
    },
  };
}

function createStockQueryUseCase(
  scenario: PreflightScenario,
  getStocksByPlate: ReturnType<typeof vi.fn>,
): PostgresStockQueryUseCase {
  return new PostgresStockQueryUseCase({
    certificateThumbprintSha256: "f".repeat(64),
    cipher: new EvidenceCipher({
      activeKeyId: "stock-query-integration-key",
      keys: new Map([["stock-query-integration-key", Buffer.alloc(32, 10)]]),
    }),
    connector: { getStocksByPlate } as unknown as RenaveConnector,
    integratorCnpj: INTEGRATOR_CNPJ,
    pool: appPool,
  });
}

function stockQueryInput(scenario: PreflightScenario, traceId: string) {
  return {
    actorIp: "198.51.100.13",
    establishmentId: scenario.store.id,
    plate: "ABC1D23",
    subject: ADMIN,
    tenantId: scenario.tenant.id,
    traceId,
  };
}

async function stockEvidenceState(scenario: PreflightScenario) {
  const { rows } = await adminPool.query<{
    failure_code: string | null;
    request_clear_absent: boolean;
    response_ciphertext_present: boolean;
    response_clear_absent: boolean;
    status: string;
  }>(
    `select status, failure_code,
            response_ciphertext is not null as response_ciphertext_present,
            position(convert_to('ABC1D23', 'UTF8') in request_ciphertext) = 0
              as request_clear_absent,
            response_ciphertext is null
              or position(convert_to('12345678901', 'UTF8') in response_ciphertext) = 0
              as response_clear_absent
       from renave.protected_evidence
      where tenant_id = $1
        and establishment_id = $2
        and action = 'renave.stock.read'
      order by created_at`,
    [scenario.tenant.id, scenario.store.id],
  );
  return rows;
}

async function stockAuditOutcomes(
  scenario: PreflightScenario,
): Promise<string[]> {
  const audits = await withTenant(appPool, scenario.tenant.id, (client) =>
    listAuditEvents(client),
  );
  return audits
    .filter(({ action }) => action === "renave.stock.read")
    .map(({ outcome }) => outcome);
}

function successfulStockConnector(scenario: PreflightScenario) {
  return vi.fn(async () => ({
    result: {
      evidence: [
        {
          cancelamentoEstoque: { motivo: "somente evidência" },
          codigoSegurancaCrv: "12345678901",
          entradaEstoque: { cpfOperadorResponsavel: "12345678901" },
          estado: "CONFIRMADO" as const,
          id: 71,
          numeroCrv: "123456789012",
          placa: "ABC1D23",
          renavam: "00607701676",
          tipoCrv: "DIGITAL" as const,
        },
      ],
      publicResult: [
        { estado: "CONFIRMADO" as const, id: 71, placa: "ABC1D23" },
      ],
    },
    verifiedIdentity: {
      confirmedEstablishmentCnpj: scenario.store.cnpj,
      confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
      environment: "homologation" as const,
      establishmentId: scenario.store.id,
      tenantId: scenario.tenant.id,
    },
  }));
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, {
    application_name: "api-composition-test",
    max: 6,
  });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenant = await provisionTenant(migratorPool, {
    displayName: "Composição API",
    slug: "api-composition",
  });
  const stores = await withTenant(appPool, tenant.id, async (client) => {
    const stores = [
      await createEstablishment(client, {
        cnpj: "11222333000181",
        tradeName: "Loja Operador",
      }),
      await createEstablishment(client, {
        cnpj: "69418503000188",
        tradeName: "Loja Administrador",
      }),
      await createEstablishment(client, {
        cnpj: "85106037000585",
        tradeName: "Loja Inativa",
      }),
    ];
    await client.query(
      "update renave.establishment set status = 'inactive' where id = $1",
      [stores[2]!.id],
    );
    return stores;
  });
  operatorStore = stores[0]!;
  otherStore = stores[1]!;

  await withTenant(migratorPool, tenant.id, async (client) => {
    await grantTenantUserAccess(client, OPERATOR, [
      {
        establishmentIds: [operatorStore.id],
        role: "renave_operator",
      },
    ]);
    await grantTenantUserAccess(client, ADMIN, [{ role: "tenant_admin" }]);
    await grantTenantUserAccess(client, AUDITOR, [
      { role: "compliance_auditor" },
    ]);
  });
});

afterAll(async () => {
  await Promise.all([adminPool?.end(), appPool?.end(), migratorPool?.end()]);
});

describe("composição PostgreSQL real da API", () => {
  it("filtra lojas por RBAC e usa suspensão do tenant como kill switch", async () => {
    const directory = createPostgresTenantDirectory(appPool);

    await expect(
      directory.listEstablishments({ subject: AUDITOR, tenantId: tenant.id }),
    ).resolves.toEqual([]);
    await expect(
      directory.listEstablishments({ subject: OPERATOR, tenantId: tenant.id }),
    ).resolves.toEqual([
      { id: operatorStore.id, tradeName: operatorStore.tradeName },
    ]);
    await expect(
      directory.listEstablishments({ subject: ADMIN, tenantId: tenant.id }),
    ).resolves.toEqual([
      { id: operatorStore.id, tradeName: operatorStore.tradeName },
      { id: otherStore.id, tradeName: otherStore.tradeName },
    ]);

    await withTenant(migratorPool, tenant.id, (client) =>
      client.query(
        "update renave.tenant set status = 'suspended' where id = $1",
        [tenant.id],
      ),
    );
    try {
      await expect(directory.discover(ADMIN)).resolves.toEqual([]);
      await expect(
        directory.listEstablishments({ subject: ADMIN, tenantId: tenant.id }),
      ).resolves.toBeNull();
    } finally {
      await withTenant(migratorPool, tenant.id, (client) =>
        client.query(
          "update renave.tenant set status = 'active' where id = $1",
          [tenant.id],
        ),
      );
    }
  });

  it("persiste evidência/auditoria sem manter transação durante o conector", async () => {
    const scenario = await createPreflightScenario("eligibility-transaction");
    await prepareCredentialLink(scenario, "confirmed");
    const enteredConnector = deferred<void>();
    const releaseConnector = deferred<void>();
    const connectorCall = vi.fn(async () => {
      enteredConnector.resolve(undefined);
      await releaseConnector.promise;
      return eligibilityResponse(scenario);
    });
    const useCase = createEligibilityUseCase(connectorCall);

    const execution = useCase.execute(
      eligibilityInput(scenario, "composition-trace"),
    );
    await enteredConnector.promise;

    const activity = await adminPool.query<{ open_transactions: string }>(
      `select pg_catalog.count(*)::text as open_transactions
         from pg_catalog.pg_stat_activity
        where datname = pg_catalog.current_database()
          and application_name = 'api-composition-test'
          and xact_start is not null`,
    );
    expect(activity.rows[0]?.open_transactions).toBe("0");

    releaseConnector.resolve(undefined);
    await expect(execution).resolves.toEqual({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });
    expect(connectorCall).toHaveBeenCalledOnce();

    const audits = await withTenant(appPool, scenario.tenant.id, (client) =>
      listAuditEvents(client),
    );
    expect(audits.map(({ outcome }) => outcome)).toEqual([
      "attempted",
      "succeeded",
    ]);
    expect(JSON.stringify(audits)).not.toContain("ABC1D23");

    const evidence = await adminPool.query<{
      count: string;
      response_ciphertext_present: boolean;
      status: string;
    }>(
      `select pg_catalog.count(*)::text as count,
              pg_catalog.bool_and(response_ciphertext is not null) as response_ciphertext_present,
              pg_catalog.min(status) as status
         from renave.protected_evidence
        where tenant_id = $1 and establishment_id = $2`,
      [scenario.tenant.id, scenario.store.id],
    );
    expect(evidence.rows[0]).toEqual({
      count: "1",
      response_ciphertext_present: true,
      status: "completed",
    });
  });

  it.each([
    ["not_started", false],
    ["pending", false],
    ["rejected", false],
    ["deactivated", false],
    ["confirmed", true],
    ["enabled", true],
  ] as const)(
    "aplica vínculo %s antes de consultar aptidão",
    async (status, allowed) => {
      const scenario = await createPreflightScenario(
        `eligibility-link-${status.replaceAll("_", "-")}`,
      );
      await prepareCredentialLink(scenario, status);
      const connectorCall = vi.fn(async () => eligibilityResponse(scenario));
      const useCase = createEligibilityUseCase(connectorCall);
      const execution = useCase.execute(
        eligibilityInput(scenario, `eligibility-link-${status}`),
      );

      if (allowed) {
        await expect(execution).resolves.toEqual({
          detranUnavailable: false,
          impediments: [],
          status: "eligible",
        });
        expect(connectorCall).toHaveBeenCalledOnce();
      } else {
        await expect(execution).rejects.toMatchObject({
          code: "RENAVE_LINK_NOT_READY",
        });
        expect(connectorCall).not.toHaveBeenCalled();
      }
    },
  );

  it("confirma o vínculo após preflight sem expor o subject no histórico", async () => {
    const connector = {
      verifyIdentity: vi.fn(async () => ({
        confirmedEstablishmentCnpj: operatorStore.cnpj,
        confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
        environment: "homologation" as const,
        establishmentId: operatorStore.id,
        tenantId: tenant.id,
      })),
    } as unknown as RenaveConnector;
    const useCase = new PostgresRenaveLinkPreflightUseCase({
      certificateThumbprintSha256: "d".repeat(64),
      cipher: new EvidenceCipher({
        activeKeyId: "preflight-key",
        keys: new Map([["preflight-key", Buffer.alloc(32, 8)]]),
      }),
      connector,
      integratorCnpj: INTEGRATOR_CNPJ,
      pool: appPool,
    });

    await expect(
      useCase.execute({
        actorIp: "198.51.100.11",
        establishmentId: operatorStore.id,
        subject: OPERATOR,
        tenantId: tenant.id,
        traceId: "preflight-composition-trace",
      }),
    ).resolves.toEqual({
      environment: "homologation",
      status: "ready",
    });

    const { link, history } = await withTenant(
      appPool,
      tenant.id,
      async (client) => ({
        history: await listCredentialLinkHistory(client, operatorStore.id),
        link: await getCredentialLink(client, operatorStore.id),
      }),
    );
    expect(link).toMatchObject({ status: "confirmed", version: "2" });
    expect(history.map(({ status }) => status)).toEqual([
      "pending",
      "confirmed",
    ]);
    expect(JSON.stringify(history)).not.toContain(OPERATOR);

    const statusUseCase = new PostgresRenaveLinkStatusUseCase(appPool);
    await expect(
      statusUseCase.execute({
        establishmentId: operatorStore.id,
        subject: OPERATOR,
        tenantId: tenant.id,
      }),
    ).resolves.toEqual({ status: "confirmed" });
    await expect(
      statusUseCase.execute({
        establishmentId: operatorStore.id,
        subject: AUDITOR,
        tenantId: tenant.id,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it.each([
    {
      expectedHistory: ["pending", "rejected"],
      expectedStatus: "rejected",
      initialStatus: "not_started",
      slug: "mismatch-new",
    },
    {
      expectedHistory: ["pending", "rejected"],
      expectedStatus: "rejected",
      initialStatus: "pending",
      slug: "mismatch-pending",
    },
    {
      expectedHistory: ["pending", "confirmed", "rejected"],
      expectedStatus: "rejected",
      initialStatus: "confirmed",
      slug: "mismatch-confirmed",
    },
    {
      expectedHistory: ["pending", "confirmed", "enabled", "deactivated"],
      expectedStatus: "deactivated",
      initialStatus: "enabled",
      slug: "mismatch-enabled",
    },
  ] as const)(
    "materializa RENAVE_IDENTITY_MISMATCH de $initialStatus para $expectedStatus",
    async ({ expectedHistory, expectedStatus, initialStatus, slug }) => {
      const scenario = await createPreflightScenario(slug);
      await prepareCredentialLink(scenario, initialStatus);
      const mismatch = Object.assign(new Error("Identidade divergente"), {
        code: "RENAVE_IDENTITY_MISMATCH",
      });
      const useCase = createPreflightUseCase({
        verifyIdentity: vi.fn(async () => Promise.reject(mismatch)),
      });

      await expect(
        useCase.execute(preflightInput(scenario, `${slug}-trace`)),
      ).rejects.toBe(mismatch);

      const { history, link } = await withTenant(
        appPool,
        scenario.tenant.id,
        async (client) => ({
          history: await listCredentialLinkHistory(client, scenario.store.id),
          link: await getCredentialLink(client, scenario.store.id),
        }),
      );
      expect(link?.status).toBe(expectedStatus);
      expect(history.map(({ status }) => status)).toEqual(expectedHistory);
      expect(await evidenceState(scenario)).toEqual([
        {
          failure_code: "RENAVE_IDENTITY_MISMATCH",
          response_ciphertext_present: false,
          status: "failed",
        },
      ]);
      expect(await preflightAuditOutcomes(scenario)).toEqual([
        "attempted",
        "rejected",
      ]);
    },
  );

  it("preserva vínculo confirmado em falha transitória e registra a rejeição operacional", async () => {
    const scenario = await createPreflightScenario("transient-confirmed");
    await prepareCredentialLink(scenario, "confirmed");
    const linkBefore = await withTenant(appPool, scenario.tenant.id, (client) =>
      getCredentialLink(client, scenario.store.id),
    );
    const transient = Object.assign(new Error("Timeout no SERPRO"), {
      code: "RENAVE_UPSTREAM_TIMEOUT",
    });
    const useCase = createPreflightUseCase({
      verifyIdentity: vi.fn(async () => Promise.reject(transient)),
    });

    await expect(
      useCase.execute(preflightInput(scenario, "transient-confirmed-trace")),
    ).rejects.toBe(transient);

    const { history, link } = await withTenant(
      appPool,
      scenario.tenant.id,
      async (client) => ({
        history: await listCredentialLinkHistory(client, scenario.store.id),
        link: await getCredentialLink(client, scenario.store.id),
      }),
    );
    expect(link).toMatchObject({
      status: linkBefore?.status,
      version: linkBefore?.version,
    });
    expect(history.map(({ status }) => status)).toEqual([
      "pending",
      "confirmed",
    ]);
    expect(await evidenceState(scenario)).toEqual([
      {
        failure_code: "RENAVE_UPSTREAM_TIMEOUT",
        response_ciphertext_present: false,
        status: "failed",
      },
    ]);
    expect(await preflightAuditOutcomes(scenario)).toEqual([
      "attempted",
      "rejected",
    ]);
  });

  it("reverte toda a finalização de sucesso quando a transição local falha", async () => {
    const scenario = await createPreflightScenario("atomic-rollback");
    const functionName = "renave.test_fail_preflight_link_history";
    const triggerName = "test_fail_preflight_link_history";
    await adminPool.query(
      `create function ${functionName}()
       returns trigger
       language plpgsql
       as $$
       begin
         raise exception 'falha local induzida no histórico do vínculo';
       end
       $$`,
    );
    await adminPool.query(
      `create trigger ${triggerName}
       before insert on renave.credential_link_history
       for each row execute function ${functionName}()`,
    );

    try {
      const useCase = createPreflightUseCase({
        verifyIdentity: vi.fn(async () => ({
          confirmedEstablishmentCnpj: scenario.store.cnpj,
          confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
          environment: "homologation" as const,
          establishmentId: scenario.store.id,
          tenantId: scenario.tenant.id,
        })),
      });

      await expect(
        useCase.execute(preflightInput(scenario, "atomic-rollback-trace")),
      ).rejects.toMatchObject({ code: "P0001" });

      await expect(
        withTenant(appPool, scenario.tenant.id, (client) =>
          getCredentialLink(client, scenario.store.id),
        ),
      ).resolves.toBeNull();
      expect(await evidenceState(scenario)).toEqual([
        {
          failure_code: "P0001",
          response_ciphertext_present: false,
          status: "failed",
        },
      ]);
      expect(await preflightAuditOutcomes(scenario)).toEqual([
        "attempted",
        "rejected",
      ]);
    } finally {
      await adminPool.query(
        `drop trigger if exists ${triggerName} on renave.credential_link_history`,
      );
      await adminPool.query(`drop function if exists ${functionName}()`);
    }
  });

  it.each(["not_started", "pending"] as const)(
    "bloqueia consulta de estoque com vínculo %s antes do conector",
    async (status) => {
      const scenario = await createPreflightScenario(
        `stock-block-${status.replaceAll("_", "-")}`,
      );
      await prepareCredentialLink(scenario, status);
      const getStocksByPlate = successfulStockConnector(scenario);
      const useCase = createStockQueryUseCase(scenario, getStocksByPlate);

      await expect(
        useCase.execute(stockQueryInput(scenario, `stock-block-${status}`)),
      ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
      expect(getStocksByPlate).not.toHaveBeenCalled();
      expect(await stockEvidenceState(scenario)).toEqual([]);
      expect(await stockAuditOutcomes(scenario)).toEqual([]);
    },
  );

  it("consulta estoque com vínculo confirmado e mantém dados sensíveis somente cifrados", async () => {
    const scenario = await createPreflightScenario("stock-success");
    await prepareCredentialLink(scenario, "confirmed");
    const getStocksByPlate = successfulStockConnector(scenario);
    const useCase = createStockQueryUseCase(scenario, getStocksByPlate);

    await expect(
      useCase.execute(stockQueryInput(scenario, "stock-success-trace")),
    ).resolves.toEqual([{ estado: "CONFIRMADO", id: 71, placa: "ABC1D23" }]);
    expect(getStocksByPlate).toHaveBeenCalledOnce();
    expect(await stockEvidenceState(scenario)).toEqual([
      {
        failure_code: null,
        request_clear_absent: true,
        response_ciphertext_present: true,
        response_clear_absent: true,
        status: "completed",
      },
    ]);
    expect(await stockAuditOutcomes(scenario)).toEqual([
      "attempted",
      "succeeded",
    ]);
  });

  it("finaliza evidência e auditoria como rejeitadas quando o conector falha", async () => {
    const scenario = await createPreflightScenario("stock-failure");
    await prepareCredentialLink(scenario, "confirmed");
    const connectorError = Object.assign(new Error("timeout"), {
      code: "RENAVE_HTTP_ERROR",
    });
    const getStocksByPlate = vi.fn(async () => Promise.reject(connectorError));
    const useCase = createStockQueryUseCase(scenario, getStocksByPlate);

    await expect(
      useCase.execute(stockQueryInput(scenario, "stock-failure-trace")),
    ).rejects.toBe(connectorError);
    expect(await stockEvidenceState(scenario)).toEqual([
      {
        failure_code: "RENAVE_HTTP_ERROR",
        request_clear_absent: true,
        response_ciphertext_present: false,
        response_clear_absent: true,
        status: "failed",
      },
    ]);
    expect(await stockAuditOutcomes(scenario)).toEqual([
      "attempted",
      "rejected",
    ]);
  });

  it("reverte evidência concluída quando a auditoria final falha", async () => {
    const scenario = await createPreflightScenario("stock-atomic-rollback");
    await prepareCredentialLink(scenario, "confirmed");
    const functionName = "renave.test_fail_stock_success_audit";
    const triggerName = "test_fail_stock_success_audit";
    await adminPool.query(
      `create function ${functionName}()
       returns trigger
       language plpgsql
       as $$
       begin
         if new.action = 'renave.stock.read' and new.outcome = 'succeeded' then
           raise exception 'falha local induzida na auditoria final';
         end if;
         return new;
       end
       $$`,
    );
    await adminPool.query(
      `create trigger ${triggerName}
       before insert on renave.audit_event
       for each row execute function ${functionName}()`,
    );

    try {
      const useCase = createStockQueryUseCase(
        scenario,
        successfulStockConnector(scenario),
      );
      await expect(
        useCase.execute(stockQueryInput(scenario, "stock-rollback-trace")),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await stockEvidenceState(scenario)).toEqual([
        {
          failure_code: null,
          request_clear_absent: true,
          response_ciphertext_present: false,
          response_clear_absent: true,
          status: "pending",
        },
      ]);
      expect(await stockAuditOutcomes(scenario)).toEqual(["attempted"]);
    } finally {
      await adminPool.query(
        `drop trigger if exists ${triggerName} on renave.audit_event`,
      );
      await adminPool.query(`drop function if exists ${functionName}()`);
    }
  });
});
