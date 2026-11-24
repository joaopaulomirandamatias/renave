import {
  createEstablishment,
  createPool,
  grantTenantUserAccess,
  provisionTenant,
  withTenant,
  type Establishment,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { PostgresRenaveLinkStatusUseCase } from "../renave/link-status-use-case.js";

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
const ADMIN = "oidc|link-status-admin";
const OPERATOR = "oidc|link-status-operator";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";

let appPool: Pool;
let migratorPool: Pool;
let tenant: Tenant;
let active: Establishment;
let inactive: Establishment;
let useCase: PostgresRenaveLinkStatusUseCase;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenant = await provisionTenant(migratorPool, {
    displayName: "Link Status Semantics",
    slug: "link-status-semantics",
  });
  [active, inactive] = await withTenant(appPool, tenant.id, async (client) => {
    const first = await createEstablishment(client, {
      cnpj: "11222333000181",
      tradeName: "Loja ativa",
    });
    const second = await createEstablishment(client, {
      cnpj: "12ABC34501DE35",
      tradeName: "Loja inativa",
    });
    await client.query(
      "update renave.establishment set status = 'inactive' where id = $1",
      [second.id],
    );
    return [first, { ...second, status: "inactive" as const }];
  });
  await withTenant(migratorPool, tenant.id, async (client) => {
    await grantTenantUserAccess(client, ADMIN, [{ role: "tenant_admin" }]);
    await grantTenantUserAccess(client, OPERATOR, [
      { establishmentIds: [active.id], role: "renave_operator" },
    ]);
  });
  useCase = new PostgresRenaveLinkStatusUseCase(appPool);
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end()]);
});

describe("semântica do status de vínculo", () => {
  it("projeta not_started somente para estabelecimento ativo existente", async () => {
    await expect(
      useCase.execute({
        establishmentId: active.id,
        subject: OPERATOR,
        tenantId: tenant.id,
      }),
    ).resolves.toEqual({ status: "not_started" });
  });

  it.each([
    ["ausente", MISSING_ID],
    ["inativo", () => inactive.id],
  ] as const)(
    "não projeta not_started para estabelecimento %s",
    async (_, id) => {
      await expect(
        useCase.execute({
          establishmentId: typeof id === "function" ? id() : id,
          subject: ADMIN,
          tenantId: tenant.id,
        }),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    },
  );

  it("mantém fora do escopo indistinguível de recurso indisponível", async () => {
    await expect(
      useCase.execute({
        establishmentId: inactive.id,
        subject: OPERATOR,
        tenantId: tenant.id,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});
