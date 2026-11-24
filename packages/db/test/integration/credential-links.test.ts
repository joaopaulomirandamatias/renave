import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  confirmCredentialLinkFromPreflight,
  getCredentialLink,
  listCredentialLinkHistory,
  rejectCredentialLinkFromPreflight,
  transitionCredentialLink,
} from "../../src/credential-links.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 1 });
  appPool = createPool(urls.app, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 1 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Credential Link A",
    slug: "credential-link-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Credential Link B",
    slug: "credential-link-b",
  });
  establishmentA = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Credential A",
    }),
  );
});

afterAll(async () => {
  await Promise.all([adminPool?.end(), appPool?.end(), migratorPool?.end()]);
});

describe("vínculo Credencia/RENAVE", () => {
  it("mantém estado atual e histórico append-only", async () => {
    const pending = await withTenant(appPool, tenantA.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: "oidc|admin",
        establishmentId: establishmentA.id,
        source: "manual",
        status: "pending",
      }),
    );
    expect(pending).toMatchObject({ status: "pending", version: "1" });

    const confirmed = await withTenant(appPool, tenantA.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: "oidc|admin",
        establishmentId: establishmentA.id,
        reason: "Identidade confirmada no preflight",
        source: "serpro_preflight",
        status: "confirmed",
      }),
    );
    expect(confirmed).toMatchObject({ status: "confirmed", version: "2" });

    const history = await withTenant(appPool, tenantA.id, (client) =>
      listCredentialLinkHistory(client, establishmentA.id),
    );
    expect(history[0]?.changedBySubjectHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(history)).not.toContain("oidc|admin");
    expect(
      history.map(({ previousStatus, status, version }) => ({
        previousStatus,
        status,
        version,
      })),
    ).toEqual([
      { previousStatus: null, status: "pending", version: "1" },
      { previousStatus: "pending", status: "confirmed", version: "2" },
    ]);
  });

  it("é idempotente no mesmo estado e bloqueia saltos", async () => {
    const repeated = await withTenant(appPool, tenantA.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: "oidc|admin",
        establishmentId: establishmentA.id,
        source: "serpro_preflight",
        status: "confirmed",
      }),
    );
    expect(repeated.version).toBe("2");
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        transitionCredentialLink(client, {
          changedBySubject: "oidc|admin",
          establishmentId: establishmentA.id,
          source: "manual",
          status: "pending",
        }),
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("serializa preflights concorrentes e invalida divergência autoritativa", async () => {
    await withTenant(appPool, tenantA.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: "oidc|admin",
        establishmentId: establishmentA.id,
        source: "manual",
        status: "enabled",
      }),
    );
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        rejectCredentialLinkFromPreflight(
          client,
          establishmentA.id,
          "oidc|admin",
        ),
      ),
    ).resolves.toMatchObject({ status: "deactivated" });

    const confirmations = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTenant(appPool, tenantA.id, (client) =>
          confirmCredentialLinkFromPreflight(
            client,
            establishmentA.id,
            "oidc|admin",
          ),
        ),
      ),
    );
    expect(confirmations.every(({ status }) => status === "confirmed")).toBe(
      true,
    );
    const history = await withTenant(appPool, tenantA.id, (client) =>
      listCredentialLinkHistory(client, establishmentA.id),
    );
    expect(history.slice(-2).map(({ status }) => status)).toEqual([
      "pending",
      "confirmed",
    ]);
  });

  it("isola o vínculo e o histórico por tenant", async () => {
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getCredentialLink(client, establishmentA.id),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        listCredentialLinkHistory(client, establishmentA.id),
      ),
    ).resolves.toEqual([]);
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        transitionCredentialLink(client, {
          changedBySubject: "oidc|intruder",
          establishmentId: establishmentA.id,
          source: "manual",
          status: "pending",
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("não permite mutação direta nem reescrita do histórico", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "update renave.credential_link set status = 'enabled' where establishment_id = $1",
          [establishmentA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "delete from renave.credential_link_history where establishment_id = $1",
          [establishmentA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("não concede tabelas ou função a papéis fora do runtime de negócio", async () => {
    const { rows } = await adminPool.query(
      `select
         has_table_privilege('renave_app', 'renave.credential_link', 'select') as app_reads,
         has_table_privilege('renave_app', 'renave.credential_link', 'update') as app_updates,
         has_table_privilege('renave_identity_app', 'renave.credential_link', 'select') as identity_reads,
         has_function_privilege(
           'renave_app',
           'renave.transition_credential_link(uuid,text,text,bytea,text)',
           'execute'
         ) as app_executes,
         has_function_privilege(
           'public',
           'renave.transition_credential_link(uuid,text,text,bytea,text)',
           'execute'
         ) as public_executes,
         exists (
           select 1 from information_schema.columns
            where table_schema = 'renave'
              and table_name = 'credential_link_history'
              and column_name = 'changed_by_subject'
         ) as stores_raw_subject`,
    );
    expect(rows[0]).toEqual({
      app_executes: true,
      app_reads: true,
      app_updates: false,
      identity_reads: false,
      public_executes: false,
      stores_raw_subject: false,
    });
  });
});
