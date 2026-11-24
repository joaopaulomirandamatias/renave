import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayOperation,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

interface Fixture {
  establishment: Establishment;
  operationId: string;
  tenant: Tenant;
}

interface LeaseClaim {
  lease_token: string;
  outbox_id: string;
}

interface RecoveryRow {
  operation_id: string;
  operation_version: string;
  reconcile_available_at: Date;
  reconcile_outbox_id: string;
  recovered_at: Date;
  send_outbox_id: string;
}

interface RecoveryState {
  operation_error: string | null;
  operation_status: string;
  operation_version: string;
  reconcile_available_at: Date | null;
  reconcile_attempt_count: number | null;
  reconcile_completed_at: Date | null;
  reconcile_count: string;
  reconcile_error: string | null;
  reconcile_lease_cleared: boolean | null;
  reconcile_status: string | null;
  recovery_actor: Buffer | null;
  recovery_reason: string | null;
  recovery_transitions: string;
  send_attempt_count: number;
  send_completed_at: Date | null;
  send_error: string | null;
  send_lease_cleared: boolean;
  send_status: string;
  sent_at: Date;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let fixtureCounter = 0;

const SYSTEM_ACTOR = createHash("sha256")
  .update("seu-renave:system:expired-send-recovery:v1", "utf8")
  .digest();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function fixture(label: string): Promise<Fixture> {
  fixtureCounter += 1;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Recovery ${label} ${fixtureCounter}`,
    slug: `recovery-${label}-${fixtureCounter}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Recovery ${label}`,
    }),
  );
  const input: CreateOperationInput = {
    ...operationProjectionFields(`recovery:${label}:${fixtureCounter}`),
    actorSubjectHash: digest(`actor:${label}:${fixtureCounter}`),
    correlationId: randomUUID(),
    establishmentId: establishment.id,
    idempotencyKeyDigest: digest(`idempotency:${label}:${fixtureCounter}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 0x31),
    requestCiphertext: Buffer.from(`ciphertext:${label}:${fixtureCounter}`),
    requestKeyId: "recovery-test-key",
    requestNonce: Buffer.alloc(12, 0x32),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}:${fixtureCounter}`),
    vehicleKeyDigest: digest(`vehicle:${label}:${fixtureCounter}`),
  };
  const created = await withTenant(migratorPool, tenant.id, (client) =>
    createOrReplayOperation(client, input),
  );
  return { establishment, operationId: created.operation.id, tenant };
}

async function fixtureInTenant(
  target: Fixture,
  label: string,
): Promise<Fixture> {
  fixtureCounter += 1;
  const created = await withTenant(migratorPool, target.tenant.id, (client) =>
    createOrReplayOperation(client, {
      ...operationProjectionFields(`recovery:${label}:${fixtureCounter}`),
      actorSubjectHash: digest(`actor:${label}:${fixtureCounter}`),
      correlationId: randomUUID(),
      establishmentId: target.establishment.id,
      idempotencyKeyDigest: digest(`idempotency:${label}:${fixtureCounter}`),
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      requestAuthTag: Buffer.alloc(16, 0x41),
      requestCiphertext: Buffer.from(`ciphertext:${label}:${fixtureCounter}`),
      requestKeyId: "recovery-test-key",
      requestNonce: Buffer.alloc(12, 0x42),
      requestSchemaVersion: 1,
      requestSha256: digest(`plaintext:${label}:${fixtureCounter}`),
      vehicleKeyDigest: digest(`vehicle:${label}:${fixtureCounter}`),
    }),
  );
  return { ...target, operationId: created.operation.id };
}

async function dispatch(target: Fixture): Promise<LeaseClaim> {
  const owner = randomUUID();
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const claimed = await client.query<LeaseClaim>(
      "select * from renave.claim_operation_send_leases($1, 1)",
      [owner],
    );
    const lease = claimed.rows[0]!;
    const begun = await client.query(
      "select * from renave.begin_operation_send_dispatch($1, $2, $3)",
      [lease.outbox_id, owner, lease.lease_token],
    );
    expect(begun.rows).toHaveLength(1);
    return lease;
  });
}

async function expire(tenantId: string, outboxId: string): Promise<void> {
  await withTenant(migratorPool, tenantId, (client) =>
    client.query(
      `update renave.operation_outbox
          set lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1`,
      [outboxId],
    ),
  );
}

async function recover(tenantId: string, limit = 100): Promise<RecoveryRow[]> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<RecoveryRow>(
      "select * from renave.recover_expired_operation_sends($1)",
      [limit],
    );
    return rows;
  });
}

async function state(target: Fixture): Promise<RecoveryState> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<RecoveryState>(
      `select operation.status as operation_status,
              operation.version::text as operation_version,
              operation.last_error_code as operation_error,
              operation.sent_at,
              send.delivery_status as send_status,
              send.attempt_count as send_attempt_count,
              send.last_error_code as send_error,
              send.completed_at as send_completed_at,
              send.lease_owner is null and send.lease_token is null
                and send.lease_expires_at is null as send_lease_cleared,
              reconcile.delivery_status as reconcile_status,
              reconcile.attempt_count as reconcile_attempt_count,
              reconcile.available_at as reconcile_available_at,
              reconcile.completed_at as reconcile_completed_at,
              reconcile.last_error_code as reconcile_error,
              case when reconcile.id is null then null else
                reconcile.lease_owner is null and reconcile.lease_token is null
                  and reconcile.lease_expires_at is null
              end as reconcile_lease_cleared,
              (select count(*)::text from renave.operation_outbox events
                where events.operation_id = operation.id
                  and events.event_type = 'RECONCILE') as reconcile_count,
              transition.reason_code as recovery_reason,
              transition.actor_hash as recovery_actor,
              (select count(*)::text from renave.operation_transition history
                where history.operation_id = operation.id
                  and history.reason_code = 'SEND_LEASE_EXPIRED')
                as recovery_transitions
         from renave.operation operation
         join renave.operation_outbox send
           on send.operation_id = operation.id
          and send.event_type = 'SEND_MUTATION'
         left join renave.operation_outbox reconcile
           on reconcile.operation_id = operation.id
          and reconcile.event_type = 'RECONCILE'
         left join renave.operation_transition transition
           on transition.operation_id = operation.id
          and transition.reason_code = 'SEND_LEASE_EXPIRED'
        where operation.id = $1`,
      [target.operationId],
    );
    return rows[0]!;
  });
}

async function lockTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("begin");
  await client.query("select set_config('renave.tenant_id', $1, true)", [
    tenantId,
  ]);
}

async function waitForBlock(
  observer: PoolClient,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query<{ blocked: boolean }>(
      `select $2::integer = any(
         pg_catalog.pg_blocking_pids($1::integer)
       ) as blocked`,
      [blockedPid, blockerPid],
    );
    if (rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("recovery não aguardou o lock administrativo esperado");
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 8 });
  migratorPool = createPool(urls.migrator, { max: 32 });
});

afterAll(async () => {
  await Promise.all([adminPool.end(), appPool.end(), migratorPool.end()]);
});

describe("expired SEND recovery", () => {
  it("fecha SEND, avança operação e agenda RECONCILE atomicamente", async () => {
    const target = await fixture("happy");
    const lease = await dispatch(target);
    await expire(target.tenant.id, lease.outbox_id);

    const rows = await recover(target.tenant.id);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "operation_id",
        "operation_version",
        "reconcile_available_at",
        "reconcile_outbox_id",
        "recovered_at",
        "send_outbox_id",
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(
      /cipher|nonce|auth|digest|sha256|key_id/iu,
    );
    expect(rows[0]).toMatchObject({
      operation_id: target.operationId,
      operation_version: "3",
      send_outbox_id: lease.outbox_id,
    });
    expect(rows[0]!.reconcile_available_at.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.recovered_at.getTime(),
    );

    const stored = await state(target);
    expect(stored).toMatchObject({
      operation_error: "SEND_LEASE_EXPIRED",
      operation_status: "PENDING_RECONCILIATION",
      operation_version: "3",
      reconcile_count: "1",
      reconcile_status: "READY",
      recovery_reason: "SEND_LEASE_EXPIRED",
      recovery_transitions: "1",
      send_attempt_count: 1,
      send_error: "SEND_LEASE_EXPIRED",
      send_lease_cleared: true,
      send_status: "COMPLETED",
    });
    expect(stored.send_completed_at?.getTime()).toBe(
      rows[0]!.recovered_at.getTime(),
    );
    expect(stored.reconcile_available_at?.getTime()).toBe(
      rows[0]!.reconcile_available_at.getTime(),
    );
    expect(rows[0]!.reconcile_available_at.getTime()).toBe(
      Math.max(
        rows[0]!.recovered_at.getTime(),
        stored.sent_at.getTime() + 60_000,
      ),
    );
    expect(stored.recovery_actor).toEqual(SYSTEM_ACTOR);
    await expect(recover(target.tenant.id)).resolves.toEqual([]);
  });

  it("respeita a borda temporal inclusiva e não antecipa sent_at + 60 s", async () => {
    const target = await fixture("boundary");
    const lease = await dispatch(target);
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() + interval '1 minute'
          where id = $1`,
        [lease.outbox_id],
      );
      expect(
        (
          await client.query(
            "select * from renave.recover_expired_operation_sends(1)",
          )
        ).rows,
      ).toEqual([]);
      await client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp()
          where id = $1`,
        [lease.outbox_id],
      );
    });

    const recovered = (await recover(target.tenant.id, 1))[0]!;
    expect(
      recovered.reconcile_available_at.getTime() -
        recovered.recovered_at.getTime(),
    ).toBeGreaterThanOrEqual(59_000);
  });

  it("pula SEND row-lockada e renovada sem aguardar nem mutar", async () => {
    const target = await fixture("skip-renewed-send");
    const lease = await dispatch(target);
    await expire(target.tenant.id, lease.outbox_id);
    const blocker = await migratorPool.connect();
    const recoveryClient = await migratorPool.connect();
    let blockerOpen = false;
    let recoveryOpen = false;
    try {
      await lockTenant(blocker, target.tenant.id);
      blockerOpen = true;
      await blocker.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() + interval '5 minutes'
          where id = $1`,
        [lease.outbox_id],
      );

      await lockTenant(recoveryClient, target.tenant.id);
      recoveryOpen = true;
      // A row lockada deve ser pulada pelo SKIP LOCKED. O timeout curto prova
      // que o recovery não esperou a transação que renovou a lease.
      await recoveryClient.query("set local statement_timeout = '1s'");
      const recovered = await recoveryClient.query<RecoveryRow>(
        "select * from renave.recover_expired_operation_sends(1)",
      );
      expect(recovered.rows).toEqual([]);
      await recoveryClient.query("commit");
      recoveryOpen = false;

      await blocker.query("commit");
      blockerOpen = false;
      expect(await state(target)).toMatchObject({
        operation_status: "SENT",
        reconcile_count: "0",
        send_status: "LEASED",
      });
      const futureLease = await withTenant(
        migratorPool,
        target.tenant.id,
        (client) =>
          client.query<{ future: boolean }>(
            `select lease_expires_at > clock_timestamp() as future
               from renave.operation_outbox
              where id = $1`,
            [lease.outbox_id],
          ),
      );
      expect(futureLease.rows[0]!.future).toBe(true);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      if (recoveryOpen) await recoveryClient.query("rollback");
      blocker.release();
      recoveryClient.release();
    }
  });

  it("reutiliza somente RECONCILE COMPLETED e preserva a unique event", async () => {
    const target = await fixture("cycle");
    const firstLease = await dispatch(target);
    await expire(target.tenant.id, firstLease.outbox_id);
    const first = (await recover(target.tenant.id))[0]!;
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox
            set delivery_status = 'COMPLETED', completed_at = clock_timestamp(),
                available_at = clock_timestamp(), attempt_count = 7,
                last_error_code = 'OLD_RECONCILE',
                updated_at = clock_timestamp()
          where id = $1`,
        [first.reconcile_outbox_id],
      );
      await client.query(
        `update renave.operation
            set status = 'PENDING_SEND', version = version + 1,
                last_error_code = null, updated_at = clock_timestamp()
          where id = $1`,
        [target.operationId],
      );
      await client.query(
        `update renave.operation_outbox
            set delivery_status = 'READY', available_at = clock_timestamp(),
                completed_at = null, last_error_code = null,
                updated_at = clock_timestamp()
          where id = $1`,
        [firstLease.outbox_id],
      );
    });
    const secondLease = await dispatch(target);
    await expire(target.tenant.id, secondLease.outbox_id);

    const second = (await recover(target.tenant.id))[0]!;

    expect(second.reconcile_outbox_id).toBe(first.reconcile_outbox_id);
    const after = await state(target);
    expect(after).toMatchObject({
      reconcile_attempt_count: 7,
      reconcile_completed_at: null,
      reconcile_count: "1",
      reconcile_error: null,
      reconcile_lease_cleared: true,
      reconcile_status: "READY",
    });
    expect(after.reconcile_available_at?.getTime()).toBe(
      second.reconcile_available_at.getTime(),
    );
  });

  it.each(["READY", "LEASED"] as const)(
    "falha fechado quando RECONCILE já está %s",
    async (status) => {
      const target = await fixture(`conflict-${status.toLowerCase()}`);
      const lease = await dispatch(target);
      await expire(target.tenant.id, lease.outbox_id);
      await withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `insert into renave.operation_outbox (
             tenant_id, operation_id, event_type, delivery_status,
             attempt_count, lease_owner, lease_token, lease_expires_at
           ) values (
             $1, $2, 'RECONCILE', $3,
             case when $3 = 'LEASED' then 1 else 0 end,
             case when $3 = 'LEASED' then $4::uuid else null end,
             case when $3 = 'LEASED' then $5::uuid else null end,
             case when $3 = 'LEASED'
               then clock_timestamp() + interval '5 minutes' else null end
           )`,
          [
            target.tenant.id,
            target.operationId,
            status,
            randomUUID(),
            randomUUID(),
          ],
        ),
      );
      const before = await state(target);

      await expect(recover(target.tenant.id)).rejects.toMatchObject({
        code: "23000",
      });
      expect(await state(target)).toEqual(before);
    },
  );

  it("recupera uma vez sob concorrência", async () => {
    const concurrent = await fixture("concurrent");
    const concurrentLease = await dispatch(concurrent);
    await expire(concurrent.tenant.id, concurrentLease.outbox_id);
    const attempts = await Promise.all(
      Array.from({ length: 24 }, () => recover(concurrent.tenant.id, 1)),
    );
    expect(attempts.flat()).toHaveLength(1);
  });

  it("preserva ordem, respeita lote e drena linha ignorada por SKIP LOCKED", async () => {
    const first = await fixture("ordered-a");
    const second = await fixtureInTenant(first, "ordered-b");
    const third = await fixtureInTenant(first, "ordered-c");
    const leases = await Promise.all([
      dispatch(first),
      dispatch(second),
      dispatch(third),
    ]);
    await withTenant(migratorPool, first.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at = case id
              when $1 then clock_timestamp() - interval '30 seconds'
              when $2 then clock_timestamp() - interval '20 seconds'
              when $3 then clock_timestamp() - interval '10 seconds'
              else lease_expires_at
            end
          where id = any($4::uuid[])`,
        [
          leases[0]!.outbox_id,
          leases[1]!.outbox_id,
          leases[2]!.outbox_id,
          leases.map((lease) => lease.outbox_id),
        ],
      ),
    );

    const firstBatch = await recover(first.tenant.id, 2);
    expect(firstBatch.map((row) => row.send_outbox_id)).toEqual([
      leases[0]!.outbox_id,
      leases[1]!.outbox_id,
    ]);
    const secondBatch = await recover(first.tenant.id, 2);
    expect(secondBatch.map((row) => row.send_outbox_id)).toEqual([
      leases[2]!.outbox_id,
    ]);
    await expect(recover(first.tenant.id, 2)).resolves.toEqual([]);

    const skipA = await fixtureInTenant(first, "skip-a");
    const skipB = await fixtureInTenant(first, "skip-b");
    const firstLease = await dispatch(skipA);
    const secondLease = await dispatch(skipB);
    await Promise.all([
      expire(first.tenant.id, firstLease.outbox_id),
      expire(first.tenant.id, secondLease.outbox_id),
    ]);
    const ordered = await withTenant(migratorPool, first.tenant.id, (client) =>
      client.query<{ id: string }>(
        `select id from renave.operation_outbox
          where id = any($1::uuid[])
          order by lease_expires_at, created_at, id`,
        [[firstLease.outbox_id, secondLease.outbox_id]],
      ),
    );
    const lockedId = ordered.rows[0]!.id;
    const locker = await migratorPool.connect();
    try {
      await lockTenant(locker, first.tenant.id);
      await locker.query(
        "select id from renave.operation_outbox where id=$1 for update",
        [lockedId],
      );
      const recovered = await withTenant(
        migratorPool,
        first.tenant.id,
        async (client) => {
          await client.query("set local statement_timeout = '2s'");
          const { rows } = await client.query<RecoveryRow>(
            "select * from renave.recover_expired_operation_sends(1)",
          );
          return rows;
        },
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.send_outbox_id).not.toBe(lockedId);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
    const drained = await recover(first.tenant.id, 1);
    expect(drained.map((row) => row.send_outbox_id)).toEqual([lockedId]);
  });

  it("rollback restaura tudo e token antigo não controla SEND concluído", async () => {
    const target = await fixture("rollback");
    const owner = randomUUID();
    const lease = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => {
        const claim = await client.query<LeaseClaim>(
          "select * from renave.claim_operation_send_leases($1,1)",
          [owner],
        );
        await client.query(
          "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
          [claim.rows[0]!.outbox_id, owner, claim.rows[0]!.lease_token],
        );
        return claim.rows[0]!;
      },
    );
    await expire(target.tenant.id, lease.outbox_id);
    const before = await state(target);
    await expect(
      withTenant(migratorPool, target.tenant.id, async (client) => {
        expect(
          (
            await client.query(
              "select * from renave.recover_expired_operation_sends(1)",
            )
          ).rows,
        ).toHaveLength(1);
        throw new Error("rollback esperado");
      }),
    ).rejects.toThrow("rollback esperado");
    expect(await state(target)).toEqual(before);
    await recover(target.tenant.id);
    const stale = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => ({
        release: (
          await client.query<{ value: boolean }>(
            "select renave.release_operation_send_lease($1,$2,$3,0) as value",
            [lease.outbox_id, owner, lease.lease_token],
          )
        ).rows[0]!.value,
        renew: (
          await client.query<{ value: boolean }>(
            "select renave.renew_operation_send_lease($1,$2,$3) as value",
            [lease.outbox_id, owner, lease.lease_token],
          )
        ).rows[0]!.value,
      }),
    );
    expect(stale).toEqual({ release: false, renew: false });
    const staleDispatch = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query(
          "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
          [lease.outbox_id, owner, lease.lease_token],
        ),
    );
    expect(staleDispatch.rows).toEqual([]);
    const noSendReclaim = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query("select * from renave.claim_operation_send_leases($1,1)", [
          randomUUID(),
        ]),
    );
    expect(noSendReclaim.rows).toEqual([]);
  });

  it("falha interna na transition reverte operação, SEND e RECONCILE", async () => {
    const target = await fixture("trigger-rollback");
    const lease = await dispatch(target);
    await expire(target.tenant.id, lease.outbox_id);
    const before = await state(target);
    await adminPool.query(
      `create function renave.reject_expired_send_recovery_probe()
       returns trigger language plpgsql set search_path = pg_catalog as $$
       begin
         if new.reason_code = 'SEND_LEASE_EXPIRED' then
           raise exception 'probe';
         end if;
         return new;
       end $$`,
    );
    await adminPool.query(
      `create trigger reject_expired_send_recovery_probe
       before insert on renave.operation_transition
       for each row execute function renave.reject_expired_send_recovery_probe()`,
    );
    try {
      await expect(recover(target.tenant.id, 1)).rejects.toThrow();
    } finally {
      await adminPool.query(
        "drop trigger reject_expired_send_recovery_probe on renave.operation_transition",
      );
      await adminPool.query(
        "drop function renave.reject_expired_send_recovery_probe()",
      );
    }
    expect(await state(target)).toEqual(before);
  });

  it("isola tenants e recupera mesmo com tenant e estabelecimento suspensos", async () => {
    const target = await fixture("suspended");
    const other = await fixture("other-tenant");
    const lease = await dispatch(target);
    await expire(target.tenant.id, lease.outbox_id);
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query("update renave.tenant set status='suspended'");
      await client.query(
        "update renave.establishment set status='inactive' where id=$1",
        [target.establishment.id],
      );
    });
    expect(await recover(other.tenant.id)).toEqual([]);
    expect(await recover(target.tenant.id)).toHaveLength(1);
  });

  it.each(["tenant", "establishment"] as const)(
    "serializa mudança administrativa de %s sem exigir status ativo",
    async (targetKind) => {
      const target = await fixture(`admin-lock-${targetKind}`);
      const lease = await dispatch(target);
      await expire(target.tenant.id, lease.outbox_id);
      const admin = await adminPool.connect();
      const recoveryClient = await migratorPool.connect();
      let adminOpen = false;
      let recoveryOpen = false;
      try {
        await admin.query("begin");
        adminOpen = true;
        const adminPid = (
          await admin.query<{ pid: number }>(
            "select pg_catalog.pg_backend_pid() as pid",
          )
        ).rows[0]!.pid;
        if (targetKind === "tenant") {
          await admin.query(
            "update renave.tenant set status='suspended' where id=$1",
            [target.tenant.id],
          );
        } else {
          await admin.query(
            "update renave.establishment set status='inactive' where id=$1",
            [target.establishment.id],
          );
        }

        await lockTenant(recoveryClient, target.tenant.id);
        recoveryOpen = true;
        const recoveryPid = (
          await recoveryClient.query<{ pid: number }>(
            "select pg_catalog.pg_backend_pid() as pid",
          )
        ).rows[0]!.pid;
        const recovering = recoveryClient.query<RecoveryRow>(
          "select * from renave.recover_expired_operation_sends(1)",
        );
        await waitForBlock(admin, recoveryPid, adminPid);
        await admin.query("commit");
        adminOpen = false;
        expect((await recovering).rows).toHaveLength(1);
        await recoveryClient.query("commit");
        recoveryOpen = false;
      } finally {
        if (adminOpen) await admin.query("rollback");
        if (recoveryOpen) await recoveryClient.query("rollback");
        admin.release();
        recoveryClient.release();
      }
    },
  );

  it("permanece owner-only e valida tenant/limite", async () => {
    await expect(
      migratorPool.query(
        "select * from renave.recover_expired_operation_sends(1)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query("select * from renave.recover_expired_operation_sends(1)"),
    ).rejects.toMatchObject({ code: "42501" });
    const target = await fixture("invalid-limit");
    for (const limit of [-1, 0, 101]) {
      await expect(recover(target.tenant.id, limit)).rejects.toMatchObject({
        code: "22023",
      });
    }
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.recover_expired_operation_sends(null)",
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const { rows } = await adminPool.query<{
      app: boolean;
      identity: boolean;
      maintenance: boolean;
      migrator: boolean;
      public: boolean;
    }>(
      `select
         has_function_privilege('renave_app',
           'renave.recover_expired_operation_sends(integer)', 'execute') as app,
         has_function_privilege('renave_identity_app',
           'renave.recover_expired_operation_sends(integer)', 'execute') as identity,
         has_function_privilege('renave_maintenance_app',
           'renave.recover_expired_operation_sends(integer)', 'execute') as maintenance,
         has_function_privilege('renave_migrator',
           'renave.recover_expired_operation_sends(integer)', 'execute') as migrator,
         has_function_privilege('public',
           'renave.recover_expired_operation_sends(integer)', 'execute') as public`,
    );
    expect(rows[0]).toEqual({
      app: false,
      identity: false,
      maintenance: false,
      migrator: true,
      public: false,
    });
  });
});
