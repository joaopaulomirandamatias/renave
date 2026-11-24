import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  beginOperationReconciliation,
  claimOperationReconciliations,
  completeOperationReconciliationConfirmed,
  completeOperationReconciliationManualReview,
  type OperationReconciliationClaim,
} from "../../src/operation-reconciliation.js";
import {
  createOrReplayOperation,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { bindHistoricalOperationForDispatch } from "../helpers/operation-authorization.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

interface Target {
  establishment: Establishment;
  operationId: string;
  operationVersion: string;
  outboxId: string;
  tenant: Tenant;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let workerPool: Pool;
let sequence = 0;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function createTarget(label: string): Promise<Target> {
  sequence += 1;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Completion ${label} ${sequence}`,
    slug: `recon-completion-${sequence}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Completion ${label}`,
    }),
  );
  const input: CreateOperationInput = {
    ...operationProjectionFields(`completion:${label}:${sequence}`),
    actorSubjectHash: digest(`actor:${label}:${sequence}`),
    correlationId: randomUUID(),
    establishmentId: establishment.id,
    idempotencyKeyDigest: digest(`idempotency:${label}:${sequence}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 1),
    requestCiphertext: Buffer.from(`ciphertext:${label}:${sequence}`),
    requestKeyId: "completion-key",
    requestNonce: Buffer.alloc(12, 2),
    requestSchemaVersion: 1,
    requestSha256: digest(`request:${label}:${sequence}`),
    vehicleKeyDigest: digest(`vehicle:${label}:${sequence}`),
  };
  const created = await withTenant(migratorPool, tenant.id, (client) =>
    createOrReplayOperation(client, input),
  );
  await withTenant(migratorPool, tenant.id, (client) =>
    bindHistoricalOperationForDispatch(client, {
      establishmentId: establishment.id,
      label: `reconciliation-completion:${label}:${sequence}`,
      operationId: created.operation.id,
    }),
  );
  const sendOwner = randomUUID();
  const pending = await withTenant(migratorPool, tenant.id, async (client) => {
    const send = await client.query<{ lease_token: string; outbox_id: string }>(
      "select * from renave.claim_operation_send_leases($1,1)",
      [sendOwner],
    );
    const dispatch = await client.query<{ operation_version: string }>(
      "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
      [send.rows[0]!.outbox_id, sendOwner, send.rows[0]!.lease_token],
    );
    const unknown = await client.query<{
      operation_version: string;
      reconcile_outbox_id: string;
    }>(
      "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
      [
        send.rows[0]!.outbox_id,
        sendOwner,
        send.rows[0]!.lease_token,
        dispatch.rows[0]!.operation_version,
      ],
    );
    await client.query(
      `update renave.operation_outbox
          set available_at=clock_timestamp()-interval '1 ms'
        where id=$1`,
      [unknown.rows[0]!.reconcile_outbox_id],
    );
    return unknown.rows[0]!;
  });
  return {
    establishment,
    operationId: created.operation.id,
    operationVersion: pending.operation_version,
    outboxId: pending.reconcile_outbox_id,
    tenant,
  };
}

async function claimOne(
  target: Target,
  owner = randomUUID(),
): Promise<{ lease: OperationReconciliationClaim; owner: string }> {
  const claims = await withTenant(workerPool, target.tenant.id, (client) =>
    claimOperationReconciliations(client, owner, 1),
  );
  expect(claims).toHaveLength(1);
  return { lease: claims[0]!, owner };
}

function fence(owner: string, lease: OperationReconciliationClaim) {
  return {
    leaseOwner: owner,
    leaseToken: lease.leaseToken,
    operationVersion: lease.operationVersion,
    outboxId: lease.outboxId,
  };
}

async function bundle(target: Target) {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const operation = await client.query<{
      finalized_at: Date | null;
      last_error_code: string | null;
      remote_record_id: string | null;
      remote_state: string | null;
      status: string;
      version: string;
    }>(
      `select status,version,finalized_at,last_error_code,
              remote_record_id,remote_state
         from renave.operation where id=$1`,
      [target.operationId],
    );
    const outbox = await client.query<{
      completed_at: Date | null;
      delivery_status: string;
      last_error_code: string | null;
      lease_owner: string | null;
      lease_token: string | null;
    }>(
      `select delivery_status,lease_owner,lease_token,
              completed_at,last_error_code
         from renave.operation_outbox where id=$1`,
      [target.outboxId],
    );
    const transitions = await client.query<{
      reason_code: string;
      status: string;
      version: string;
    }>(
      `select version,status,reason_code
         from renave.operation_transition
        where operation_id=$1 order by version`,
      [target.operationId],
    );
    return {
      operation: operation.rows[0]!,
      outbox: outbox.rows[0]!,
      transitions: transitions.rows,
    };
  });
}

async function waitForBlock(
  observer: Pool,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `select $2::integer=any(
         pg_catalog.pg_blocking_pids($1::integer)
       ) as blocked`,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("completion não aguardou o lock de suspensão");
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("begin");
  await client.query("select set_config('renave.tenant_id',$1,true)", [
    tenantId,
  ]);
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  workerPool = createPool(urls.operationWorker, { max: 8 });
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    migratorPool?.end(),
    workerPool?.end(),
  ]);
});

describe("operation reconciliation completion", () => {
  it("begin devolve CNPJ canônico e confirmed finaliza bundle atômico", async () => {
    const target = await createTarget("confirmed");
    const { lease, owner } = await claimOne(target);
    const input = fence(owner, lease);
    const begun = await withTenant(workerPool, target.tenant.id, (client) =>
      beginOperationReconciliation(client, input),
    );
    expect(begun).toMatchObject({
      establishmentCnpj: "11222333000181",
      establishmentId: target.establishment.id,
      operationId: target.operationId,
    });
    expect(JSON.stringify(begun)).not.toMatch(/11\.222|333\/0001/u);

    const completed = await withTenant(workerPool, target.tenant.id, (client) =>
      completeOperationReconciliationConfirmed(client, {
        ...input,
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      }),
    );
    expect(completed).toMatchObject({
      operationId: target.operationId,
      operationVersion: "4",
      reconcileOutboxId: target.outboxId,
    });
    expect(JSON.stringify(completed)).not.toContain("11222333000181");

    const persisted = await bundle(target);
    expect(persisted.operation).toMatchObject({
      last_error_code: null,
      remote_record_id: "7",
      remote_state: "CONFIRMADO",
      status: "CONFIRMED",
      version: "4",
    });
    expect(persisted.operation.finalized_at).toBeInstanceOf(Date);
    expect(persisted.outbox).toMatchObject({
      delivery_status: "COMPLETED",
      last_error_code: null,
      lease_owner: null,
      lease_token: null,
    });
    expect(persisted.outbox.completed_at).toBeInstanceOf(Date);
    expect(persisted.transitions.at(-1)).toEqual({
      reason_code: "RENAVE_RECONCILIATION_CONFIRMED",
      status: "CONFIRMED",
      version: "4",
    });
  });

  it.each([
    "RENAVE_RECONCILIATION_AMBIGUOUS",
    "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
    "RENAVE_RECONCILIATION_UNRECOVERABLE",
  ] as const)("manual review aceita reason fechado %s", async (reason) => {
    const target = await createTarget(reason);
    const { lease, owner } = await claimOne(target);
    const completed = await withTenant(workerPool, target.tenant.id, (client) =>
      completeOperationReconciliationManualReview(client, {
        ...fence(owner, lease),
        reason,
      }),
    );
    expect(completed?.operationVersion).toBe("4");
    const persisted = await bundle(target);
    expect(persisted.operation).toMatchObject({
      finalized_at: null,
      last_error_code: reason,
      remote_record_id: null,
      remote_state: null,
      status: "MANUAL_REVIEW",
    });
    expect(persisted.outbox).toMatchObject({
      delivery_status: "COMPLETED",
      last_error_code: reason,
      lease_owner: null,
      lease_token: null,
    });
    expect(persisted.transitions.at(-1)?.reason_code).toBe(reason);
  });

  it("SQL recusa estado remoto, identificador e reason fora das allowlists", async () => {
    const confirmedTarget = await createTarget("invalid-confirmed-input");
    const confirmedLease = await claimOne(confirmedTarget);
    const confirmedFence = fence(confirmedLease.owner, confirmedLease.lease);
    for (const [remoteRecordId, remoteState] of [
      [0, "CONFIRMADO"],
      [9_007_199_254_740_992, "CONFIRMADO"],
      [1, "confirmado"],
      [1, "CANCELADO"],
    ] as const) {
      await expect(
        withTenant(workerPool, confirmedTarget.tenant.id, (client) =>
          client.query(
            `select * from renave.complete_operation_reconciliation_confirmed(
               $1,$2,$3,$4,$5,$6
             )`,
            [
              confirmedFence.outboxId,
              confirmedFence.leaseOwner,
              confirmedFence.leaseToken,
              confirmedFence.operationVersion,
              remoteRecordId,
              remoteState,
            ],
          ),
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }
    expect((await bundle(confirmedTarget)).operation.status).toBe(
      "PENDING_RECONCILIATION",
    );

    const boundary = await withTenant(
      workerPool,
      confirmedTarget.tenant.id,
      (client) =>
        completeOperationReconciliationConfirmed(client, {
          ...confirmedFence,
          remoteRecordId: 9_007_199_254_740_991,
          remoteState: "FINALIZADO",
        }),
    );
    expect(boundary?.operationVersion).toBe("4");

    const manualTarget = await createTarget("invalid-manual-input");
    const manualLease = await claimOne(manualTarget);
    const manualFence = fence(manualLease.owner, manualLease.lease);
    await expect(
      withTenant(workerPool, manualTarget.tenant.id, (client) =>
        client.query(
          `select * from renave.complete_operation_reconciliation_manual_review(
             $1,$2,$3,$4,$5
           )`,
          [
            manualFence.outboxId,
            manualFence.leaseOwner,
            manualFence.leaseToken,
            manualFence.operationVersion,
            "RENAVE_RECONCILIATION_NOT_OBSERVED",
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    expect((await bundle(manualTarget)).operation.status).toBe(
      "PENDING_RECONCILIATION",
    );
  });

  it("stale owner/token/version e lease expirada não mutam", async () => {
    const target = await createTarget("stale");
    const { lease, owner } = await claimOne(target);
    const base = fence(owner, lease);
    for (const stale of [
      { ...base, leaseOwner: randomUUID() },
      { ...base, leaseToken: randomUUID() },
      { ...base, operationVersion: "999" },
    ]) {
      await expect(
        withTenant(workerPool, target.tenant.id, (client) =>
          completeOperationReconciliationConfirmed(client, {
            ...stale,
            remoteRecordId: 8,
            remoteState: "SOLICITADO",
          }),
        ),
      ).resolves.toBeNull();
    }
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at=clock_timestamp()
          where id=$1`,
        [target.outboxId],
      ),
    );
    await expect(
      withTenant(workerPool, target.tenant.id, (client) =>
        completeOperationReconciliationConfirmed(client, {
          ...base,
          remoteRecordId: 8,
          remoteState: "SOLICITADO",
        }),
      ),
    ).resolves.toBeNull();
    expect((await bundle(target)).operation.status).toBe(
      "PENDING_RECONCILIATION",
    );
  });

  it.each(["tenant", "establishment"] as const)(
    "recusa sucesso tardio se %s foi suspenso durante o GET",
    async (scope) => {
      const target = await createTarget(`suspended-${scope}`);
      const { lease, owner } = await claimOne(target);
      const input = fence(owner, lease);
      await withTenant(workerPool, target.tenant.id, (client) =>
        beginOperationReconciliation(client, input),
      );
      if (scope === "tenant") {
        await adminPool.query(
          "update renave.tenant set status='suspended' where id=$1",
          [target.tenant.id],
        );
      } else {
        await adminPool.query(
          "update renave.establishment set status='inactive' where tenant_id=$1 and id=$2",
          [target.tenant.id, target.establishment.id],
        );
      }
      try {
        await expect(
          withTenant(workerPool, target.tenant.id, (client) =>
            completeOperationReconciliationConfirmed(client, {
              ...input,
              remoteRecordId: 9,
              remoteState: "CONFIRMADO",
            }),
          ),
        ).resolves.toBeNull();
        expect((await bundle(target)).operation.status).toBe(
          "PENDING_RECONCILIATION",
        );
      } finally {
        if (scope === "tenant") {
          await adminPool.query(
            "update renave.tenant set status='active' where id=$1",
            [target.tenant.id],
          );
        } else {
          await adminPool.query(
            "update renave.establishment set status='active' where tenant_id=$1 and id=$2",
            [target.tenant.id, target.establishment.id],
          );
        }
      }
    },
  );

  it("suspensão concorrente vence após completion bloquear e preserva snapshot", async () => {
    const target = await createTarget("suspension-race");
    const { lease, owner } = await claimOne(target);
    const input = fence(owner, lease);
    const blocker = await adminPool.connect();
    const completer = await workerPool.connect();
    let blockerOpen = false;
    let completerOpen = false;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      const blockerPid = (
        await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await blocker.query(
        "update renave.tenant set status='suspended' where id=$1",
        [target.tenant.id],
      );

      await setTenant(completer, target.tenant.id);
      completerOpen = true;
      await completer.query("set local statement_timeout='10s'");
      const completerPid = (
        await completer.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const completing = completeOperationReconciliationConfirmed(completer, {
        ...input,
        remoteRecordId: 12,
        remoteState: "CONFIRMADO",
      });
      await waitForBlock(adminPool, completerPid, blockerPid);
      const before = await bundle(target);

      await blocker.query("commit");
      blockerOpen = false;
      await expect(completing).resolves.toBeNull();
      await completer.query("commit");
      completerOpen = false;
      expect(await bundle(target)).toEqual(before);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      if (completerOpen) await completer.query("rollback");
      blocker.release();
      completer.release();
      await adminPool.query(
        "update renave.tenant set status='active' where id=$1",
        [target.tenant.id],
      );
    }
  });

  it("concorrência confirmed x manual produz um único bundle", async () => {
    const target = await createTarget("race");
    const { lease, owner } = await claimOne(target);
    const input = fence(owner, lease);
    const [confirmed, manual] = await Promise.all([
      withTenant(workerPool, target.tenant.id, (client) =>
        completeOperationReconciliationConfirmed(client, {
          ...input,
          remoteRecordId: 10,
          remoteState: "TRANSFERIDO",
        }),
      ),
      withTenant(workerPool, target.tenant.id, (client) =>
        completeOperationReconciliationManualReview(client, {
          ...input,
          reason: "RENAVE_RECONCILIATION_AMBIGUOUS",
        }),
      ),
    ]);
    expect([confirmed, manual].filter(Boolean)).toHaveLength(1);
    const persisted = await bundle(target);
    expect(["CONFIRMED", "MANUAL_REVIEW"]).toContain(
      persisted.operation.status,
    );
    expect(
      persisted.transitions.filter(({ version }) => version === "4"),
    ).toHaveLength(1);
  });

  it("falha interna após operação reverte operação, transition e outbox", async () => {
    const target = await createTarget("rollback");
    const { lease, owner } = await claimOne(target);
    await migratorPool.query(`
      create function renave.test_reconciliation_transition_failure()
      returns trigger language plpgsql set search_path=pg_catalog as $$
      begin
        if new.reason_code='RENAVE_RECONCILIATION_CONFIRMED' then
          raise exception 'probe';
        end if;
        return new;
      end $$;
      create trigger test_reconciliation_transition_failure
      before insert on renave.operation_transition
      for each row execute function renave.test_reconciliation_transition_failure();
    `);
    try {
      await expect(
        withTenant(workerPool, target.tenant.id, (client) =>
          completeOperationReconciliationConfirmed(client, {
            ...fence(owner, lease),
            remoteRecordId: 11,
            remoteState: "CONFIRMADO",
          }),
        ),
      ).rejects.toThrow();
      const persisted = await bundle(target);
      expect(persisted.operation).toMatchObject({
        remote_record_id: null,
        status: "PENDING_RECONCILIATION",
        version: "3",
      });
      expect(persisted.outbox.delivery_status).toBe("LEASED");
      expect(persisted.transitions.some(({ version }) => version === "4")).toBe(
        false,
      );
    } finally {
      await migratorPool.query(
        "drop trigger test_reconciliation_transition_failure on renave.operation_transition",
      );
      await migratorPool.query(
        "drop function renave.test_reconciliation_transition_failure()",
      );
    }
  });

  it("worker sem tenant ou com tenant errado não enxerga lease", async () => {
    const target = await createTarget("isolation");
    const other = await createTarget("other-tenant");
    await expect(
      workerPool.query(
        "select * from renave.claim_operation_reconciliation_leases($1,1)",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(workerPool, other.tenant.id, (client) =>
        beginOperationReconciliation(client, {
          leaseOwner: randomUUID(),
          leaseToken: randomUUID(),
          operationVersion: target.operationVersion,
          outboxId: target.outboxId,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("completion sem tenant ou com tenant errado não muta o bundle", async () => {
    const target = await createTarget("completion-isolation");
    const other = await createTarget("completion-wrong-tenant");
    const { lease, owner } = await claimOne(target);
    const input = fence(owner, lease);
    const before = await bundle(target);

    await expect(
      workerPool.query(
        `select * from renave.complete_operation_reconciliation_confirmed(
           $1,$2,$3,$4,$5,$6
         )`,
        [
          input.outboxId,
          input.leaseOwner,
          input.leaseToken,
          input.operationVersion,
          13,
          "CONFIRMADO",
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerPool.query(
        `select * from renave.complete_operation_reconciliation_manual_review(
           $1,$2,$3,$4,$5
         )`,
        [
          input.outboxId,
          input.leaseOwner,
          input.leaseToken,
          input.operationVersion,
          "RENAVE_RECONCILIATION_AMBIGUOUS",
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(workerPool, other.tenant.id, (client) =>
        completeOperationReconciliationConfirmed(client, {
          ...input,
          remoteRecordId: 13,
          remoteState: "CONFIRMADO",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(workerPool, other.tenant.id, (client) =>
        completeOperationReconciliationManualReview(client, {
          ...input,
          reason: "RENAVE_RECONCILIATION_AMBIGUOUS",
        }),
      ),
    ).resolves.toBeNull();
    expect(await bundle(target)).toEqual(before);
  });

  it("ACL expõe somente seis rotinas exatas e zero acesso de tabela", async () => {
    const signatures = [
      "renave.claim_operation_reconciliation_leases(uuid,integer)",
      "renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)",
      "renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)",
      "renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)",
      "renave.complete_operation_reconciliation_confirmed(uuid,uuid,uuid,bigint,bigint,text)",
      "renave.complete_operation_reconciliation_manual_review(uuid,uuid,uuid,bigint,text)",
    ];
    for (const signature of signatures) {
      const privileges = await adminPool.query<{
        app: boolean;
        identity: boolean;
        maintenance: boolean;
        public: boolean;
        worker: boolean;
      }>(
        `select
           has_function_privilege('renave_app',$1,'execute') as app,
           has_function_privilege('renave_identity_app',$1,'execute') as identity,
           has_function_privilege('renave_maintenance_app',$1,'execute') as maintenance,
           has_function_privilege('public',$1,'execute') as public,
           has_function_privilege('renave_operation_worker',$1,'execute') as worker`,
        [signature],
      );
      expect(privileges.rows[0]).toEqual({
        app: false,
        identity: false,
        maintenance: false,
        public: false,
        worker: true,
      });
    }
    const tables = await adminPool.query<{ direct_acl: string }>(
      `select pg_catalog.count(*)::text as direct_acl
         from pg_catalog.pg_class tables
         join pg_catalog.pg_namespace schemas
           on schemas.oid=tables.relnamespace
         cross join lateral pg_catalog.aclexplode(tables.relacl) privileges
        where schemas.nspname='renave'
          and privileges.grantee=(
            select oid from pg_catalog.pg_roles
             where rolname='renave_operation_worker'
          )`,
    );
    expect(tables.rows[0]!.direct_acl).toBe("0");
    await expect(
      workerPool.query("select id from renave.operation limit 1"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
