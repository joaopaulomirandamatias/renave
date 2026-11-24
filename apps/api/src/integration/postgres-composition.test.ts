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
  withTenant,
  type Establishment,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { PostgresVehicleEligibilityUseCase } from "../renave/use-case.js";
import { PostgresRenaveLinkPreflightUseCase } from "../renave/preflight-use-case.js";
import { PostgresRenaveLinkStatusUseCase } from "../renave/link-status-use-case.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
    const enteredConnector = deferred<void>();
    const releaseConnector = deferred<void>();
    const connectorCall = vi.fn(async () => {
      enteredConnector.resolve(undefined);
      await releaseConnector.promise;
      return {
        result: {
          diagnostico: { veiculoApto: true, veiculoComRecall: false },
        },
        verifiedIdentity: {
          confirmedEstablishmentCnpj: operatorStore.cnpj,
          confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
          environment: "homologation" as const,
          establishmentId: operatorStore.id,
          tenantId: tenant.id,
        },
      };
    });
    const connector = {
      getVehicleEligibility: connectorCall,
    } as unknown as RenaveConnector;
    const cipher = new EvidenceCipher({
      activeKeyId: "integration-key",
      keys: new Map([["integration-key", Buffer.alloc(32, 7)]]),
    });
    const useCase = new PostgresVehicleEligibilityUseCase({
      certificateThumbprintSha256: "c".repeat(64),
      cipher,
      connector,
      integratorCnpj: INTEGRATOR_CNPJ,
      pool: appPool,
    });

    const execution = useCase.execute({
      actorIp: "198.51.100.10",
      crvType: "DIGITAL",
      establishmentId: operatorStore.id,
      plate: "ABC1D23",
      subject: OPERATOR,
      tenantId: tenant.id,
      traceId: "composition-trace",
    });
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
      diagnostico: { veiculoApto: true, veiculoComRecall: false },
    });
    expect(connectorCall).toHaveBeenCalledOnce();

    const audits = await withTenant(appPool, tenant.id, (client) =>
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
      [tenant.id, operatorStore.id],
    );
    expect(evidence.rows[0]).toEqual({
      count: "1",
      response_ciphertext_present: true,
      status: "completed",
    });
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
});
