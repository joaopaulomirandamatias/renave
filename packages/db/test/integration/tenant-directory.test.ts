import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import {
  discoverTenants,
  TenantDirectoryInputError,
} from "../../src/tenant-directory.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const SUBJECT = "oidc|tenant-directory-user";

let adminPool: Pool;
let appPool: Pool;
let identityPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 2 });
  identityPool = createPool(urls.identity, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Directory A",
    slug: "directory-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Directory B",
    slug: "directory-b",
  });
  for (const tenant of [tenantA, tenantB]) {
    await withTenant(migratorPool, tenant.id, (client) =>
      grantTenantUserAccess(client, SUBJECT, [{ role: "tenant_admin" }]),
    );
  }
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    identityPool?.end(),
    migratorPool?.end(),
  ]);
});

describe("diretório global mínimo de tenants", () => {
  it("descobre somente organizações ativas pelo hash do subject", async () => {
    await expect(discoverTenants(appPool, SUBJECT)).resolves.toEqual([
      { displayName: "Directory A", tenantId: tenantA.id },
      { displayName: "Directory B", tenantId: tenantB.id },
    ]);
    await expect(
      discoverTenants(appPool, "oidc|unknown-subject"),
    ).resolves.toEqual([]);
  });

  it("reflete suspensão de membership e rename/status do tenant", async () => {
    await withTenant(migratorPool, tenantB.id, (client) =>
      client.query(
        "update renave.tenant_user set status = 'suspended' where subject = $1",
        [SUBJECT],
      ),
    );
    await expect(discoverTenants(appPool, SUBJECT)).resolves.toEqual([
      { displayName: "Directory A", tenantId: tenantA.id },
    ]);

    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        "update renave.tenant set display_name = 'Directory A Renamed' where id = $1",
        [tenantA.id],
      ),
    );
    await expect(discoverTenants(appPool, SUBJECT)).resolves.toEqual([
      { displayName: "Directory A Renamed", tenantId: tenantA.id },
    ]);

    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        "update renave.tenant set status = 'suspended' where id = $1",
        [tenantA.id],
      ),
    );
    await expect(discoverTenants(appPool, SUBJECT)).resolves.toEqual([]);
    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query("update renave.tenant set status = 'active' where id = $1", [
        tenantA.id,
      ]),
    );

    await withTenant(migratorPool, tenantB.id, (client) =>
      client.query(
        "update renave.tenant_user set status = 'active' where subject = $1",
        [SUBJECT],
      ),
    );
  });

  it("não concede leitura direta nem armazena subject em texto claro", async () => {
    await expect(
      appPool.query("select * from renave_directory.tenant_catalog"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query("select * from renave_directory.subject_tenant_membership"),
    ).rejects.toMatchObject({ code: "42501" });

    const { rows } = await adminPool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'renave_directory'
        order by table_name, ordinal_position`,
    );
    expect(rows.map(({ column_name }) => column_name)).not.toContain("subject");
  });

  it("recusa subject e digest inválidos antes de revelar dados", async () => {
    await expect(discoverTenants(appPool, " subject")).rejects.toBeInstanceOf(
      TenantDirectoryInputError,
    );
    await expect(
      appPool.query("select * from renave_directory.discover_tenants($1)", [
        Buffer.alloc(31),
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("concede a função somente ao papel de negócio", async () => {
    await expect(
      identityPool.query(
        "select * from renave_directory.discover_tenants($1)",
        [Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const { rows } = await adminPool.query<{
      app_can_execute: boolean;
      identity_can_execute: boolean;
      public_can_execute: boolean;
    }>(
      `select
         has_function_privilege('renave_app', 'renave_directory.discover_tenants(bytea)', 'execute') as app_can_execute,
         has_function_privilege('renave_identity_app', 'renave_directory.discover_tenants(bytea)', 'execute') as identity_can_execute,
         has_function_privilege('public', 'renave_directory.discover_tenants(bytea)', 'execute') as public_can_execute`,
    );
    expect(rows[0]).toEqual({
      app_can_execute: true,
      identity_can_execute: false,
      public_can_execute: false,
    });
  });
});
