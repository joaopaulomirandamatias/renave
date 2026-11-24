import { authorize } from "@seu-renave/access-control";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  getAuthorizationContext,
  grantTenantUserAccess,
  TenantAccessInputError,
} from "../../src/authorization.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const SUBJECT = "oidc|shared-subject";

let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;
let establishmentB: Establishment;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Access Tenant A",
    slug: "access-tenant-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Access Tenant B",
    slug: "access-tenant-b",
  });
  establishmentA = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Access A",
    }),
  );
  establishmentB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "12ABC34501DE35",
      tradeName: "Access B",
    }),
  );

  await withTenant(migratorPool, tenantA.id, (client) =>
    grantTenantUserAccess(client, SUBJECT, [
      {
        establishmentIds: [establishmentA.id],
        role: "renave_operator",
      },
    ]),
  );
  await withTenant(migratorPool, tenantB.id, (client) =>
    grantTenantUserAccess(client, SUBJECT, [{ role: "compliance_auditor" }]),
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end()]);
});

describe("autorização persistida", () => {
  it("resolve o operador somente com a loja atribuída", async () => {
    const context = await withTenant(appPool, tenantA.id, (client) =>
      getAuthorizationContext(client, SUBJECT),
    );
    expect(context).toEqual({
      grants: [
        {
          establishmentIds: [establishmentA.id],
          role: "renave_operator",
        },
      ],
      subject: SUBJECT,
      tenantId: tenantA.id,
    });
    expect(
      authorize(context!, {
        action: "renave.vehicle.eligibility.read",
        establishmentId: establishmentA.id,
        tenantId: tenantA.id,
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(context!, {
        action: "renave.vehicle.eligibility.read",
        establishmentId: establishmentB.id,
        tenantId: tenantA.id,
      }),
    ).toEqual({ allowed: false, reason: "ESTABLISHMENT_SCOPE_DENIED" });
    expect(
      authorize(context!, {
        action: "renave.vehicle.read",
        establishmentId: establishmentA.id,
        tenantId: tenantA.id,
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(context!, {
        action: "renave.vehicle.read",
        establishmentId: establishmentB.id,
        tenantId: tenantA.id,
      }),
    ).toEqual({ allowed: false, reason: "ESTABLISHMENT_SCOPE_DENIED" });
  });

  it("o mesmo subject recebe contexto diferente no outro tenant", async () => {
    const context = await withTenant(appPool, tenantB.id, (client) =>
      getAuthorizationContext(client, SUBJECT),
    );
    expect(context).toEqual({
      grants: [{ establishmentIds: "*", role: "compliance_auditor" }],
      subject: SUBJECT,
      tenantId: tenantB.id,
    });
    expect(
      authorize(context!, { action: "audit.read", tenantId: tenantB.id }),
    ).toMatchObject({ allowed: true });
  });

  it("usuário suspenso não produz contexto autorizador", async () => {
    await withTenant(migratorPool, tenantB.id, (client) =>
      client.query(
        "update renave.tenant_user set status = 'suspended' where subject = $1",
        [SUBJECT],
      ),
    );
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getAuthorizationContext(client, SUBJECT),
      ),
    ).resolves.toBeNull();
    await withTenant(migratorPool, tenantB.id, (client) =>
      client.query(
        "update renave.tenant_user set status = 'active' where subject = $1",
        [SUBJECT],
      ),
    );
  });

  it("tenant suspenso invalida o contexto mesmo com usuário ativo", async () => {
    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        "update renave.tenant set status = 'suspended' where id = $1",
        [tenantA.id],
      ),
    );
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getAuthorizationContext(client, SUBJECT),
      ),
    ).resolves.toBeNull();
    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query("update renave.tenant set status = 'active' where id = $1", [
        tenantA.id,
      ]),
    );
  });

  it("papel de aplicação não cria ou altera grants", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        grantTenantUserAccess(client, "oidc|intruder", [
          { role: "tenant_admin" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("recusa operador sem estabelecimento antes de persistir grants", async () => {
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        grantTenantUserAccess(client, "oidc|no-scope", [
          { role: "renave_operator" },
        ]),
      ),
    ).rejects.toBeInstanceOf(TenantAccessInputError);
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getAuthorizationContext(client, "oidc|no-scope"),
      ),
    ).resolves.toBeNull();
  });
});
