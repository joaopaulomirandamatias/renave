import {
  createEstablishment,
  createPool,
  grantTenantUserAccess,
  provisionTenant,
  transitionCredentialLink,
  withTenant,
  type Establishment,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { PostgresRenaveReadinessUseCase } from "../renave/readiness-use-case.js";

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
const OPERATOR = "oidc|readiness-operator";

let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let storeA: Establishment;
let otherStoreA: Establishment;
let storeB: Establishment;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Readiness A",
    slug: "readiness-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Readiness B",
    slug: "readiness-b",
  });
  [storeA, otherStoreA] = await withTenant(
    appPool,
    tenantA.id,
    async (client) => [
      await createEstablishment(client, {
        cnpj: "11222333000181",
        tradeName: "Loja autorizada",
      }),
      await createEstablishment(client, {
        cnpj: "12ABC34501DE35",
        tradeName: "Loja fora do escopo",
      }),
    ],
  );
  storeB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "11222333000181",
      tradeName: "Loja outro tenant",
    }),
  );
  await withTenant(migratorPool, tenantA.id, async (client) => {
    await grantTenantUserAccess(client, OPERATOR, [
      { establishmentIds: [storeA.id], role: "renave_operator" },
    ]);
    await transitionCredentialLink(client, {
      changedBySubject: OPERATOR,
      establishmentId: storeA.id,
      source: "manual",
      status: "pending",
    });
    await transitionCredentialLink(client, {
      changedBySubject: OPERATOR,
      establishmentId: storeA.id,
      source: "serpro_preflight",
      status: "confirmed",
    });
  });
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end()]);
});

function useCase(status: "healthy" | "expired" = "healthy") {
  return new PostgresRenaveReadinessUseCase({
    certificateTemporalStatus: () => status,
    integrationConfigured: true,
    pool: appPool,
    queryLimiterConfigured: true,
  });
}

describe("prontidão RENAVE com PostgreSQL", () => {
  it("libera somente consultas da loja autorizada e com gates locais prontos", async () => {
    await expect(
      useCase().execute({
        establishmentId: storeA.id,
        subject: OPERATOR,
        tenantId: tenantA.id,
      }),
    ).resolves.toEqual({
      certificate: "ready",
      environment: "homologation",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      queries: "ready",
    });
  });

  it("fecha consultas quando o certificado expira sem perder o vínculo", async () => {
    await expect(
      useCase("expired").execute({
        establishmentId: storeA.id,
        subject: OPERATOR,
        tenantId: tenantA.id,
      }),
    ).resolves.toMatchObject({
      certificate: "blocked",
      link: "confirmed",
      mutations: "blocked",
      queries: "blocked",
    });
  });

  it.each([
    ["outro estabelecimento", () => tenantA.id, () => otherStoreA.id],
    ["outro tenant", () => tenantB.id, () => storeB.id],
  ] as const)("recusa escopo de %s", async (_, tenantId, establishmentId) => {
    await expect(
      useCase().execute({
        establishmentId: establishmentId(),
        subject: OPERATOR,
        tenantId: tenantId(),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});
