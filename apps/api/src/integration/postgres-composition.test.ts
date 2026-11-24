import { createHash, randomUUID } from "node:crypto";

import type { IdentityService } from "@seu-renave/identity";
import {
  EvidenceCipher,
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
} from "@seu-renave/protected-evidence";
import {
  RenaveHttpError,
  RenaveQueryConnector,
  RenaveVehicleLookupConnector,
  restorePreparedRenaveMutation,
  type RenaveConnector,
  type RenaveStockRecord,
  type RenaveVehicle,
} from "@seu-renave/renave-connector";
import {
  createEstablishment,
  createPool,
  computeCnpjCheckDigits,
  getCredentialLink,
  getCredentialServiceScope,
  grantTenantUserAccess,
  listAuditEvents,
  listCredentialLinkHistory,
  PostgresTenantAdminRateLimiter,
  provisionTenant,
  transitionCredentialLink,
  transitionCredentialServiceScope,
  transitionEstablishmentRegulatoryJurisdiction,
  withTenant,
  type CreateOperationInput,
  type CredentialLinkStatus,
  type CredentialServiceNature,
  type Establishment,
  type TenantClient,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { createTenantActionRunner } from "../auth/request-access-guard.js";
import { loadConfig } from "../config.js";
import { PostgresVehicleEligibilityUseCase } from "../renave/use-case.js";
import { buildCreateOperationInput } from "../renave/operation-request-builder.js";
import { PostgresRenaveLinkPreflightUseCase } from "../renave/preflight-use-case.js";
import { PostgresRenaveLinkStatusUseCase } from "../renave/link-status-use-case.js";
import { PostgresStockQueryUseCase } from "../renave/stock-query-use-case.js";
import { PostgresVehicleLookupUseCase } from "../renave/vehicle-lookup-use-case.js";
import { createPostgresTenantDirectory } from "../tenant/directory.js";
import { PostgresTenantEstablishmentAdministration } from "../tenant/postgres-administration.js";

interface DbUrls {
  admin: string;
  app: string;
  credentialScopeProvisioner: string;
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
let credentialScopeProvisionerPool: Pool;
let tenant: Tenant;
let operatorStore: Establishment;
let otherStore: Establishment;

async function createLegacyOperationForTest(
  client: TenantClient,
  operation: CreateOperationInput,
): Promise<string> {
  const { rows } = await client.query<{ operation_id: string }>(
    `select operation_id
       from renave.create_operation_with_outbox(
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22, $23
       )`,
    [
      operation.operationId,
      operation.establishmentId,
      operation.kind,
      operation.mutationFamily,
      operation.idempotencyKeyDigest,
      operation.vehicleKeyDigest,
      operation.requestSha256,
      operation.requestCiphertext.byteLength,
      operation.requestSchemaVersion,
      operation.requestKeyId,
      operation.requestNonce,
      operation.requestAuthTag,
      operation.requestCiphertext,
      operation.actorSubjectHash,
      operation.correlationId,
      operation.reconciliationProjectionKind,
      operation.reconciliationProjectionSchemaVersion,
      operation.reconciliationProjectionGeneration,
      operation.reconciliationProjectionByteLength,
      operation.reconciliationProjectionKeyId,
      operation.reconciliationProjectionNonce,
      operation.reconciliationProjectionAuthTag,
      operation.reconciliationProjectionCiphertext,
    ],
  );
  const operationId = rows[0]?.operation_id;
  if (!operationId) throw new Error("Fixture de operação legada não criada.");
  return operationId;
}

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
    if (nextStatus === status) {
      if (status === "confirmed" || status === "enabled") {
        await enableEstablishmentServiceScope(scenario);
      }
      return;
    }
  }
}

async function enableEstablishmentServiceScope(
  scenario: PreflightScenario,
  options: {
    expiresAt?: Date;
    serviceNature?: CredentialServiceNature;
    validFrom?: Date;
  } = {},
): Promise<void> {
  const now = Date.now();
  const validFrom = options.validFrom ?? new Date(now - 60_000);
  const expiresAt = options.expiresAt ?? new Date(now + 86_400_000);
  await withTenant(
    credentialScopeProvisionerPool,
    scenario.tenant.id,
    async (client) => {
      await transitionEstablishmentRegulatoryJurisdiction(client, {
        changedByDigest: createHash("sha256")
          .update(`jurisdiction-actor:${scenario.tenant.id}`)
          .digest(),
        decisionTicketDigest: createHash("sha256")
          .update(`jurisdiction-ticket:${scenario.store.id}`)
          .digest(),
        establishmentId: scenario.store.id,
        evidenceDigest: createHash("sha256")
          .update(`jurisdiction-evidence:${scenario.store.id}`)
          .digest(),
        expiresAt,
        jurisdictionUf: "PA",
        status: "verified",
        validFrom,
      });
      await transitionCredentialServiceScope(client, {
        changedByDigest: createHash("sha256")
          .update(`scope-actor:${scenario.tenant.id}`)
          .digest(),
        decisionTicketDigest: createHash("sha256")
          .update(`scope-ticket:${scenario.store.id}`)
          .digest(),
        establishmentId: scenario.store.id,
        evidenceDigest: createHash("sha256")
          .update(`scope-evidence:${scenario.store.id}`)
          .digest(),
        expiresAt,
        jurisdictionUf: "PA",
        serviceNature: options.serviceNature ?? "establishment",
        status: "enabled",
        validFrom,
      });
    },
  );
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

const VEHICLE_PLATE = "ABC1D23";
const VEHICLE_RENAVAM = "00607701676";
const VEHICLE_CHASSIS = "9BWZZZ377VT004251";

function vehicleLookupInput(
  scenario: PreflightScenario,
  traceId: string,
  subject = ADMIN,
) {
  return {
    actorIp: "198.51.100.14",
    establishmentId: scenario.store.id,
    plate: VEHICLE_PLATE,
    subject,
    tenantId: scenario.tenant.id,
    traceId,
  };
}

function confirmedVehicleStock(
  overrides: Partial<RenaveStockRecord> = {},
): RenaveStockRecord {
  return {
    codigoSegurancaCrv: "12345678901",
    estado: "CONFIRMADO",
    id: 81,
    numeroCrv: "123456789012",
    placa: VEHICLE_PLATE,
    renavam: VEHICLE_RENAVAM,
    tipoCrv: "DIGITAL",
    ...overrides,
  };
}

function vehicleLookupHarness(
  scenario: PreflightScenario,
  options: {
    stockRecords?: readonly RenaveStockRecord[];
    vehicle?: RenaveVehicle;
    vehicleError?: Error;
  } = {},
) {
  const getAuthenticatedClient = vi.fn(async () => ({
    cnpj: scenario.store.cnpj,
    cnpjIntegradora: INTEGRATOR_CNPJ,
  }));
  const findStocksByPlate = vi.fn(async () =>
    Array.from(options.stockRecords ?? [confirmedVehicleStock()]),
  );
  const getVehicleByPlate = vi.fn(async () => {
    if (options.vehicleError) throw options.vehicleError;
    return (
      options.vehicle ?? {
        chassi: VEHICLE_CHASSIS,
        placa: VEHICLE_PLATE,
        renavam: VEHICLE_RENAVAM,
        restricoes: [{ codigoTipo: "01", tipo: "Administrativa" }],
        veiculoAcabado: true,
      }
    );
  });
  const stockConnector = new RenaveQueryConnector({
    environment: "homologation",
    findStocksByPlate,
    getAuthenticatedClient,
    getVehicleEligibility: vi.fn(async () => {
      throw new Error("capacidade não utilizada no ensaio de veículo");
    }),
  });
  const vehicleConnector = new RenaveVehicleLookupConnector({
    environment: "homologation",
    getAuthenticatedClient,
    getVehicleByPlate,
  });
  const useCase = new PostgresVehicleLookupUseCase({
    certificateThumbprintSha256: "a".repeat(64),
    cipher: new EvidenceCipher({
      activeKeyId: "vehicle-lookup-integration-key",
      keys: new Map([
        ["vehicle-lookup-integration-key", Buffer.alloc(32, 0x5a)],
      ]),
    }),
    integratorCnpj: INTEGRATOR_CNPJ,
    pool: appPool,
    stockConnector,
    vehicleConnector,
  });
  return {
    findStocksByPlate,
    getAuthenticatedClient,
    getVehicleByPlate,
    useCase,
  };
}

async function vehicleEvidenceState(scenario: PreflightScenario) {
  const { rows } = await adminPool.query<{
    failure_code: string | null;
    request_clear_absent: boolean;
    response_ciphertext_present: boolean;
    response_clear_absent: boolean;
    status: string;
  }>(
    `select status, failure_code,
            response_ciphertext is not null as response_ciphertext_present,
            position(convert_to($3, 'UTF8') in request_ciphertext) = 0
              as request_clear_absent,
            response_ciphertext is null
              or (
                position(convert_to($4, 'UTF8') in response_ciphertext) = 0
                and position(convert_to($5, 'UTF8') in response_ciphertext) = 0
                and position(convert_to($6, 'UTF8') in response_ciphertext) = 0
              ) as response_clear_absent
       from renave.protected_evidence
      where tenant_id = $1
        and establishment_id = $2
        and action = 'renave.vehicle.read'
      order by created_at`,
    [
      scenario.tenant.id,
      scenario.store.id,
      VEHICLE_PLATE,
      VEHICLE_RENAVAM,
      VEHICLE_CHASSIS,
      "Administrativa",
    ],
  );
  return rows;
}

async function vehicleAuditOutcomes(
  scenario: PreflightScenario,
): Promise<string[]> {
  const audits = await withTenant(appPool, scenario.tenant.id, (client) =>
    listAuditEvents(client),
  );
  return audits
    .filter(({ action }) => action === "renave.vehicle.read")
    .map(({ outcome }) => outcome);
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, {
    application_name: "api-composition-test",
    max: 6,
  });
  migratorPool = createPool(urls.migrator, { max: 2 });
  credentialScopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 2,
  });
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
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    migratorPool?.end(),
    credentialScopeProvisionerPool?.end(),
  ]);
});

describe("composição PostgreSQL real da API", () => {
  it("filtra lojas por RBAC e usa suspensão do tenant como kill switch", async () => {
    const directory = createPostgresTenantDirectory(appPool);

    await expect(
      directory.listEstablishments({ subject: AUDITOR, tenantId: tenant.id }),
    ).resolves.toEqual({
      canManageEstablishments: false,
      establishments: [],
    });
    await expect(
      directory.listEstablishments({ subject: OPERATOR, tenantId: tenant.id }),
    ).resolves.toEqual({
      canManageEstablishments: false,
      establishments: [
        { id: operatorStore.id, tradeName: operatorStore.tradeName },
      ],
    });
    await expect(
      directory.listEstablishments({ subject: ADMIN, tenantId: tenant.id }),
    ).resolves.toEqual({
      canManageEstablishments: true,
      establishments: [
        { id: operatorStore.id, tradeName: operatorStore.tradeName },
        { id: otherStore.id, tradeName: otherStore.tradeName },
      ],
    });

    await expect(
      directory.getEstablishment({
        establishmentId: operatorStore.id,
        subject: OPERATOR,
        tenantId: tenant.id,
      }),
    ).resolves.toEqual({
      establishment: {
        id: operatorStore.id,
        tradeName: operatorStore.tradeName,
      },
      renaveLink: { status: "not_started" },
    });
    await expect(
      directory.getEstablishment({
        establishmentId: otherStore.id,
        subject: OPERATOR,
        tenantId: tenant.id,
      }),
    ).resolves.toBeNull();
    await expect(
      directory.getEstablishment({
        establishmentId: operatorStore.id,
        subject: AUDITOR,
        tenantId: tenant.id,
      }),
    ).resolves.toBeNull();

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

  it("compõe HTTP, sessão, RBAC e RLS para coleção e detalhe", async () => {
    const directory = createPostgresTenantDirectory(appPool);
    const identity = {
      config: { publicOrigin: "https://app.test" },
      getSession: vi.fn(async () => ({
        expiresAt: Date.now() + 60_000,
        mfaVerified: true,
        roles: ["idp-role-must-not-authorize"],
        subject: ADMIN,
      })),
    } as unknown as IdentityService;
    const app = buildApp({
      config: loadConfig(),
      identity,
      logger: false,
      tenantActionRunner: createTenantActionRunner(appPool),
      tenantDirectory: directory,
    });
    try {
      const collection = await app.inject({
        method: "GET",
        url: `/api/tenants/${tenant.id}/establishments?role=tenant_admin`,
        headers: { cookie: "renave_session=opaque-session" },
      });
      expect(collection.statusCode).toBe(200);
      expect(collection.json()).toEqual({
        capabilities: { establishmentManagement: "available" },
        establishments: [
          { id: operatorStore.id, tradeName: operatorStore.tradeName },
          { id: otherStore.id, tradeName: otherStore.tradeName },
        ],
      });
      expect(collection.body).not.toContain("tenant_admin");
      expect(collection.body).not.toContain(operatorStore.cnpj);

      const linkQueue = await app.inject({
        method: "GET",
        url: `/api/tenants/${tenant.id}/renave-link-queue`,
        headers: { cookie: "renave_session=opaque-session" },
      });
      expect(linkQueue.statusCode).toBe(200);
      const linkQueueBody = linkQueue.json<{
        items: Array<{
          establishment: { id: string; tradeName: string };
          renaveLink: { status: string };
        }>;
        truncated: boolean;
      }>();
      expect(linkQueueBody.items).toHaveLength(2);
      expect(linkQueueBody.truncated).toBe(false);
      expect(linkQueueBody.items).toEqual(
        expect.arrayContaining([
          {
            establishment: {
              id: operatorStore.id,
              tradeName: operatorStore.tradeName,
            },
            renaveLink: { status: "not_started" },
          },
          {
            establishment: {
              id: otherStore.id,
              tradeName: otherStore.tradeName,
            },
            renaveLink: { status: "not_started" },
          },
        ]),
      );
      expect(linkQueue.headers["cache-control"]).toBe("no-store");
      expect(linkQueue.body).not.toContain(operatorStore.cnpj);
      expect(linkQueue.body).not.toContain(tenant.id);

      const detail = await app.inject({
        method: "GET",
        url: `/api/tenants/${tenant.id}/establishments/${operatorStore.id}`,
        headers: { cookie: "renave_session=opaque-session" },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({
        establishment: {
          id: operatorStore.id,
          tradeName: operatorStore.tradeName,
        },
        renaveLink: { status: "not_started" },
      });
      expect(detail.headers["cache-control"]).toBe("no-store");
      expect(detail.body).not.toContain(operatorStore.cnpj);
      expect(detail.body).not.toContain(tenant.id);
    } finally {
      await app.close();
    }
  });

  it("compõe POST, replay, GET Location, auditoria e ausência de vínculo", async () => {
    const hmacKey = Buffer.alloc(32, 0x4a);
    const administration = new PostgresTenantEstablishmentAdministration(
      hmacKey,
    );
    const limiter = new PostgresTenantAdminRateLimiter(appPool, hmacKey);
    hmacKey.fill(0);
    const identity = {
      config: { publicOrigin: "https://app.test" },
      getSession: vi.fn(async () => ({
        expiresAt: Date.now() + 60_000,
        mfaVerified: true,
        roles: ["idp-role-must-not-authorize"],
        subject: ADMIN,
      })),
    } as unknown as IdentityService;
    const app = buildApp({
      config: loadConfig(),
      identity,
      logger: false,
      tenantActionRunner: createTenantActionRunner(appPool),
      tenantDirectory: createPostgresTenantDirectory(appPool),
      tenantEstablishmentAdministration: administration,
      tenantMutationRateLimiter: {
        acquire: (input) => limiter.consume(input),
      },
    });
    const base = "98ADMIN00001";
    const cnpj = `${base}${computeCnpjCheckDigits(base)}`;
    const idempotencyKey = randomUUID();
    try {
      const create = () =>
        app.inject({
          method: "POST",
          url: `/api/tenants/${tenant.id}/establishments`,
          headers: {
            cookie: "renave_session=opaque-session",
            "idempotency-key": idempotencyKey,
            origin: "https://app.test",
          },
          payload: { cnpj, tradeName: "Loja Composta" },
        });
      const created = await create();
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain(cnpj);
      const createdBody = created.json<{
        establishment: { id: string; tradeName: string };
        renaveLink: { status: string };
      }>();
      expect(createdBody).toMatchObject({
        establishment: { tradeName: "Loja Composta" },
        renaveLink: { status: "not_started" },
      });
      expect(created.headers.location).toBe(
        `/api/tenants/${tenant.id}/establishments/${createdBody.establishment.id}`,
      );

      const replayed = await create();
      expect(replayed.statusCode).toBe(201);
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(replayed.json()).toEqual(createdBody);

      const detail = await app.inject({
        method: "GET",
        url: created.headers.location!,
        headers: { cookie: "renave_session=opaque-session" },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(createdBody);

      const persisted = await withTenant(
        appPool,
        tenant.id,
        async (client) => ({
          audits: (await listAuditEvents(client)).filter(
            (event) =>
              event.action === "tenant.establishment.create" &&
              event.establishmentId === createdBody.establishment.id,
          ),
          link: await getCredentialLink(client, createdBody.establishment.id),
        }),
      );
      expect(persisted.audits).toHaveLength(1);
      expect(persisted.link).toBeNull();
    } finally {
      await app.close();
      administration.destroy();
      limiter.destroy();
    }
  });

  it("compõe builder, persistência, UNKNOWN/recovery e reconciliação cifrada", async () => {
    const requestCipher = new OperationRequestCipher({
      activeKeyId: "composition-request-key",
      environment: "homologation",
      keys: new Map([["composition-request-key", Buffer.alloc(32, 0x31)]]),
    });
    const projectionCipher = new OperationReconciliationProjectionCipher({
      activeKeyId: "composition-projection-key",
      environment: "homologation",
      masterKeys: new Map([
        ["composition-projection-key", Buffer.alloc(32, 0x32)],
      ]),
    });
    const cpfSentinel = "12345678901";
    const plateSentinel = "QTP4H82";
    const renavamSentinel = "10987654321";
    const crvSentinel = "123456789012";
    const codeSentinel = "98765432109";

    async function build(plate: string, suffix: string) {
      const exact = Buffer.from(
        JSON.stringify({
          cpfOperadorResponsavel: cpfSentinel,
          dataCompra: "2026-11-24",
          emailEstabelecimento: "loja@example.test",
          emailVendedor: "vendedor@example.test",
          valorCompra: 100,
          veiculo: {
            codigoSegurancaCrv: codeSentinel,
            dataHoraMedicaoHodometro: "2026-11-24T12:00:00-03:00",
            documentoProprietarioAtual: cpfSentinel,
            numeroCrv: crvSentinel,
            placa: plate,
            quilometragemHodometro: 10,
            renavam: renavamSentinel,
            tipoCrv: "DIGITAL",
            tipoDocumentoProprietarioAtual: "CPF",
          },
        }),
        "utf8",
      );
      const prepared = await restorePreparedRenaveMutation(
        "request-stock-entry",
        exact,
        createHash("sha256").update(exact).digest("hex"),
      );
      return buildCreateOperationInput(requestCipher, projectionCipher, {
        actorSubjectHash: createHash("sha256")
          .update(`actor:${suffix}`)
          .digest(),
        correlationId: randomUUID(),
        environment: "homologation",
        establishmentId: operatorStore.id,
        idempotencyKeyDigest: createHash("sha256")
          .update(`idempotency:${suffix}`)
          .digest(),
        prepared,
        tenantId: tenant.id,
        vehicleKeyDigest: createHash("sha256").update(plate).digest(),
      });
    }

    async function reconcile(
      operationInput: Awaited<ReturnType<typeof build>>,
      path: "unknown" | "recovery",
    ) {
      const createdOperationId = await withTenant(
        migratorPool,
        tenant.id,
        (client) => createLegacyOperationForTest(client, operationInput),
      );
      const result = await withTenant(
        migratorPool,
        tenant.id,
        async (client) => {
          const sendOwner = randomUUID();
          const send = await client.query<{
            lease_token: string;
            outbox_id: string;
          }>("select * from renave.claim_operation_send_leases($1,1)", [
            sendOwner,
          ]);
          const dispatch = await client.query<{ operation_version: string }>(
            "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
            [send.rows[0]!.outbox_id, sendOwner, send.rows[0]!.lease_token],
          );
          let reconcileOutboxId: string;
          let operationVersion: string;
          if (path === "unknown") {
            const unknown = await client.query<{
              operation_version: string;
              reconcile_outbox_id: string;
            }>(
              "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
              [
                send.rows[0]!.outbox_id,
                sendOwner,
                send.rows[0]!.lease_token,
                dispatch.rows[0]!.operation_version,
              ],
            );
            reconcileOutboxId = unknown.rows[0]!.reconcile_outbox_id;
            operationVersion = unknown.rows[0]!.operation_version;
          } else {
            await client.query(
              `update renave.operation_outbox
                  set lease_expires_at=clock_timestamp()-interval '1 ms'
                where id=$1`,
              [send.rows[0]!.outbox_id],
            );
            const recovered = await client.query<{
              operation_version: string;
              reconcile_outbox_id: string;
            }>("select * from renave.recover_expired_operation_sends(1)");
            reconcileOutboxId = recovered.rows[0]!.reconcile_outbox_id;
            operationVersion = recovered.rows[0]!.operation_version;
          }
          await client.query(
            `update renave.operation_outbox
                set available_at=clock_timestamp()-interval '1 ms'
              where id=$1`,
            [reconcileOutboxId],
          );
          const reconcileOwner = randomUUID();
          const claimed = await client.query<{
            lease_token: string;
            operation_version: string;
            outbox_id: string;
          }>(
            "select * from renave.claim_operation_reconciliation_leases($1,1)",
            [reconcileOwner],
          );
          expect(claimed.rows[0]!.operation_version).toBe(operationVersion);
          const begun = await client.query<{
            establishment_id: string;
            kind: "USED_STOCK_ENTRY";
            mutation_family: "STOCK_ENTRY";
            operation_id: string;
            projection_auth_tag: Buffer;
            projection_ciphertext: Buffer;
            projection_generation: string;
            projection_key_id: string;
            projection_kind: "STOCK_ENTRY_RECONCILIATION";
            projection_nonce: Buffer;
            projection_schema_version: 1;
            projection_size: number;
            request_schema_version: 1;
            source_request_sha256: Buffer;
          }>(
            "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
            [
              claimed.rows[0]!.outbox_id,
              reconcileOwner,
              claimed.rows[0]!.lease_token,
              claimed.rows[0]!.operation_version,
            ],
          );
          return begun.rows[0]!;
        },
      );
      expect(result.operation_id).toBe(createdOperationId);
      const restored = projectionCipher.decrypt(
        {
          authTag: result.projection_auth_tag,
          ciphertext: result.projection_ciphertext,
          generation: Number(result.projection_generation),
          keyId: result.projection_key_id,
          nonce: result.projection_nonce,
          projectionByteLength: result.projection_size,
          projectionKind: result.projection_kind,
          projectionSchemaVersion: result.projection_schema_version,
        },
        {
          environment: "homologation",
          establishmentId: result.establishment_id,
          generation: Number(result.projection_generation),
          kind: result.kind,
          mutationFamily: result.mutation_family,
          operationId: result.operation_id,
          requestSchemaVersion: result.request_schema_version,
          sourceRequestSha256: result.source_request_sha256.toString("hex"),
          tenantId: tenant.id,
        },
      );
      const projectionBytes = restored.copyBodyBytes();
      restored.destroy();
      return {
        begin: result,
        projection: JSON.parse(
          new TextDecoder().decode(projectionBytes),
        ) as unknown,
      };
    }

    const unknown = await reconcile(
      await build(plateSentinel, "composition-unknown"),
      "unknown",
    );
    const recovery = await reconcile(
      await build("ABC1D23", "composition-recovery"),
      "recovery",
    );
    expect(unknown.projection).toMatchObject({
      cpfOperadorResponsavel: cpfSentinel,
      veiculo: {
        codigoSegurancaCrv: codeSentinel,
        numeroCrv: crvSentinel,
        placa: plateSentinel,
        renavam: renavamSentinel,
        tipoCrv: "DIGITAL",
      },
    });
    expect(recovery.projection).toMatchObject({
      veiculo: { placa: "ABC1D23" },
    });

    const schema = await adminPool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='renave'
          and table_name in ('operation','operation_reconciliation_projection')`,
    );
    expect(
      schema.rows.map(({ column_name }) => column_name).join(" "),
    ).not.toMatch(/cpf|placa|renavam|crv/iu);
    const publicMetadata = JSON.stringify([unknown.begin, recovery.begin]);
    for (const sentinel of [
      cpfSentinel,
      plateSentinel,
      renavamSentinel,
      crvSentinel,
      codeSentinel,
    ]) {
      expect(publicMetadata).not.toContain(sentinel);
      for (const row of [unknown.begin, recovery.begin]) {
        expect(row.projection_ciphertext.toString("utf8")).not.toContain(
          sentinel,
        );
      }
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

  it("não usa escopo ITE para autorizar consulta de estabelecimento", async () => {
    const scenario = await createPreflightScenario("eligibility-scope-ite");
    await prepareCredentialLink(scenario, "pending");
    await withTenant(appPool, scenario.tenant.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: ADMIN,
        establishmentId: scenario.store.id,
        source: "manual",
        status: "confirmed",
      }),
    );
    await enableEstablishmentServiceScope(scenario, {
      serviceNature: "ite",
    });
    const connectorCall = vi.fn(async () => eligibilityResponse(scenario));

    await expect(
      createEligibilityUseCase(connectorCall).execute(
        eligibilityInput(scenario, "eligibility-scope-ite-trace"),
      ),
    ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it.each(["absent", "expired"] as const)(
    "bloqueia consulta quando o escopo de estabelecimento está %s",
    async (scopeState) => {
      const scenario = await createPreflightScenario(
        `eligibility-scope-${scopeState}`,
      );
      await prepareCredentialLink(scenario, "pending");
      await withTenant(appPool, scenario.tenant.id, (client) =>
        transitionCredentialLink(client, {
          changedBySubject: ADMIN,
          establishmentId: scenario.store.id,
          source: "manual",
          status: "confirmed",
        }),
      );
      if (scopeState === "expired") {
        const now = Date.now();
        await enableEstablishmentServiceScope(scenario, {
          expiresAt: new Date(now - 86_400_000),
          validFrom: new Date(now - 172_800_000),
        });
      }
      const connectorCall = vi.fn(async () => eligibilityResponse(scenario));

      await expect(
        createEligibilityUseCase(connectorCall).execute(
          eligibilityInput(scenario, `eligibility-scope-${scopeState}-trace`),
        ),
      ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
      expect(connectorCall).not.toHaveBeenCalled();
    },
  );

  it("nega quando há duas UFs regulatórias vigentes, mesmo com escopo em uma delas", async () => {
    const scenario = await createPreflightScenario(
      "eligibility-ambiguous-jurisdiction",
    );
    await prepareCredentialLink(scenario, "confirmed");
    const now = Date.now();
    await withTenant(
      credentialScopeProvisionerPool,
      scenario.tenant.id,
      (client) =>
        transitionEstablishmentRegulatoryJurisdiction(client, {
          changedByDigest: createHash("sha256")
            .update(`jurisdiction-actor-sp:${scenario.tenant.id}`)
            .digest(),
          decisionTicketDigest: createHash("sha256")
            .update(`jurisdiction-ticket-sp:${scenario.store.id}`)
            .digest(),
          establishmentId: scenario.store.id,
          evidenceDigest: createHash("sha256")
            .update(`jurisdiction-evidence-sp:${scenario.store.id}`)
            .digest(),
          expiresAt: new Date(now + 86_400_000),
          jurisdictionUf: "SP",
          status: "verified",
          validFrom: new Date(now - 60_000),
        }),
    );
    const connectorCall = vi.fn(async () => eligibilityResponse(scenario));

    await expect(
      createEligibilityUseCase(connectorCall).execute(
        eligibilityInput(scenario, "eligibility-ambiguous-jurisdiction-trace"),
      ),
    ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
    expect(connectorCall).not.toHaveBeenCalled();
  });

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
    await expect(
      withTenant(appPool, tenant.id, (client) =>
        getCredentialServiceScope(client, operatorStore.id, "establishment"),
      ),
    ).resolves.toBeNull();

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

  it("compõe consulta de veículo com PostgreSQL real e mantém identificadores somente cifrados", async () => {
    const scenario = await createPreflightScenario("vehicle-success");
    await prepareCredentialLink(scenario, "confirmed");
    const harness = vehicleLookupHarness(scenario);

    await expect(
      harness.useCase.execute(
        vehicleLookupInput(scenario, "vehicle-success-trace"),
      ),
    ).resolves.toEqual({
      chassi: VEHICLE_CHASSIS,
      placa: VEHICLE_PLATE,
      renavam: VEHICLE_RENAVAM,
      restricoes: [{ codigoTipo: "01", tipo: "Administrativa" }],
      veiculoAcabado: true,
    });
    expect(harness.findStocksByPlate).toHaveBeenCalledOnce();
    expect(harness.getVehicleByPlate).toHaveBeenCalledOnce();
    expect(harness.getAuthenticatedClient).toHaveBeenCalledTimes(2);
    expect(await vehicleEvidenceState(scenario)).toEqual([
      {
        failure_code: null,
        request_clear_absent: true,
        response_ciphertext_present: true,
        response_clear_absent: true,
        status: "completed",
      },
    ]);
    expect(await vehicleAuditOutcomes(scenario)).toEqual([
      "attempted",
      "succeeded",
    ]);
    const audits = await withTenant(appPool, scenario.tenant.id, (client) =>
      listAuditEvents(client),
    );
    const publicAudit = JSON.stringify(
      audits.filter(({ action }) => action === "renave.vehicle.read"),
    );
    for (const sentinel of [
      VEHICLE_PLATE,
      VEHICLE_RENAVAM,
      VEHICLE_CHASSIS,
      "Administrativa",
    ]) {
      expect(publicAudit).not.toContain(sentinel);
    }
  });

  it("nega vínculo, BOLA e tenant divergente antes de qualquer rede", async () => {
    const unlinked = await createPreflightScenario("vehicle-unlinked");
    const unlinkedHarness = vehicleLookupHarness(unlinked);
    await expect(
      unlinkedHarness.useCase.execute(
        vehicleLookupInput(unlinked, "vehicle-unlinked-trace"),
      ),
    ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
    expect(unlinkedHarness.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(await vehicleEvidenceState(unlinked)).toEqual([]);

    const scoped = await createPreflightScenario("vehicle-bola");
    await prepareCredentialLink(scoped, "confirmed");
    const bolaHarness = vehicleLookupHarness(scoped);
    await expect(
      bolaHarness.useCase.execute(
        vehicleLookupInput(scoped, "vehicle-bola-trace", OPERATOR),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(bolaHarness.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(await vehicleEvidenceState(scoped)).toEqual([]);

    const divergentHarness = vehicleLookupHarness(scoped);
    await expect(
      divergentHarness.useCase.execute({
        ...vehicleLookupInput(scoped, "vehicle-tenant-divergent-trace"),
        tenantId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(divergentHarness.getAuthenticatedClient).not.toHaveBeenCalled();
  });

  it.each([
    ["estoque ausente", [] as RenaveStockRecord[], undefined],
    [
      "estoque cancelado",
      [
        confirmedVehicleStock({
          cancelamentoEstoque: { motivo: "cancelado" },
        }),
      ],
      undefined,
    ],
    [
      "estoque ambíguo",
      [confirmedVehicleStock(), confirmedVehicleStock({ id: 82 })],
      undefined,
    ],
    [
      "HTTP 404",
      [confirmedVehicleStock()],
      new RenaveHttpError(404, "get-vehicle-by-plate"),
    ],
    [
      "HTTP 422",
      [confirmedVehicleStock()],
      new RenaveHttpError(422, "get-vehicle-by-plate"),
    ],
  ] as const)(
    "uniformiza %s como veículo indisponível",
    async (label, stockRecords, vehicleError) => {
      const scenario = await createPreflightScenario(
        `vehicle-unavailable-${label.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase()}`,
      );
      await prepareCredentialLink(scenario, "confirmed");
      const harness = vehicleLookupHarness(scenario, {
        stockRecords,
        ...(vehicleError === undefined ? {} : { vehicleError }),
      });

      await expect(
        harness.useCase.execute(
          vehicleLookupInput(scenario, `vehicle-unavailable-${label}`),
        ),
      ).rejects.toMatchObject({ code: "VEHICLE_NOT_AVAILABLE" });
      expect(await vehicleAuditOutcomes(scenario)).toEqual([
        "attempted",
        "rejected",
      ]);
      expect(await vehicleEvidenceState(scenario)).toEqual([
        {
          failure_code: "VEHICLE_NOT_AVAILABLE",
          request_clear_absent: true,
          response_ciphertext_present: false,
          response_clear_absent: true,
          status: "failed",
        },
      ]);
      if (stockRecords.length === 1 && !stockRecords[0]!.cancelamentoEstoque) {
        expect(harness.getVehicleByPlate).toHaveBeenCalledOnce();
      } else {
        expect(harness.getVehicleByPlate).not.toHaveBeenCalled();
      }
    },
  );

  it("reverte evidência do veículo quando a auditoria final falha", async () => {
    const scenario = await createPreflightScenario("vehicle-atomic-rollback");
    await prepareCredentialLink(scenario, "confirmed");
    const functionName = "renave.test_fail_vehicle_success_audit";
    const triggerName = "test_fail_vehicle_success_audit";
    await adminPool.query(
      `create function ${functionName}()
       returns trigger
       language plpgsql
       as $$
       begin
         if new.action = 'renave.vehicle.read' and new.outcome = 'succeeded' then
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
      const harness = vehicleLookupHarness(scenario);
      await expect(
        harness.useCase.execute(
          vehicleLookupInput(scenario, "vehicle-rollback-trace"),
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(harness.getVehicleByPlate).toHaveBeenCalledOnce();
      expect(await vehicleEvidenceState(scenario)).toEqual([
        {
          failure_code: null,
          request_clear_absent: true,
          response_ciphertext_present: false,
          response_clear_absent: true,
          status: "pending",
        },
      ]);
      expect(await vehicleAuditOutcomes(scenario)).toEqual(["attempted"]);
    } finally {
      await adminPool.query(
        `drop trigger if exists ${triggerName} on renave.audit_event`,
      );
      await adminPool.query(`drop function if exists ${functionName}()`);
    }
  });
});
