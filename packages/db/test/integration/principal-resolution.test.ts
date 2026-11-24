import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import { transitionCredentialLink } from "../../src/credential-links.js";
import {
  transitionCredentialServiceScope,
  transitionEstablishmentRegulatoryJurisdiction,
} from "../../src/credential-service-scopes.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  resolveVerifiedRenavePrincipals,
  RenavePrincipalResolutionUnavailableError,
} from "../../src/renave-profiles.js";
import {
  createOrReplayHeldLocalOperation,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");
const READY = "oidc|principal-resolution-ready";
const PENDING = "oidc|principal-resolution-pending";
const NO_SCOPE = "oidc|principal-resolution-no-scope";
const NO_ROLE = "oidc|principal-resolution-no-role";
const REVOKED = "oidc|principal-resolution-revoked";
const SUSPENDED = "oidc|principal-resolution-suspended";
const USER_SUSPENDED = "oidc|principal-resolution-user-suspended";

let adminPool: Pool;
let appPool: Pool;
let racePool: Pool;
let migratorPool: Pool;
let scopeProvisionerPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let storeA: Establishment;
let storeOtherA: Establishment;
let storePendingContactA: Establishment;
let storeSuspendedContactA: Establishment;
let storeNoLinkA: Establishment;
let storeInactiveA: Establishment;
let storePendingLinkA: Establishment;
let storeConfirmedLinkA: Establishment;
let storeDeactivatedLinkA: Establishment;
let storeRejectedLinkA: Establishment;
let storeB: Establishment;

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function cnpj(index: number): string {
  const base = `91420836${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

function operationInput(label: string): CreateOperationInput {
  const plaintext = Buffer.from(JSON.stringify({ label }), "utf8");
  return {
    ...operationProjectionFields(`principal-resolution:${label}`),
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId: storeA.id,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 7),
    requestCiphertext: Buffer.from(`encrypted:${label}`, "utf8"),
    requestKeyId: "principal-resolution-key-v1",
    requestNonce: Buffer.alloc(12, 8),
    requestSchemaVersion: 1,
    requestSha256: digest(plaintext),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
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

async function setLinkStatus(
  tenantId: string,
  establishmentId: string,
  target: "confirmed" | "deactivated" | "enabled" | "pending" | "rejected",
): Promise<void> {
  await withTenant(appPool, tenantId, async (client) => {
    const common = {
      changedBySubject: "oidc|principal-resolution-setup",
      establishmentId,
    };
    await transitionCredentialLink(client, {
      ...common,
      source: "manual",
      status: "pending",
    });
    if (target === "pending") return;
    if (target === "deactivated" || target === "rejected") {
      await transitionCredentialLink(client, {
        ...common,
        source: "system",
        status: target,
      });
      return;
    }
    await transitionCredentialLink(client, {
      ...common,
      source: "serpro_preflight",
      status: "confirmed",
    });
    if (target === "confirmed") return;
    await transitionCredentialLink(client, {
      ...common,
      source: "serpro_preflight",
      status: "enabled",
    });
  });
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
         case when $11::bytea is null then null
              else pg_catalog.clock_timestamp() end
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
         case when $11::bytea is null then null
              else pg_catalog.clock_timestamp() end
       )`,
      [
        establishmentId,
        digest(`email-hmac:${tenantId}:${label}`),
        Buffer.alloc(12, 4),
        Buffer.alloc(16, 5),
        Buffer.alloc(512, 6),
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

async function authorizeStockEntry(
  tenantId: string,
  establishmentId: string,
): Promise<void> {
  const common = {
    changedByDigest: digest(`scope-actor:${establishmentId}`),
    decisionTicketDigest: digest(`scope-ticket:${establishmentId}`),
    establishmentId,
    evidenceDigest: digest(`scope-evidence:${establishmentId}`),
    expiresAt: new Date(Date.now() + 3_600_000),
    jurisdictionUf: "PA" as const,
    validFrom: new Date(Date.now() - 60_000),
  };
  await withTenant(scopeProvisionerPool, tenantId, async (client) => {
    await transitionEstablishmentRegulatoryJurisdiction(client, {
      ...common,
      status: "verified",
    });
    await transitionCredentialServiceScope(client, {
      ...common,
      serviceNature: "establishment",
      status: "enabled",
    });
  });
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 8 });
  racePool = createPool(urls.app, {
    application_name: "principal-resolution-race",
    max: 1,
  });
  migratorPool = createPool(urls.migrator, { max: 8 });
  scopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 2,
  });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Principal Resolution A",
    slug: "principal-resolution-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Principal Resolution B",
    slug: "principal-resolution-b",
  });
  [
    storeA,
    storeOtherA,
    storePendingContactA,
    storeSuspendedContactA,
    storeNoLinkA,
    storeInactiveA,
    storePendingLinkA,
    storeConfirmedLinkA,
    storeDeactivatedLinkA,
    storeRejectedLinkA,
  ] = await Promise.all([
    createStore(tenantA.id, 1, "Resolution Store A"),
    createStore(tenantA.id, 2, "Resolution Other A"),
    createStore(tenantA.id, 3, "Resolution Pending Contact A"),
    createStore(tenantA.id, 4, "Resolution Suspended Contact A"),
    createStore(tenantA.id, 5, "Resolution No Link A"),
    createStore(tenantA.id, 6, "Resolution Inactive A"),
    createStore(tenantA.id, 7, "Resolution Pending Link A"),
    createStore(tenantA.id, 8, "Resolution Confirmed Link A"),
    createStore(tenantA.id, 9, "Resolution Deactivated Link A"),
    createStore(tenantA.id, 10, "Resolution Rejected Link A"),
  ]);
  storeB = await createStore(tenantB.id, 1, "Resolution Store B");

  await Promise.all([
    grantOperator(tenantA.id, READY, storeA.id),
    grantOperator(tenantA.id, PENDING, storeA.id),
    grantOperator(tenantA.id, NO_SCOPE, storeOtherA.id),
    grantOperator(tenantA.id, REVOKED, storeA.id),
    grantOperator(tenantA.id, SUSPENDED, storeA.id),
    grantOperator(tenantA.id, USER_SUSPENDED, storeA.id),
    grantOperator(tenantA.id, READY, storePendingContactA.id),
    grantOperator(tenantA.id, READY, storeSuspendedContactA.id),
    grantOperator(tenantA.id, READY, storeNoLinkA.id),
    grantOperator(tenantA.id, READY, storeInactiveA.id),
    grantOperator(tenantA.id, READY, storePendingLinkA.id),
    grantOperator(tenantA.id, READY, storeConfirmedLinkA.id),
    grantOperator(tenantA.id, READY, storeDeactivatedLinkA.id),
    grantOperator(tenantA.id, READY, storeRejectedLinkA.id),
    grantOperator(tenantB.id, READY, storeB.id),
  ]);
  await withTenant(migratorPool, tenantA.id, (client) =>
    client.query(
      `insert into renave.tenant_user (tenant_id, subject)
       values (renave.current_tenant_id(), $1)`,
      [NO_ROLE],
    ),
  );
  await Promise.all([
    setLinkStatus(tenantA.id, storeA.id, "enabled"),
    setLinkStatus(tenantA.id, storeOtherA.id, "enabled"),
    setLinkStatus(tenantA.id, storePendingContactA.id, "enabled"),
    setLinkStatus(tenantA.id, storeSuspendedContactA.id, "enabled"),
    setLinkStatus(tenantA.id, storeInactiveA.id, "enabled"),
    setLinkStatus(tenantA.id, storePendingLinkA.id, "pending"),
    setLinkStatus(tenantA.id, storeConfirmedLinkA.id, "confirmed"),
    setLinkStatus(tenantA.id, storeDeactivatedLinkA.id, "deactivated"),
    setLinkStatus(tenantA.id, storeRejectedLinkA.id, "rejected"),
    setLinkStatus(tenantB.id, storeB.id, "enabled"),
  ]);
  await authorizeStockEntry(tenantA.id, storeA.id);
  await Promise.all([
    seedOperatorProfile(tenantA.id, READY, "verified", "ready-a"),
    seedOperatorProfile(tenantA.id, PENDING, "pending", "pending-a"),
    seedOperatorProfile(tenantA.id, NO_SCOPE, "verified", "no-scope-a"),
    seedOperatorProfile(tenantA.id, NO_ROLE, "verified", "no-role-a"),
    seedOperatorProfile(tenantA.id, REVOKED, "verified", "revoked-a"),
    seedOperatorProfile(tenantA.id, SUSPENDED, "suspended", "suspended-a"),
    seedOperatorProfile(
      tenantA.id,
      USER_SUSPENDED,
      "verified",
      "user-suspended-a",
    ),
    seedOperatorProfile(tenantB.id, READY, "verified", "ready-b"),
    seedEstablishmentProfile(tenantA.id, storeA.id, "verified", "store-a"),
    seedEstablishmentProfile(tenantA.id, storeOtherA.id, "verified", "other-a"),
    seedEstablishmentProfile(
      tenantA.id,
      storePendingContactA.id,
      "pending",
      "pending-contact-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeSuspendedContactA.id,
      "suspended",
      "suspended-contact-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeNoLinkA.id,
      "verified",
      "no-link-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeInactiveA.id,
      "verified",
      "inactive-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storePendingLinkA.id,
      "verified",
      "pending-link-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeConfirmedLinkA.id,
      "verified",
      "confirmed-link-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeDeactivatedLinkA.id,
      "verified",
      "deactivated-link-a",
    ),
    seedEstablishmentProfile(
      tenantA.id,
      storeRejectedLinkA.id,
      "verified",
      "rejected-link-a",
    ),
    seedEstablishmentProfile(tenantB.id, storeB.id, "verified", "store-b"),
  ]);
  await withTenant(migratorPool, tenantA.id, async (client) => {
    await client.query(
      `update renave.tenant_user set status = 'suspended'
        where tenant_id = renave.current_tenant_id() and subject = $1`,
      [USER_SUSPENDED],
    );
    await client.query(
      `update renave.establishment set status = 'inactive'
        where tenant_id = renave.current_tenant_id() and id = $1`,
      [storeInactiveA.id],
    );
  });
  await withTenant(migratorPool, tenantB.id, (client) =>
    client.query(
      `update renave.tenant set status = 'suspended'
        where id = renave.current_tenant_id()`,
    ),
  );
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    racePool?.end(),
    migratorPool?.end(),
    scopeProvisionerPool?.end(),
  ]);
});

describe("verified RENAVE principal resolution", () => {
  it("resolve somente envelopes verificados e não grava estado", async () => {
    const countsSql = `select
      (select count(*)::int from renave.operation) as operations,
      (select count(*)::int from renave.operation_outbox) as outbox,
      (select count(*)::int from renave.operator_identity_profile_history)
        as operator_history,
      (select count(*)::int from renave.establishment_renave_profile_history)
        as establishment_history`;
    const before = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query<{
        establishment_history: number;
        operations: number;
        operator_history: number;
        outbox: number;
      }>(countsSql),
    );
    const resolved = await withTenant(appPool, tenantA.id, (client) =>
      resolveVerifiedRenavePrincipals(client, {
        establishmentId: storeA.id,
        idempotencyKeyDigest: digest("principal-resolution-success"),
        subject: READY,
      }),
    );

    expect(resolved.operator).toMatchObject({
      binding: {
        purpose: "operator-cpf",
        subject: READY,
        tenantId: tenantA.id,
      },
      envelope: {
        ciphertext: Buffer.alloc(128, 3),
        envelopeSchemaVersion: 1,
        keyId: "cpf-envelope-v1",
      },
    });
    expect(resolved.establishment).toMatchObject({
      binding: {
        establishmentId: storeA.id,
        purpose: "establishment-email",
        tenantId: tenantA.id,
      },
      envelope: {
        ciphertext: Buffer.alloc(512, 6),
        envelopeSchemaVersion: 1,
        keyId: "email-envelope-v1",
      },
    });
    expect(JSON.stringify(resolved)).not.toMatch(
      /plaintext|verification_source|source_evidence|verified_by/iu,
    );
    const after = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(countsSql),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("serializa criação direta e fluxo resolver→HELD_LOCAL sem deadlock", async () => {
    const input = operationInput("idempotency-lock-order");
    const directCreate = withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, input),
    );
    const resolvedCreate = withTenant(appPool, tenantA.id, async (client) => {
      await resolveVerifiedRenavePrincipals(client, {
        establishmentId: storeA.id,
        idempotencyKeyDigest: input.idempotencyKeyDigest,
        subject: READY,
      });
      return createOrReplayHeldLocalOperation(client, input);
    });

    const [direct, resolved] = await Promise.all([
      directCreate,
      resolvedCreate,
    ]);
    expect(direct.operation.id).toBe(resolved.operation.id);
    expect([direct.replayed, resolved.replayed].sort()).toEqual([false, true]);
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int as count from renave.operation
            where idempotency_key_digest = $1`,
          [input.idempotencyKeyDigest],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  const unavailableCases: Array<
    [string, () => string, () => string, () => string]
  > = [
    ["perfil pendente", () => tenantA.id, () => PENDING, () => storeA.id],
    ["perfil suspenso", () => tenantA.id, () => SUSPENDED, () => storeA.id],
    [
      "usuário suspenso",
      () => tenantA.id,
      () => USER_SUSPENDED,
      () => storeA.id,
    ],
    ["sem papel", () => tenantA.id, () => NO_ROLE, () => storeA.id],
    ["sem escopo", () => tenantA.id, () => NO_SCOPE, () => storeA.id],
    [
      "contato pendente",
      () => tenantA.id,
      () => READY,
      () => storePendingContactA.id,
    ],
    [
      "contato suspenso",
      () => tenantA.id,
      () => READY,
      () => storeSuspendedContactA.id,
    ],
    ["vínculo ausente", () => tenantA.id, () => READY, () => storeNoLinkA.id],
    [
      "vínculo pendente",
      () => tenantA.id,
      () => READY,
      () => storePendingLinkA.id,
    ],
    [
      "vínculo confirmado",
      () => tenantA.id,
      () => READY,
      () => storeConfirmedLinkA.id,
    ],
    [
      "vínculo desativado",
      () => tenantA.id,
      () => READY,
      () => storeDeactivatedLinkA.id,
    ],
    [
      "vínculo rejeitado",
      () => tenantA.id,
      () => READY,
      () => storeRejectedLinkA.id,
    ],
    ["loja inativa", () => tenantA.id, () => READY, () => storeInactiveA.id],
    ["tenant suspenso", () => tenantB.id, () => READY, () => storeB.id],
    ["subject ausente", () => tenantA.id, () => "oidc|absent", () => storeA.id],
    ["tenant cruzado", () => tenantA.id, () => READY, () => storeB.id],
  ];

  it.each(unavailableCases)(
    "falha fechado para %s",
    async (_label, getTenant, getSubject, getStore) => {
      await expect(
        withTenant(appPool, getTenant(), (client) =>
          resolveVerifiedRenavePrincipals(client, {
            establishmentId: getStore(),
            idempotencyKeyDigest: digest(`principal-resolution:${_label}`),
            subject: getSubject(),
          }),
        ),
      ).rejects.toBeInstanceOf(RenavePrincipalResolutionUnavailableError);
    },
  );

  it("serializa revogação concorrente de escopo e falha após o lock", async () => {
    const revoker = await migratorPool.connect();
    await revoker.query("begin");
    await revoker.query("select set_config('renave.tenant_id', $1, true)", [
      tenantA.id,
    ]);
    await revoker.query(
      `delete from renave.establishment_role_scope
        where tenant_id = renave.current_tenant_id()
          and subject = $1 and role = 'renave_operator'
          and establishment_id = $2`,
      [REVOKED, storeA.id],
    );

    const resolution = withTenant(racePool, tenantA.id, (client) =>
      resolveVerifiedRenavePrincipals(client, {
        establishmentId: storeA.id,
        idempotencyKeyDigest: digest("principal-resolution-scope-race"),
        subject: REVOKED,
      }),
    );
    let observedWaitingLock = false;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const waiting = await adminPool.query<{ waiting: boolean }>(
          `select exists (
             select 1 from pg_catalog.pg_stat_activity
              where application_name = 'principal-resolution-race'
                and wait_event_type = 'Lock'
           ) as waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          observedWaitingLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWaitingLock).toBe(true);
      await revoker.query("commit");
      await expect(resolution).rejects.toBeInstanceOf(
        RenavePrincipalResolutionUnavailableError,
      );
    } finally {
      if (!observedWaitingLock) await revoker.query("rollback");
      revoker.release();
    }
  });

  it("serializa suspensão concorrente do perfil e falha após o lock", async () => {
    const suspender = await migratorPool.connect();
    await suspender.query("begin");
    await suspender.query("select set_config('renave.tenant_id', $1, true)", [
      tenantA.id,
    ]);
    await suspender.query(
      `update renave.operator_identity_profile
          set status = 'suspended', version = version + 1,
              updated_at = pg_catalog.clock_timestamp(),
              changed_by_subject_hash = $2
        where tenant_id = renave.current_tenant_id() and subject = $1`,
      [READY, digest("principal-resolution-race-suspender")],
    );

    const resolution = withTenant(racePool, tenantA.id, (client) =>
      resolveVerifiedRenavePrincipals(client, {
        establishmentId: storeA.id,
        idempotencyKeyDigest: digest("principal-resolution-profile-race"),
        subject: READY,
      }),
    );
    let observedWaitingLock = false;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const waiting = await adminPool.query<{ waiting: boolean }>(
          `select exists (
             select 1 from pg_catalog.pg_stat_activity
              where application_name = 'principal-resolution-race'
                and wait_event_type = 'Lock'
           ) as waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          observedWaitingLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWaitingLock).toBe(true);
      await suspender.query("commit");
      await expect(resolution).rejects.toBeInstanceOf(
        RenavePrincipalResolutionUnavailableError,
      );
    } finally {
      if (!observedWaitingLock) await suspender.query("rollback");
      suspender.release();
    }
  });

  it("concede somente ao app a função de resolução", async () => {
    const { rows } = await adminPool.query<{
      can_execute: boolean;
      role_name: string;
    }>(
      `with roles(role_name) as (values
           ('public'), ('renave_app'), ('renave_identity_app'),
           ('renave_maintenance_app'), ('renave_operation_worker')
       )
       select role_name,
              has_function_privilege(
                role_name,
                'renave.resolve_verified_renave_principals(text,uuid,bytea)',
                'execute'
              ) as can_execute
         from roles order by role_name`,
    );
    expect(rows).toHaveLength(5);
    for (const access of rows) {
      expect(access.can_execute).toBe(access.role_name === "renave_app");
    }
    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });
});
