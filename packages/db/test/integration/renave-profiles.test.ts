import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  getEstablishmentRenaveProfileStatus,
  getOperatorIdentityProfileStatus,
} from "../../src/renave-profiles.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const VERIFIED = "oidc|renave-profile-verified";
const PENDING = "oidc|renave-profile-pending";
const SUSPENDED = "oidc|renave-profile-suspended";

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let verifiedStoreA: Establishment;
let pendingStoreA: Establishment;
let suspendedStoreA: Establishment;
let pendingStoreB: Establishment;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function cnpj(index: number): string {
  const base = `82510473${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

async function createStore(
  tenantId: string,
  index: number,
  tradeName: string,
): Promise<Establishment> {
  return withTenant(appPool, tenantId, (client) =>
    createEstablishment(client, { cnpj: cnpj(index), tradeName }),
  );
}

async function grantOperator(
  tenantId: string,
  subject: string,
  establishmentId: string,
): Promise<void> {
  await withTenant(migratorPool, tenantId, (client) =>
    grantTenantUserAccess(client, subject, [
      { establishmentIds: [establishmentId], role: "renave_operator" },
    ]),
  );
}

async function seedOperatorProfile(
  tenantId: string,
  subject: string,
  status: "pending" | "suspended" | "verified",
  label: string,
): Promise<void> {
  const verified = status !== "pending";
  await withTenant(migratorPool, tenantId, (client) =>
    client.query(
      `insert into renave.operator_identity_profile (
         tenant_id, subject, hmac_key_id, identity_hmac,
         envelope_schema_version, envelope_key_id, envelope_nonce,
         envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
         status, verification_source, source_evidence_digest,
         changed_by_subject_hash, verified_by_subject_hash, verified_at
       ) values (
         renave.current_tenant_id(), $1, 'cpf-hmac-v1', $2,
         1, 'cpf-envelope-v1', $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         case when $11::bytea is null then null else pg_catalog.clock_timestamp() end
       )`,
      [
        subject,
        digest(`cpf-hmac:${tenantId}:${label}`),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        Buffer.alloc(128, 3),
        digest(`cpf-aad:${tenantId}:${label}`),
        status,
        verified ? "regulated_provider" : "unverified_candidate",
        digest(`cpf-evidence:${tenantId}:${label}`),
        digest(`cpf-changer:${tenantId}:${label}`),
        verified ? digest(`cpf-verifier:${tenantId}:${label}`) : null,
      ],
    ),
  );
}

async function seedEstablishmentProfile(
  tenantId: string,
  establishmentId: string,
  status: "pending" | "suspended" | "verified",
  label: string,
): Promise<void> {
  const verified = status !== "pending";
  await withTenant(migratorPool, tenantId, (client) =>
    client.query(
      `insert into renave.establishment_renave_profile (
         tenant_id, establishment_id, hmac_key_id, email_hmac,
         envelope_schema_version, envelope_key_id, envelope_nonce,
         envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
         status, verification_source, source_evidence_digest,
         changed_by_subject_hash, verified_by_subject_hash, verified_at
       ) values (
         renave.current_tenant_id(), $1, 'email-hmac-v1', $2,
         1, 'email-envelope-v1', $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         case when $11::bytea is null then null else pg_catalog.clock_timestamp() end
       )`,
      [
        establishmentId,
        digest(`email-hmac:${tenantId}:${label}`),
        Buffer.alloc(12, 4),
        Buffer.alloc(16, 5),
        Buffer.alloc(256, 6),
        digest(`email-aad:${tenantId}:${label}`),
        status,
        verified ? "mailbox_challenge" : "unverified_candidate",
        digest(`email-evidence:${tenantId}:${label}`),
        digest(`email-changer:${tenantId}:${label}`),
        verified ? digest(`email-verifier:${tenantId}:${label}`) : null,
      ],
    ),
  );
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "RENAVE Profiles A",
    slug: "renave-profiles-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "RENAVE Profiles B",
    slug: "renave-profiles-b",
  });
  [verifiedStoreA, pendingStoreA, suspendedStoreA] = await Promise.all([
    createStore(tenantA.id, 1, "Verified Store A"),
    createStore(tenantA.id, 2, "Pending Store A"),
    createStore(tenantA.id, 3, "Suspended Store A"),
  ]);
  pendingStoreB = await createStore(tenantB.id, 1, "Pending Store B");

  await Promise.all([
    grantOperator(tenantA.id, VERIFIED, verifiedStoreA.id),
    grantOperator(tenantA.id, PENDING, pendingStoreA.id),
    grantOperator(tenantA.id, SUSPENDED, suspendedStoreA.id),
    grantOperator(tenantB.id, VERIFIED, pendingStoreB.id),
  ]);
  await Promise.all([
    seedOperatorProfile(tenantA.id, VERIFIED, "verified", "verified-a"),
    seedOperatorProfile(tenantA.id, PENDING, "pending", "pending-a"),
    seedOperatorProfile(tenantA.id, SUSPENDED, "suspended", "suspended-a"),
    seedOperatorProfile(tenantB.id, VERIFIED, "pending", "pending-b"),
    seedEstablishmentProfile(
      tenantA.id,
      verifiedStoreA.id,
      "verified",
      "verified-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      pendingStoreA.id,
      "pending",
      "pending-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      suspendedStoreA.id,
      "suspended",
      "suspended-a",
    ),
    seedEstablishmentProfile(
      tenantB.id,
      pendingStoreB.id,
      "pending",
      "pending-b",
    ),
  ]);
});

afterAll(async () => {
  await Promise.all([adminPool?.end(), appPool?.end(), migratorPool?.end()]);
});

describe("verified RENAVE profile foundation", () => {
  it("expõe somente estados sanitizados e isolados pelo tenant", async () => {
    const [operatorA, storeA, suspendedA, operatorB, storeB] =
      await Promise.all([
        withTenant(appPool, tenantA.id, (client) =>
          getOperatorIdentityProfileStatus(client, VERIFIED),
        ),
        withTenant(appPool, tenantA.id, (client) =>
          getEstablishmentRenaveProfileStatus(client, verifiedStoreA.id),
        ),
        withTenant(appPool, tenantA.id, (client) =>
          getOperatorIdentityProfileStatus(client, SUSPENDED),
        ),
        withTenant(appPool, tenantB.id, (client) =>
          getOperatorIdentityProfileStatus(client, VERIFIED),
        ),
        withTenant(appPool, tenantB.id, (client) =>
          getEstablishmentRenaveProfileStatus(client, pendingStoreB.id),
        ),
      ]);

    expect(operatorA).toBe("verified");
    expect(storeA).toBe("verified");
    expect(suspendedA).toBe("suspended");
    expect(operatorB).toBe("pending");
    expect(storeB).toBe("pending");
  });

  it("não permite observar perfil de outro tenant", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getEstablishmentRenaveProfileStatus(client, pendingStoreB.id),
      ),
    ).resolves.toBeNull();
  });

  it("não permite promover candidato para verified nem duplicar CPF no tenant", async () => {
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          `update renave.operator_identity_profile
              set status = 'verified',
                  version = version + 1,
                  updated_at = pg_catalog.clock_timestamp(),
                  verified_at = pg_catalog.clock_timestamp(),
                  verified_by_subject_hash = $2
            where tenant_id = renave.current_tenant_id() and subject = $1`,
          [PENDING, digest("candidate-verifier")],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await grantOperator(tenantA.id, "oidc|duplicate-cpf", pendingStoreA.id);
    const existingHmac = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const { rows } = await client.query<{ identity_hmac: Buffer }>(
          `select identity_hmac from renave.operator_identity_profile
            where subject = $1`,
          [VERIFIED],
        );
        return rows[0]!.identity_hmac;
      },
    );
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          `insert into renave.operator_identity_profile (
             tenant_id, subject, hmac_key_id, identity_hmac,
             envelope_schema_version, envelope_key_id, envelope_nonce,
             envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
             status, verification_source, source_evidence_digest,
             changed_by_subject_hash
           ) values (
             renave.current_tenant_id(), 'oidc|duplicate-cpf', 'cpf-hmac-v1', $1,
             1, 'cpf-envelope-v1', $2, $3, $4, $5,
             'pending', 'unverified_candidate', $6, $7
           )`,
          [
            existingHmac,
            Buffer.alloc(12, 7),
            Buffer.alloc(16, 8),
            Buffer.alloc(128, 9),
            digest("duplicate-aad"),
            digest("duplicate-evidence"),
            digest("duplicate-changer"),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("grava histórico mínimo e o mantém append-only", async () => {
    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        `update renave.operator_identity_profile
            set status = 'suspended', version = version + 1,
                updated_at = pg_catalog.clock_timestamp(),
                changed_by_subject_hash = $2
          where tenant_id = renave.current_tenant_id() and subject = $1`,
        [VERIFIED, digest("suspension-actor")],
      ),
    );
    const history = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const { rows } = await client.query<{
          column_name: string;
          count: string;
        }>(
          `select columns.column_name,
                  (select count(*)::text
                     from renave.operator_identity_profile_history history
                    where history.profile_id = profile.id) as count
             from information_schema.columns columns
             cross join renave.operator_identity_profile profile
            where columns.table_schema = 'renave'
              and columns.table_name = 'operator_identity_profile_history'
              and profile.subject = $1
            order by columns.ordinal_position`,
          [VERIFIED],
        );
        return rows;
      },
    );
    expect(history[0]?.count).toBe("2");
    expect(history.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining([
        "subject",
        "identity_hmac",
        "envelope_ciphertext",
        "envelope_nonce",
        "envelope_auth_tag",
      ]),
    );

    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          `update renave.operator_identity_profile_history
              set status = status
            where tenant_id = renave.current_tenant_id()`,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("nega leitura e escrita direta aos runtimes e não oferece resolvedor", async () => {
    const tableAccess = await adminPool.query<{
      has_any_access: boolean;
      role_name: string;
      table_name: string;
    }>(
      `with roles(role_name) as (values
           ('public'), ('renave_app'), ('renave_identity_app'),
           ('renave_maintenance_app'), ('renave_operation_worker')
       ), protected_tables(table_name) as (values
           ('renave.operator_identity_profile'),
           ('renave.establishment_renave_profile'),
           ('renave.operator_identity_profile_history'),
           ('renave.establishment_renave_profile_history')
       )
       select role_name, table_name,
              has_table_privilege(role_name, table_name, 'select')
              or has_table_privilege(role_name, table_name, 'insert')
              or has_table_privilege(role_name, table_name, 'update')
              or has_table_privilege(role_name, table_name, 'delete')
              or has_table_privilege(role_name, table_name, 'truncate')
              or has_table_privilege(role_name, table_name, 'references')
              or has_table_privilege(role_name, table_name, 'trigger')
                as has_any_access
         from roles cross join protected_tables
        order by role_name, table_name`,
    );
    expect(tableAccess.rows).toHaveLength(20);
    expect(
      tableAccess.rows.every(({ has_any_access }) => !has_any_access),
    ).toBe(true);

    const functionAccess = await adminPool.query<{
      can_execute: boolean;
      function_name: string;
      role_name: string;
    }>(
      `with roles(role_name) as (values
           ('public'), ('renave_app'), ('renave_identity_app'),
           ('renave_maintenance_app'), ('renave_operation_worker')
       ), status_functions(function_name) as (values
           ('renave.get_operator_identity_profile_status(text)'),
           ('renave.get_establishment_renave_profile_status(uuid)')
       )
       select role_name, function_name,
              has_function_privilege(role_name, function_name, 'execute')
                as can_execute
         from roles cross join status_functions
        order by role_name, function_name`,
    );
    expect(functionAccess.rows).toHaveLength(10);
    for (const access of functionAccess.rows) {
      expect(access.can_execute).toBe(access.role_name === "renave_app");
    }

    await expect(
      adminPool.query<{ resolver_absent: boolean }>(
        `select to_regprocedure(
           'renave.resolve_verified_renave_profiles(text,uuid)'
         ) is null as resolver_absent`,
      ),
    ).resolves.toMatchObject({ rows: [{ resolver_absent: true }] });

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "delete from renave.operator_identity_profile where false",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("mantém RLS forçada, ciphertext em buckets e runtime pronto", async () => {
    const { rows } = await adminPool.query<{
      forced: boolean;
      runtime_ready: boolean;
      sizes_bucketed: boolean;
    }>(
      `select
         bool_and(class.relrowsecurity and class.relforcerowsecurity) as forced,
         (select renave_runtime.api_contract_ready()) as runtime_ready,
         (select bool_and(octet_length(envelope_ciphertext)
                   in (128, 256, 512, 1024, 2048, 4096))
            from (
              select envelope_ciphertext from renave.operator_identity_profile
              union all
              select envelope_ciphertext from renave.establishment_renave_profile
            ) envelopes) as sizes_bucketed
        from pg_catalog.pg_class class
        join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
       where namespace.nspname = 'renave'
         and class.relname in (
           'operator_identity_profile', 'establishment_renave_profile',
           'operator_identity_profile_history',
           'establishment_renave_profile_history'
         )`,
    );
    expect(rows[0]).toEqual({
      forced: true,
      runtime_ready: true,
      sizes_bucketed: true,
    });
  });
});
