import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
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
  createOrReplayHeldLocalOperation,
  type CreateHeldLocalOperationInput,
} from "../../src/operations.js";
import {
  createPool,
  type TenantClient,
  withTenant,
} from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

interface ProfileBinding {
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  subject: string;
}

interface Fixture {
  binding: ProfileBinding;
  establishment: Establishment;
  input: CreateHeldLocalOperationInput;
  operationId: string;
  tenant: Tenant;
}

interface PromotionRow {
  operation_id: string;
  operation_status: string;
  outbox_id: string;
  promoted_at: Date;
  replayed: boolean;
}

interface PromotionDecisionInput {
  changedByDigest: Buffer;
  decisionTicketDigest: Buffer;
  evidenceDigest: Buffer;
}

interface LeaseRow {
  lease_token: string;
  outbox_id: string;
}

interface PersistedState {
  binding_count: number;
  operation_status: string;
  operation_version: string;
  outbox_count: number;
  outbox_id: string | null;
  outbox_status: string | null;
  pending_transitions: number;
  promotion_decision_count: number;
  sent_at: Date | null;
  transition_count: number;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let promoterPool: Pool;
let scopeProvisionerPool: Pool;
let fixtureCounter = 0;

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

async function establishLink(
  tenantId: string,
  establishmentId: string,
): Promise<void> {
  await withTenant(appPool, tenantId, async (client) => {
    const common = {
      changedBySubject: "oidc|promotion-fixture",
      establishmentId,
      source: "manual" as const,
    };
    await transitionCredentialLink(client, { ...common, status: "pending" });
    await transitionCredentialLink(client, {
      ...common,
      status: "confirmed",
    });
    await transitionCredentialLink(client, { ...common, status: "enabled" });
  });
}

async function seedProfiles(
  tenantId: string,
  establishmentId: string,
  label: string,
): Promise<ProfileBinding> {
  const subject = `oidc|promotion-${label}`;
  await withTenant(migratorPool, tenantId, (client) =>
    grantTenantUserAccess(client, subject, [
      { establishmentIds: [establishmentId], role: "renave_operator" },
    ]),
  );
  return withTenant(migratorPool, tenantId, async (client) => {
    const operator = await client.query<{ id: string; version: string }>(
      `insert into renave.operator_identity_profile (
         tenant_id,subject,hmac_key_id,identity_hmac,
         envelope_schema_version,envelope_key_id,envelope_nonce,
         envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
         status,verification_source,source_evidence_digest,
         changed_by_subject_hash,verified_by_subject_hash,verified_at
       ) values (
         renave.current_tenant_id(),$1,'cpf-hmac-v1',$2,
         1,'cpf-envelope-v1',$3,$4,$5,$6,
         'verified','regulated_provider',$7,$8,$9,
         pg_catalog.clock_timestamp()
       ) returning id,version::text`,
      [
        subject,
        digest(`operator-hmac:${label}`),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        Buffer.alloc(128, 3),
        digest(`operator-aad:${label}`),
        digest(`operator-evidence:${label}`),
        digest(`operator-changer:${label}`),
        digest(`operator-verifier:${label}`),
      ],
    );
    const establishment = await client.query<{
      id: string;
      version: string;
    }>(
      `insert into renave.establishment_renave_profile (
         tenant_id,establishment_id,hmac_key_id,email_hmac,
         envelope_schema_version,envelope_key_id,envelope_nonce,
         envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
         status,verification_source,source_evidence_digest,
         changed_by_subject_hash,verified_by_subject_hash,verified_at
       ) values (
         renave.current_tenant_id(),$1,'email-hmac-v1',$2,
         1,'email-envelope-v1',$3,$4,$5,$6,
         'verified','mailbox_challenge',$7,$8,$9,
         pg_catalog.clock_timestamp()
       ) returning id,version::text`,
      [
        establishmentId,
        digest(`establishment-hmac:${label}`),
        Buffer.alloc(12, 4),
        Buffer.alloc(16, 5),
        Buffer.alloc(512, 6),
        digest(`establishment-aad:${label}`),
        digest(`establishment-evidence:${label}`),
        digest(`establishment-changer:${label}`),
        digest(`establishment-verifier:${label}`),
      ],
    );
    return {
      establishmentProfileId: establishment.rows[0]!.id,
      establishmentProfileVersion: establishment.rows[0]!.version,
      operatorProfileId: operator.rows[0]!.id,
      operatorProfileVersion: operator.rows[0]!.version,
      subject,
    };
  });
}

async function authorizeService(
  tenantId: string,
  establishmentId: string,
  label: string,
  expiresAt = new Date(Date.now() + 60_000),
): Promise<void> {
  const common = {
    changedByDigest: digest(`scope-actor:${label}`),
    decisionTicketDigest: digest(`scope-ticket:${label}`),
    establishmentId,
    evidenceDigest: digest(`scope-evidence:${label}`),
    expiresAt,
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

function operationInput(
  label: string,
  establishmentId: string,
  binding: ProfileBinding,
): CreateHeldLocalOperationInput {
  const requestCiphertext = Buffer.from(`encrypted:${label}`, "utf8");
  return {
    ...operationProjectionFields(`promotion:${label}`),
    ...binding,
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 7),
    requestCiphertext,
    requestKeyId: "promotion-test-key",
    requestNonce: Buffer.alloc(12, 8),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}`),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

async function createHeldLocalWithNullableProfileVersion(
  client: TenantClient,
  input: CreateHeldLocalOperationInput,
  versions: {
    establishmentProfileVersion: string | null;
    operatorProfileVersion: string | null;
  },
): Promise<void> {
  await client.query(
    `select * from renave.create_held_local_operation(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
     )`,
    [
      input.operationId,
      input.establishmentId,
      input.kind,
      input.mutationFamily,
      input.idempotencyKeyDigest,
      input.vehicleKeyDigest,
      input.requestSha256,
      input.requestCiphertext.byteLength,
      input.requestSchemaVersion,
      input.requestKeyId,
      input.requestNonce,
      input.requestAuthTag,
      input.requestCiphertext,
      input.actorSubjectHash,
      input.correlationId,
      input.reconciliationProjectionKind,
      input.reconciliationProjectionSchemaVersion,
      input.reconciliationProjectionGeneration,
      input.reconciliationProjectionByteLength,
      input.reconciliationProjectionKeyId,
      input.reconciliationProjectionNonce,
      input.reconciliationProjectionAuthTag,
      input.reconciliationProjectionCiphertext,
      input.subject,
      input.operatorProfileId,
      versions.operatorProfileVersion,
      input.establishmentProfileId,
      versions.establishmentProfileVersion,
    ],
  );
}

async function fixture(label: string, expiresAt?: Date): Promise<Fixture> {
  fixtureCounter += 1;
  const unique = `${label}-${fixtureCounter}`;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Promotion ${unique}`,
    slug: `promotion-${unique}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Promotion ${unique}`,
    }),
  );
  await establishLink(tenant.id, establishment.id);
  const binding = await seedProfiles(tenant.id, establishment.id, unique);
  await authorizeService(tenant.id, establishment.id, unique, expiresAt);
  const input = operationInput(unique, establishment.id, binding);
  const created = await withTenant(appPool, tenant.id, (client) =>
    createOrReplayHeldLocalOperation(client, input),
  );
  return {
    binding,
    establishment,
    input,
    operationId: created.operation.id,
    tenant,
  };
}

function promotionDecision(target: Fixture): PromotionDecisionInput {
  return {
    changedByDigest: digest(`promotion-actor:${target.operationId}`),
    decisionTicketDigest: digest(`promotion-ticket:${target.operationId}`),
    evidenceDigest: digest(`promotion-evidence:${target.operationId}`),
  };
}

async function promote(
  target: Fixture,
  decision = promotionDecision(target),
): Promise<PromotionRow> {
  return withTenant(promoterPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<PromotionRow>(
      "select * from renave_admin.promote_held_local_operation($1,$2,$3,$4)",
      [
        target.operationId,
        decision.decisionTicketDigest,
        decision.evidenceDigest,
        decision.changedByDigest,
      ],
    );
    return rows[0]!;
  });
}

async function state(target: Fixture): Promise<PersistedState> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<PersistedState>(
      `select operation.status operation_status,
              operation.version::text operation_version,
              operation.sent_at,
              (select count(*)::int from renave.operation_authorization_binding binding
                where binding.operation_id=operation.id) binding_count,
              (select count(*)::int from renave.operation_outbox outbox
                where outbox.operation_id=operation.id) outbox_count,
              (select count(*)::int from renave.operation_promotion_decision decision
                where decision.operation_id=operation.id) promotion_decision_count,
              (select outbox.id::text from renave.operation_outbox outbox
                where outbox.operation_id=operation.id
                order by outbox.created_at,outbox.id limit 1) outbox_id,
              (select min(outbox.delivery_status) from renave.operation_outbox outbox
                where outbox.operation_id=operation.id) outbox_status,
              (select count(*)::int from renave.operation_transition transition
                where transition.operation_id=operation.id) transition_count,
              (select count(*)::int from renave.operation_transition transition
                where transition.operation_id=operation.id
                  and transition.status='PENDING_SEND') pending_transitions
         from renave.operation operation where operation.id=$1`,
      [target.operationId],
    );
    return rows[0]!;
  });
}

async function waitForDatabaseTime(target: Date): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { rows } = await adminPool.query<{ reached: boolean }>(
      "select pg_catalog.clock_timestamp() >= $1::timestamptz reached",
      [target],
    );
    if (rows[0]!.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("database clock did not reach the target instant");
}

async function claim(target: Fixture, owner: string): Promise<LeaseRow> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<LeaseRow>(
      "select outbox_id,lease_token from renave.claim_operation_send_leases($1,1)",
      [owner],
    );
    return rows[0]!;
  });
}

async function beginDispatch(
  target: Fixture,
  lease: LeaseRow,
  owner: string,
): Promise<unknown[]> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query(
      "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
      [lease.outbox_id, owner, lease.lease_token],
    );
    return rows;
  });
}

async function waitForBlockedQuery(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await adminPool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_catalog.pg_stat_activity
          where wait_event_type='Lock' and query like $1
       ) waiting`,
      [`%${pattern}%`],
    );
    if (rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`query did not block: ${pattern}`);
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 16 });
  migratorPool = createPool(urls.migrator, { max: 8 });
  promoterPool = createPool(urls.operationPromoter, {
    application_name: "held-local-promotion-test",
    max: 24,
  });
  scopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 4,
  });
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    migratorPool?.end(),
    promoterPool?.end(),
    scopeProvisionerPool?.end(),
  ]);
});

describe("held-local regulatory promotion", () => {
  it("recusa versões de perfil NULL na assinatura SQL e não grava estado", async () => {
    const target = await fixture("null-profile-version-base");
    const countsSql = `select
      (select count(*)::int from renave.operation) operations,
      (select count(*)::int from renave.operation_authorization_binding) binding,
      (select count(*)::int from renave.operation_promotion_decision) decisions,
      (select count(*)::int from renave.operation_outbox) outbox,
      (select count(*)::int from renave.operation_transition) transitions,
      (select count(*)::int from renave.protected_evidence) evidence`;
    for (const missing of ["operator", "establishment"] as const) {
      const candidate = operationInput(
        `null-profile-version-${missing}-${fixtureCounter}`,
        target.establishment.id,
        target.binding,
      );
      const before = await withTenant(
        migratorPool,
        target.tenant.id,
        (client) => client.query(countsSql),
      );
      await expect(
        withTenant(appPool, target.tenant.id, (client) =>
          createHeldLocalWithNullableProfileVersion(client, candidate, {
            establishmentProfileVersion:
              missing === "establishment"
                ? null
                : target.binding.establishmentProfileVersion,
            operatorProfileVersion:
              missing === "operator"
                ? null
                : target.binding.operatorProfileVersion,
          }),
        ),
      ).rejects.toMatchObject({ code: "22023" });
      const after = await withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(countsSql),
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }
  });

  it("captura binding exato e promove vinte chamadas concorrentes uma única vez", async () => {
    const target = await fixture("concurrent");
    const binding = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) =>
        client.query(
          `select service_nature,jurisdiction_uf,jurisdiction_generation::text,
                  scope_generation::text,credential_link_version::text,
                  operator_profile_id,operator_profile_version::text,
                  establishment_profile_id,establishment_profile_version::text
             from renave.operation_authorization_binding
            where operation_id=$1`,
          [target.operationId],
        ),
    );
    expect(binding.rows).toEqual([
      {
        credential_link_version: "3",
        establishment_profile_id: target.binding.establishmentProfileId,
        establishment_profile_version:
          target.binding.establishmentProfileVersion,
        jurisdiction_generation: "1",
        jurisdiction_uf: "PA",
        operator_profile_id: target.binding.operatorProfileId,
        operator_profile_version: target.binding.operatorProfileVersion,
        scope_generation: "1",
        service_nature: "establishment",
      },
    ]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => promote(target)),
    );
    expect(new Set(results.map(({ outbox_id }) => outbox_id)).size).toBe(1);
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(
      results.every(
        ({ operation_status }) => operation_status === "PENDING_SEND",
      ),
    ).toBe(true);
    expect(await state(target)).toMatchObject({
      binding_count: 1,
      operation_status: "PENDING_SEND",
      operation_version: "2",
      outbox_count: 1,
      outbox_status: "READY",
      pending_transitions: 1,
      promotion_decision_count: 1,
      sent_at: null,
      transition_count: 2,
    });
    const decisionInput = promotionDecision(target);
    const persistedDecision = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query<{
          actor_hash: Buffer;
          changed_by_digest: Buffer;
          decision_ticket_digest: Buffer;
          evidence_digest: Buffer;
          outbox_id: string;
        }>(
          `select decision.outbox_id,decision.decision_ticket_digest,
                  decision.evidence_digest,decision.changed_by_digest,
                  transition.actor_hash
             from renave.operation_promotion_decision decision
             join renave.operation_transition transition
               on transition.tenant_id=decision.tenant_id
              and transition.operation_id=decision.operation_id
              and transition.status='PENDING_SEND'
            where decision.operation_id=$1`,
          [target.operationId],
        ),
    );
    expect(persistedDecision.rows).toEqual([
      {
        actor_hash: decisionInput.changedByDigest,
        changed_by_digest: decisionInput.changedByDigest,
        decision_ticket_digest: decisionInput.decisionTicketDigest,
        evidence_digest: decisionInput.evidenceDigest,
        outbox_id: results[0]!.outbox_id,
      },
    ]);
  });

  it("recusa digests malformados e replay com decisão divergente sem efeitos", async () => {
    const malformed = await fixture("malformed-decision");
    const valid = promotionDecision(malformed);
    for (const field of [
      "decisionTicketDigest",
      "evidenceDigest",
      "changedByDigest",
    ] as const) {
      for (const value of [null, Buffer.alloc(31), Buffer.alloc(33)]) {
        const before = await state(malformed);
        await expect(
          promote(malformed, { ...valid, [field]: value } as never),
        ).rejects.toMatchObject({ code: "55000" });
        expect(await state(malformed)).toEqual(before);
      }
    }

    const replay = await fixture("divergent-replay");
    await promote(replay);
    const beforeReplay = await state(replay);
    await expect(
      promote(replay, {
        ...promotionDecision(replay),
        evidenceDigest: digest("different-promotion-evidence"),
      }),
    ).rejects.toMatchObject({ code: "55000" });
    expect(await state(replay)).toEqual(beforeReplay);
  });

  it("nega HELD_LOCAL legado sem binding e não cria efeito parcial", async () => {
    const target = await fixture("legacy");
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        "delete from renave.operation_authorization_binding where operation_id=$1",
        [target.operationId],
      ),
    ).catch(() => undefined);
    // O binding é append-only; representa-se o legado com triggers desabilitados
    // somente nesta transação administrativa de teste.
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        "alter table renave.operation_authorization_binding disable trigger user",
      );
      try {
        await client.query(
          "delete from renave.operation_authorization_binding where operation_id=$1",
          [target.operationId],
        );
      } finally {
        await client.query(
          "alter table renave.operation_authorization_binding enable trigger user",
        );
      }
    });
    const before = await state(target);
    await expect(promote(target)).rejects.toMatchObject({ code: "55000" });
    expect(await state(target)).toEqual(before);
  });

  it("nega ABA de vínculo, perfis, jurisdição e scope mesmo reabilitados", async () => {
    const cases = [
      "link",
      "operator",
      "establishment",
      "jurisdiction",
      "scope",
    ] as const;
    for (const changed of cases) {
      const target = await fixture(`aba-${changed}`);
      if (changed === "link") {
        await withTenant(appPool, target.tenant.id, async (client) => {
          const common = {
            changedBySubject: "oidc|promotion-aba",
            establishmentId: target.establishment.id,
            source: "manual" as const,
          };
          await transitionCredentialLink(client, {
            ...common,
            status: "deactivated",
          });
          await transitionCredentialLink(client, {
            ...common,
            status: "pending",
          });
          await transitionCredentialLink(client, {
            ...common,
            status: "confirmed",
          });
          await transitionCredentialLink(client, {
            ...common,
            status: "enabled",
          });
        });
      } else if (changed === "operator" || changed === "establishment") {
        await withTenant(migratorPool, target.tenant.id, (client) =>
          client.query(
            `update renave.${changed === "operator" ? "operator_identity_profile" : "establishment_renave_profile"}
                set version=version+1,updated_at=pg_catalog.clock_timestamp()+interval '1 microsecond'
              where id=$1`,
            [
              changed === "operator"
                ? target.binding.operatorProfileId
                : target.binding.establishmentProfileId,
            ],
          ),
        );
      } else {
        const common = {
          changedByDigest: digest(`aba-actor:${changed}`),
          decisionTicketDigest: digest(`aba-ticket:${changed}`),
          establishmentId: target.establishment.id,
          evidenceDigest: digest(`aba-evidence:${changed}`),
          expiresAt: new Date(Date.now() + 60_000),
          jurisdictionUf: "PA" as const,
          validFrom: new Date(Date.now() - 60_000),
        };
        await withTenant(
          scopeProvisionerPool,
          target.tenant.id,
          async (client) => {
            if (changed === "jurisdiction") {
              await transitionEstablishmentRegulatoryJurisdiction(client, {
                ...common,
                status: "suspended",
              });
              await transitionEstablishmentRegulatoryJurisdiction(client, {
                ...common,
                status: "verified",
              });
            } else {
              await transitionCredentialServiceScope(client, {
                ...common,
                serviceNature: "establishment",
                status: "suspended",
              });
              await transitionCredentialServiceScope(client, {
                ...common,
                serviceNature: "establishment",
                status: "enabled",
              });
            }
          },
        );
      }
      const before = await state(target);
      await expect(promote(target)).rejects.toMatchObject({ code: "55000" });
      expect(await state(target)).toEqual(before);
    }
  });

  it("usa relógio posterior ao fence e nega quando o scope expira durante a espera", async () => {
    const expiresAt = new Date(Date.now() + 1_500);
    const target = await fixture("expiry-wait", expiresAt);
    const blocker = await migratorPool.connect();
    let blockerOpen = false;
    let promotion: Promise<PromotionRow> | undefined;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select set_config('renave.tenant_id',$1,true)", [
        target.tenant.id,
      ]);
      await blocker.query(
        `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          renave.current_tenant_id()::text || ':' || $1::uuid::text,700069))`,
        [target.establishment.id],
      );
      promotion = promote(target);
      await waitForBlockedQuery("promote_held_local_operation");
      await waitForDatabaseTime(expiresAt);
      await blocker.query("commit");
      blockerOpen = false;
      await expect(promotion).rejects.toMatchObject({ code: "55000" });
      expect(await state(target)).toMatchObject({
        operation_status: "HELD_LOCAL",
        operation_version: "1",
        outbox_count: 0,
        transition_count: 1,
      });
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
      if (promotion) await promotion.catch(() => undefined);
      blocker.release();
    }
  });

  it("usa relógio posterior ao row lock e nega promoção após expiração", async () => {
    const expiresAt = new Date(Date.now() + 1_500);
    const target = await fixture("expiry-row-lock", expiresAt);
    const blocker = await migratorPool.connect();
    let blockerOpen = false;
    let promotion: Promise<PromotionRow> | undefined;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select set_config('renave.tenant_id',$1,true)", [
        target.tenant.id,
      ]);
      await blocker.query(
        `select 1 from renave.credential_service_scope
          where tenant_id=renave.current_tenant_id()
            and establishment_id=$1 and service_nature='establishment'
            and jurisdiction_uf='PA' for update`,
        [target.establishment.id],
      );
      promotion = promote(target);
      await waitForBlockedQuery("promote_held_local_operation");
      await waitForDatabaseTime(expiresAt);
      await blocker.query("commit");
      blockerOpen = false;
      await expect(promotion).rejects.toMatchObject({ code: "55000" });
      expect(await state(target)).toMatchObject({
        operation_status: "HELD_LOCAL",
        operation_version: "1",
        outbox_count: 0,
        promotion_decision_count: 0,
        transition_count: 1,
      });
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
      if (promotion) await promotion.catch(() => undefined);
      blocker.release();
    }
  });

  it("serializa suspensão concorrente e deixa operação/outbox/transição intactos", async () => {
    const target = await fixture("suspension-race");
    const offline = await scopeProvisionerPool.connect();
    let transactionOpen = false;
    let promotion: Promise<PromotionRow> | undefined;
    try {
      await offline.query("begin");
      transactionOpen = true;
      await offline.query("select set_config('renave.tenant_id',$1,true)", [
        target.tenant.id,
      ]);
      await offline.query(
        `select renave_admin.transition_credential_service_scope(
          $1,'establishment','PA','suspended',pg_catalog.clock_timestamp(),
          pg_catalog.clock_timestamp()+interval '1 minute',$2,$3,$4)`,
        [
          target.establishment.id,
          digest("race-evidence"),
          digest("race-ticket"),
          digest("race-actor"),
        ],
      );
      const before = await state(target);
      promotion = promote(target);
      await waitForBlockedQuery("promote_held_local_operation");
      await offline.query("commit");
      transactionOpen = false;
      await expect(promotion).rejects.toMatchObject({ code: "55000" });
      expect(await state(target)).toEqual(before);
    } finally {
      if (transactionOpen)
        await offline.query("rollback").catch(() => undefined);
      if (promotion) await promotion.catch(() => undefined);
      offline.release();
    }
  });

  it("revalida o binding no dispatch e não devolve ciphertext após ABA do scope", async () => {
    const target = await fixture("dispatch-aba");
    const promoted = await promote(target);
    const owner = randomUUID();
    const lease = await claim(target, owner);
    expect(lease.outbox_id).toBe(promoted.outbox_id);
    const before = await state(target);

    const common = {
      changedByDigest: digest("dispatch-aba-actor"),
      decisionTicketDigest: digest("dispatch-aba-ticket"),
      establishmentId: target.establishment.id,
      evidenceDigest: digest("dispatch-aba-evidence"),
      expiresAt: new Date(Date.now() + 60_000),
      jurisdictionUf: "PA" as const,
      serviceNature: "establishment" as const,
      validFrom: new Date(Date.now() - 60_000),
    };
    await withTenant(scopeProvisionerPool, target.tenant.id, async (client) => {
      await transitionCredentialServiceScope(client, {
        ...common,
        status: "suspended",
      });
      await transitionCredentialServiceScope(client, {
        ...common,
        status: "enabled",
      });
    });

    await expect(beginDispatch(target, lease, owner)).resolves.toEqual([]);
    expect(await state(target)).toEqual(before);
  });

  it("revalida expiração no dispatch depois da promoção e da lease", async () => {
    const expiresAt = new Date(Date.now() + 2_500);
    const target = await fixture("dispatch-expiry", expiresAt);
    await promote(target);
    const owner = randomUUID();
    const lease = await claim(target, owner);
    const before = await state(target);
    await waitForDatabaseTime(expiresAt);

    await expect(beginDispatch(target, lease, owner)).resolves.toEqual([]);
    expect(await state(target)).toEqual(before);
  });

  it("fecha tabela de binding e a promoção para todos os papéis exceto o promotor", async () => {
    const target = await fixture("privileges");
    await expect(
      withTenant(appPool, target.tenant.id, (client) =>
        client.query("select * from renave.operation_authorization_binding"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(promoterPool, target.tenant.id, (client) =>
        client.query("select * from renave.operation_authorization_binding"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const pool of [appPool, promoterPool]) {
      await expect(
        withTenant(pool, target.tenant.id, (client) =>
          client.query("select * from renave.operation_promotion_decision"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const decision = promotionDecision(target);
    await expect(
      withTenant(appPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave_admin.promote_held_local_operation($1,$2,$3,$4)",
          [
            target.operationId,
            decision.decisionTicketDigest,
            decision.evidenceDigest,
            decision.changedByDigest,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows } = await adminPool.query<{
      app_executes: boolean;
      promoter_bypassrls: boolean;
      promoter_executes: boolean;
      promoter_memberships: number;
      public_executes: boolean;
    }>(
      `select
        has_function_privilege('renave_app',
          'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','execute') app_executes,
        has_function_privilege('renave_operation_promoter',
          'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','execute') promoter_executes,
        has_function_privilege('public',
          'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','execute') public_executes,
        (select rolbypassrls from pg_roles
          where rolname='renave_operation_promoter') promoter_bypassrls,
        (select count(*)::int from pg_auth_members membership
          where membership.roleid=(select oid from pg_roles
            where rolname='renave_operation_promoter')
             or membership.member=(select oid from pg_roles
            where rolname='renave_operation_promoter')) promoter_memberships`,
    );
    expect(rows[0]).toEqual({
      app_executes: false,
      promoter_bypassrls: false,
      promoter_executes: true,
      promoter_memberships: 0,
      public_executes: false,
    });
    await promote(target);
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `update renave.operation_promotion_decision
              set evidence_digest=evidence_digest
            where operation_id=$1`,
          [target.operationId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("não enumera operação de outro tenant e mantém o estado de origem", async () => {
    const target = await fixture("tenant-a");
    const other = await fixture("tenant-b");
    const before = await state(target);
    await expect(
      withTenant(promoterPool, other.tenant.id, (client) =>
        client.query(
          "select * from renave_admin.promote_held_local_operation($1,$2,$3,$4)",
          [
            target.operationId,
            promotionDecision(target).decisionTicketDigest,
            promotionDecision(target).evidenceDigest,
            promotionDecision(target).changedByDigest,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    expect(await state(target)).toEqual(before);
  });
});
