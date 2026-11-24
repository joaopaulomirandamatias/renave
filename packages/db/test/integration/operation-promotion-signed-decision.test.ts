import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

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
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import {
  type OperationAuthorizationSnapshot,
  seedVerifiedOperationPrincipals,
} from "../helpers/operation-authorization.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");
const ENVIRONMENT = "homologation" as const;
const LOGICAL_DATABASE_ID = "00000000-0000-4000-8000-000000000074";
const PROMOTION_SQL = `select * from renave_promotion.promote_held_local_operation(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
  $20,$21,$22,$23
)`;

interface Fixture {
  authorization: OperationAuthorizationSnapshot;
  establishment: Establishment;
  operationId: string;
  tenant: Tenant;
}

interface SignedPromotionInput {
  artifactDigest: Buffer;
  authorizationBindingDigest: Buffer;
  changedByDigest: Buffer;
  credentialLinkVersion: string;
  decisionId: string;
  environment: "homologation" | "production";
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  evidenceManifestDigest: Buffer;
  executorWorkloadDigest: Buffer;
  expiresAt: Date;
  issuedAt: Date;
  issuerKeyId: string;
  jurisdictionGeneration: string;
  jurisdictionUf: string;
  logicalDatabaseId: string;
  notBefore: Date;
  operationId: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  policyVersion: string;
  scopeGeneration: string;
  serviceNature: string;
}

interface PromotionReceipt {
  operation_id: string;
  operation_status: string;
  outbox_id: string;
  promoted_at: Date;
  replayed: boolean;
}

interface PromotionState {
  artifact_count: number;
  decision_count: number;
  operation_status: string;
  operation_version: string;
  outbox_count: number;
  outbox_id: string | null;
  pending_transitions: number;
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
      changedBySubject: "oidc|signed-promotion-fixture",
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

async function authorizeService(
  tenantId: string,
  establishmentId: string,
  label: string,
): Promise<void> {
  const common = {
    changedByDigest: digest(`scope-actor:${label}`),
    decisionTicketDigest: digest(`scope-ticket:${label}`),
    establishmentId,
    evidenceDigest: digest(`scope-evidence:${label}`),
    expiresAt: new Date(Date.now() + 120_000),
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
  authorization: OperationAuthorizationSnapshot,
): CreateHeldLocalOperationInput {
  return {
    ...operationProjectionFields(`signed-promotion:${label}`),
    ...authorization,
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 7),
    requestCiphertext: Buffer.from(`encrypted:${label}`, "utf8"),
    requestKeyId: "signed-promotion-test-key",
    requestNonce: Buffer.alloc(12, 8),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}`),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

async function fixture(label: string): Promise<Fixture> {
  fixtureCounter += 1;
  const unique = `${label}-${fixtureCounter}`;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Signed promotion ${unique}`,
    slug: `signed-promotion-${unique}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Signed promotion ${unique}`,
    }),
  );
  await establishLink(tenant.id, establishment.id);
  const authorization = await withTenant(migratorPool, tenant.id, (client) =>
    seedVerifiedOperationPrincipals(client, {
      establishmentId: establishment.id,
      label: unique,
    }),
  );
  await authorizeService(tenant.id, establishment.id, unique);
  const created = await withTenant(appPool, tenant.id, (client) =>
    createOrReplayHeldLocalOperation(
      client,
      operationInput(unique, establishment.id, authorization),
    ),
  );
  return {
    authorization,
    establishment,
    operationId: created.operation.id,
    tenant,
  };
}

function signedDecision(
  target: Fixture,
  options: { expiresAt?: Date } = {},
): SignedPromotionInput {
  const issuedAt = new Date(Date.now() - 1_000);
  const notBefore = new Date(Date.now() - 500);
  return {
    artifactDigest: digest(`artifact:${target.operationId}`),
    authorizationBindingDigest: digest(`binding:${target.operationId}`),
    changedByDigest: digest(`changed-by:${target.operationId}`),
    credentialLinkVersion: "3",
    decisionId: randomUUID(),
    environment: ENVIRONMENT,
    establishmentProfileId: target.authorization.establishmentProfileId,
    establishmentProfileVersion:
      target.authorization.establishmentProfileVersion,
    evidenceManifestDigest: digest(`evidence:${target.operationId}`),
    executorWorkloadDigest: digest(`executor:${target.operationId}`),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
    issuedAt,
    issuerKeyId: "promotion-ed25519-hml-v1",
    jurisdictionGeneration: "1",
    jurisdictionUf: "PA",
    logicalDatabaseId: LOGICAL_DATABASE_ID,
    notBefore,
    operationId: target.operationId,
    operatorProfileId: target.authorization.operatorProfileId,
    operatorProfileVersion: target.authorization.operatorProfileVersion,
    policyVersion: "held-local-release/v1",
    scopeGeneration: "1",
    serviceNature: "establishment",
  };
}

function promotionParameters(input: SignedPromotionInput): unknown[] {
  return [
    input.operationId,
    input.environment,
    input.logicalDatabaseId,
    input.decisionId,
    input.issuedAt,
    input.notBefore,
    input.expiresAt,
    input.issuerKeyId,
    input.policyVersion,
    input.authorizationBindingDigest,
    input.executorWorkloadDigest,
    input.artifactDigest,
    input.evidenceManifestDigest,
    input.changedByDigest,
    input.serviceNature,
    input.jurisdictionUf,
    input.jurisdictionGeneration,
    input.scopeGeneration,
    input.credentialLinkVersion,
    input.operatorProfileId,
    input.operatorProfileVersion,
    input.establishmentProfileId,
    input.establishmentProfileVersion,
  ];
}

async function promote(
  tenantId: string,
  input: SignedPromotionInput,
): Promise<PromotionReceipt> {
  return withTenant(promoterPool, tenantId, async (client) => {
    const { rows } = await client.query<PromotionReceipt>(
      PROMOTION_SQL,
      promotionParameters(input),
    );
    return rows[0]!;
  });
}

async function state(target: Fixture): Promise<PromotionState> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<PromotionState>(
      `select operation.status operation_status,
              operation.version::text operation_version,
              (select count(*)::int from renave.operation_outbox outbox
                where outbox.operation_id=operation.id) outbox_count,
              (select outbox.id::text from renave.operation_outbox outbox
                where outbox.operation_id=operation.id limit 1) outbox_id,
              (select count(*)::int from renave.operation_promotion_decision decision
                where decision.operation_id=operation.id) decision_count,
              (select count(*)::int
                 from renave_promotion.operation_promotion_signed_artifact artifact
                where artifact.operation_id=operation.id) artifact_count,
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

async function waitForBlockedPromotion(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await adminPool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_catalog.pg_stat_activity
          where wait_event_type='Lock'
            and query like '%renave_promotion.promote_held_local_operation%'
       ) waiting`,
    );
    if (rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("signed promotion did not wait for the row lock");
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
  throw new Error("database clock did not reach signed artifact expiry");
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 16 });
  migratorPool = createPool(urls.migrator, { max: 8 });
  promoterPool = createPool(urls.operationPromoter, {
    application_name: "signed-operation-promotion-test",
    max: 24,
  });
  scopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 4,
  });
  const identity = await migratorPool.query<{
    environment: string;
    logical_database_id: string;
  }>(
    `select environment,logical_database_id
       from renave_promotion.operation_promotion_identity`,
  );
  if (identity.rows.length === 0) {
    await migratorPool.query(
      "select renave_promotion.configure_operation_promotion_identity($1,$2)",
      [ENVIRONMENT, LOGICAL_DATABASE_ID],
    );
  } else {
    expect(identity.rows).toEqual([
      {
        environment: ENVIRONMENT,
        logical_database_id: LOGICAL_DATABASE_ID,
      },
    ]);
  }
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

describe("signed HELD_LOCAL promotion decision", () => {
  it("devolve recibo fechado sem conceder SELECT direto ao papel", async () => {
    const target = await fixture("receipt");
    const decision = signedDecision(target);
    const receipt = await promote(target.tenant.id, decision);

    expect(receipt).toMatchObject({
      operation_id: target.operationId,
      operation_status: "PENDING_SEND",
      replayed: false,
    });
    expect(receipt.outbox_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(receipt.promoted_at).toBeInstanceOf(Date);

    for (const sql of [
      "select * from renave_promotion.operation_promotion_signed_artifact",
      "select * from renave_promotion.operation_promotion_identity",
      "select * from renave.operation_outbox",
      "select * from renave.operation",
    ]) {
      await expect(
        withTenant(promoterPool, target.tenant.id, (client) =>
          client.query(sql),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const artifact = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query(
          `select operation_id,outbox_id,decision_id,artifact_digest,
                  authorization_binding_digest,executor_workload_digest,
                  evidence_manifest_digest,changed_by_digest,issuer_key_id,
                  policy_version,environment,logical_database_id,issued_at,
                  not_before,expires_at
             from renave_promotion.operation_promotion_signed_artifact
            where operation_id=$1`,
          [target.operationId],
        ),
    );
    expect(artifact.rows).toEqual([
      {
        artifact_digest: decision.artifactDigest,
        authorization_binding_digest: decision.authorizationBindingDigest,
        changed_by_digest: decision.changedByDigest,
        decision_id: decision.decisionId,
        environment: decision.environment,
        evidence_manifest_digest: decision.evidenceManifestDigest,
        executor_workload_digest: decision.executorWorkloadDigest,
        expires_at: decision.expiresAt,
        issued_at: decision.issuedAt,
        issuer_key_id: decision.issuerKeyId,
        logical_database_id: decision.logicalDatabaseId,
        not_before: decision.notBefore,
        operation_id: target.operationId,
        outbox_id: receipt.outbox_id,
        policy_version: decision.policyVersion,
      },
    ]);
  });

  it("avalia expiração depois dos locks tardios da primitiva e não grava parcialmente", async () => {
    const target = await fixture("expiry-after-lock");
    const expiresAt = new Date(Date.now() + 500);
    const decision = signedDecision(target, { expiresAt });
    const before = await state(target);
    const blocker = await migratorPool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select set_config('renave.tenant_id',$1,true)", [
        target.tenant.id,
      ]);
      await blocker.query(
        "select id from renave.tenant where id=$1 for update",
        [target.tenant.id],
      );
      const attempted = promote(target.tenant.id, decision).catch(
        (error: unknown) => error,
      );
      await waitForBlockedPromotion();
      await waitForDatabaseTime(expiresAt);
      await blocker.query("rollback");
      await expect(attempted).resolves.toMatchObject({ code: "55000" });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    expect(await state(target)).toEqual(before);
  });

  it("nega claims divergentes de binding, ambiente e databaseId sem efeitos", async () => {
    const target = await fixture("divergent-claims");
    const baseline = signedDecision(target);
    const before = await state(target);
    const cases: Array<readonly [string, Partial<SignedPromotionInput>]> = [
      ["environment", { environment: "production" }],
      ["database", { logicalDatabaseId: randomUUID() }],
      ["service nature", { serviceNature: "ite" }],
      ["jurisdiction UF", { jurisdictionUf: "SP" }],
      ["jurisdiction generation", { jurisdictionGeneration: "2" }],
      ["scope generation", { scopeGeneration: "2" }],
      ["credential link", { credentialLinkVersion: "4" }],
      ["operator profile", { operatorProfileId: randomUUID() }],
      ["operator version", { operatorProfileVersion: "2" }],
      ["establishment profile", { establishmentProfileId: randomUUID() }],
      ["establishment version", { establishmentProfileVersion: "2" }],
    ];
    for (const [label, change] of cases) {
      await expect(
        promote(target.tenant.id, { ...baseline, ...change }),
        label,
      ).rejects.toMatchObject({ code: "55000" });
      expect(await state(target), label).toEqual(before);
    }
  });

  it("faz replay exato sem duplicar decisão, artefato, transição ou outbox", async () => {
    const target = await fixture("exact-replay");
    const decision = signedDecision(target);
    const first = await promote(target.tenant.id, decision);
    const replay = await promote(target.tenant.id, decision);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await state(target)).toMatchObject({
      artifact_count: 1,
      decision_count: 1,
      operation_status: "PENDING_SEND",
      outbox_count: 1,
      outbox_id: first.outbox_id,
      pending_transitions: 1,
      transition_count: 2,
    });
  });

  it("nega replay com decisão divergente e preserva o recibo original", async () => {
    const target = await fixture("divergent-replay");
    const decision = signedDecision(target);
    const receipt = await promote(target.tenant.id, decision);
    const baseline = await state(target);
    const shiftedIssuedAt = new Date(decision.issuedAt.getTime() - 1);
    const cases: Array<readonly [string, Partial<SignedPromotionInput>]> = [
      ["decision", { decisionId: randomUUID() }],
      ["artifact", { artifactDigest: digest("different-artifact") }],
      [
        "binding digest",
        { authorizationBindingDigest: digest("different-binding") },
      ],
      ["executor", { executorWorkloadDigest: digest("different-executor") }],
      ["evidence", { evidenceManifestDigest: digest("different-evidence") }],
      ["actor", { changedByDigest: digest("different-actor") }],
      ["issuer", { issuerKeyId: "promotion-ed25519-hml-v2" }],
      ["policy", { policyVersion: "held-local-release/v2" }],
      ["time", { issuedAt: shiftedIssuedAt }],
    ];
    for (const [label, change] of cases) {
      await expect(
        promote(target.tenant.id, { ...decision, ...change }),
        label,
      ).rejects.toMatchObject({ code: "55000" });
      expect(await state(target), label).toEqual(baseline);
    }
    expect(baseline.outbox_id).toBe(receipt.outbox_id);
  });

  it("não enumera operação de outro tenant", async () => {
    const target = await fixture("tenant-origin");
    const other = await provisionTenant(migratorPool, {
      displayName: "Signed promotion other tenant",
      slug: `signed-promotion-other-${++fixtureCounter}`,
    });
    const decision = signedDecision(target);
    const before = await state(target);

    await expect(promote(other.id, decision)).rejects.toMatchObject({
      code: "55000",
      message: "operation promotion: indisponível",
    });
    expect(await state(target)).toEqual(before);
    const foreign = await withTenant(migratorPool, other.id, (client) =>
      client.query(
        "select count(*)::int total from renave_promotion.operation_promotion_signed_artifact",
      ),
    );
    expect(foreign.rows).toEqual([{ total: 0 }]);
  });

  it("serializa vinte decisões idênticas em um único efeito", async () => {
    const target = await fixture("concurrent");
    const decision = signedDecision(target);
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () => promote(target.tenant.id, decision)),
    );

    expect(new Set(receipts.map(({ outbox_id }) => outbox_id)).size).toBe(1);
    expect(
      new Set(receipts.map(({ promoted_at }) => promoted_at.getTime())).size,
    ).toBe(1);
    expect(receipts.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(receipts.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(await state(target)).toMatchObject({
      artifact_count: 1,
      decision_count: 1,
      operation_status: "PENDING_SEND",
      outbox_count: 1,
      pending_transitions: 1,
      transition_count: 2,
    });
  });
});
