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

interface Dispatch {
  leaseExpiresAt: Date;
  operationVersion: string;
  outboxId: string;
  owner: string;
  token: string;
}

interface CompletionRow {
  completed_at: Date;
  operation_id: string;
  operation_version: string;
  send_outbox_id: string;
}

interface UnknownRow extends CompletionRow {
  reconcile_available_at: Date;
  reconcile_outbox_id: string;
}

interface CompletionState {
  actor: Buffer | null;
  finalized_at: Date | null;
  immutable_fingerprint: string;
  operation_error: string | null;
  operation_status: string;
  operation_version: string;
  reconcile_attempt_count: number | null;
  reconcile_available_at: Date | null;
  reconcile_completed_at: Date | null;
  reconcile_count: string;
  reconcile_error: string | null;
  reconcile_lease_cleared: boolean | null;
  reconcile_status: string | null;
  remote_record_id: string | null;
  remote_state: string | null;
  send_completed_at: Date | null;
  send_error: string | null;
  send_lease_cleared: boolean;
  send_status: string;
  sent_at: Date;
  transition_count: string;
  transition_reason: string | null;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let sequence = 0;

const SYSTEM_ACTOR = createHash("sha256")
  .update("seu-renave:system:send-outcome:v1", "utf8")
  .digest();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function fixture(label: string): Promise<Fixture> {
  sequence += 1;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Completion ${label} ${sequence}`,
    slug: `completion-${sequence}`,
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
    requestAuthTag: Buffer.alloc(16, 0x51),
    requestCiphertext: Buffer.from(`ciphertext:${label}:${sequence}`),
    requestKeyId: "completion-test-key",
    requestNonce: Buffer.alloc(12, 0x52),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}:${sequence}`),
    vehicleKeyDigest: digest(`vehicle:${label}:${sequence}`),
  };
  const created = await withTenant(migratorPool, tenant.id, (client) =>
    createOrReplayOperation(client, input),
  );
  return { establishment, operationId: created.operation.id, tenant };
}

async function begin(target: Fixture): Promise<Dispatch> {
  const owner = randomUUID();
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const claimed = await client.query<{
      lease_expires_at: Date;
      lease_token: string;
      outbox_id: string;
    }>("select * from renave.claim_operation_send_leases($1,1)", [owner]);
    const lease = claimed.rows[0]!;
    const dispatched = await client.query<{
      operation_version: string;
    }>("select * from renave.begin_operation_send_dispatch($1,$2,$3)", [
      lease.outbox_id,
      owner,
      lease.lease_token,
    ]);
    expect(dispatched.rows).toHaveLength(1);
    return {
      leaseExpiresAt: lease.lease_expires_at,
      operationVersion: dispatched.rows[0]!.operation_version,
      outboxId: lease.outbox_id,
      owner,
      token: lease.lease_token,
    };
  });
}

async function completeConfirmed(
  target: Fixture,
  dispatch: Dispatch,
  overrides: Partial<Dispatch> = {},
  remoteRecordId: number | bigint = 77,
  remoteState = "SOLICITADO",
): Promise<CompletionRow[]> {
  const fence = { ...dispatch, ...overrides };
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<CompletionRow>(
          "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,$5,$6)",
          [
            fence.outboxId,
            fence.owner,
            fence.token,
            fence.operationVersion,
            remoteRecordId,
            remoteState,
          ],
        )
      ).rows,
  );
}

async function completeRejected(
  target: Fixture,
  dispatch: Dispatch,
  status = 422,
): Promise<CompletionRow[]> {
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<CompletionRow>(
          "select * from renave.complete_operation_send_rejected($1,$2,$3,$4,$5)",
          [
            dispatch.outboxId,
            dispatch.owner,
            dispatch.token,
            dispatch.operationVersion,
            status,
          ],
        )
      ).rows,
  );
}

async function completeUnknown(
  target: Fixture,
  dispatch: Dispatch,
): Promise<UnknownRow[]> {
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<UnknownRow>(
          "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
          [
            dispatch.outboxId,
            dispatch.owner,
            dispatch.token,
            dispatch.operationVersion,
          ],
        )
      ).rows,
  );
}

async function recover(target: Fixture): Promise<unknown[]> {
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query(
          "select * from renave.recover_expired_operation_sends(1)",
        )
      ).rows,
  );
}

async function state(target: Fixture): Promise<CompletionState> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const result = await client.query<CompletionState>(
      `select operation.status as operation_status,
              operation.version::text as operation_version,
              operation.sent_at, operation.finalized_at,
              operation.last_error_code as operation_error,
              operation.remote_record_id::text, operation.remote_state,
              pg_catalog.encode(pg_catalog.sha256(
                pg_catalog.convert_to(
                  operation.sent_at::text || operation.correlation_id::text ||
                  operation.request_key_id ||
                  operation.request_schema_version::text ||
                  operation.request_size::text,
                  'UTF8'
                ) || operation.idempotency_key_digest ||
                operation.vehicle_key_digest || operation.actor_subject_hash ||
                operation.request_ciphertext || operation.request_nonce ||
                operation.request_auth_tag || operation.request_sha256
              ), 'hex') as immutable_fingerprint,
              send.delivery_status as send_status,
              send.last_error_code as send_error,
              send.completed_at as send_completed_at,
              send.lease_owner is null and send.lease_token is null
                and send.lease_expires_at is null as send_lease_cleared,
              reconcile.delivery_status as reconcile_status,
              reconcile.available_at as reconcile_available_at,
              reconcile.attempt_count as reconcile_attempt_count,
              reconcile.completed_at as reconcile_completed_at,
              reconcile.last_error_code as reconcile_error,
              case when reconcile.id is null then null else
                reconcile.lease_owner is null and reconcile.lease_token is null
                  and reconcile.lease_expires_at is null
              end as reconcile_lease_cleared,
              (select count(*)::text from renave.operation_outbox events
                where events.operation_id=operation.id
                  and events.event_type='RECONCILE') as reconcile_count,
              transition.reason_code as transition_reason,
              transition.actor_hash as actor,
              (select count(*)::text from renave.operation_transition history
                where history.operation_id=operation.id) as transition_count
         from renave.operation operation
         join renave.operation_outbox send
           on send.operation_id=operation.id and send.event_type='SEND_MUTATION'
         left join renave.operation_outbox reconcile
           on reconcile.operation_id=operation.id
          and reconcile.event_type='RECONCILE'
         left join renave.operation_transition transition
           on transition.operation_id=operation.id
          and transition.version=operation.version
        where operation.id=$1`,
      [target.operationId],
    );
    return result.rows[0]!;
  });
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("begin");
  await client.query("select set_config('renave.tenant_id',$1,true)", [
    tenantId,
  ]);
}

async function waitForBlock(
  observer: PoolClient,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      "select $2::integer=any(pg_catalog.pg_blocking_pids($1::integer)) as blocked",
      [blockedPid, blockerPid],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("completion não aguardou o lock administrativo");
}

async function waitUntilDatabaseTime(instant: Date): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await adminPool.query<{ reached: boolean }>(
      "select clock_timestamp() >= $1::timestamptz as reached",
      [instant],
    );
    if (result.rows[0]!.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("o relógio do banco não alcançou a expiração controlada");
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 6 });
  migratorPool = createPool(urls.migrator, { max: 24 });
});

afterAll(async () => {
  await Promise.all([adminPool.end(), appPool.end(), migratorPool.end()]);
});

describe("operation SEND completion", () => {
  it("confirma com retorno mínimo, remoto validado e envelope imutável", async () => {
    const target = await fixture("confirmed");
    const dispatch = await begin(target);
    const before = await state(target);
    const rows = await completeConfirmed(target, dispatch);

    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "completed_at",
        "operation_id",
        "operation_version",
        "send_outbox_id",
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      operation_id: target.operationId,
      operation_version: "3",
      send_outbox_id: dispatch.outboxId,
    });
    expect(await state(target)).toMatchObject({
      actor: SYSTEM_ACTOR,
      operation_error: null,
      operation_status: "CONFIRMED",
      operation_version: "3",
      reconcile_count: "0",
      remote_record_id: "77",
      remote_state: "SOLICITADO",
      immutable_fingerprint: before.immutable_fingerprint,
      send_error: null,
      send_lease_cleared: true,
      send_status: "COMPLETED",
      transition_count: "3",
      transition_reason: "RENAVE_CONFIRMED",
    });
  });

  it("registra rejeição somente por HTTP 4xx derivado", async () => {
    const target = await fixture("rejected");
    const dispatch = await begin(target);
    expect(await completeRejected(target, dispatch, 409)).toHaveLength(1);
    expect(await state(target)).toMatchObject({
      actor: SYSTEM_ACTOR,
      operation_error: "RENAVE_HTTP_409",
      operation_status: "REJECTED",
      reconcile_count: "0",
      remote_record_id: null,
      remote_state: null,
      send_error: "RENAVE_HTTP_409",
      send_lease_cleared: true,
      send_status: "COMPLETED",
      transition_reason: "RENAVE_REJECTED",
    });
  });

  it.each([
    ["SOLICITADO", 1],
    ["TRANSFERIDO", 2],
    ["CONFIRMADO", 3],
    ["FINALIZADO", 9_007_199_254_740_991n],
  ] as const)(
    "aceita estado remoto %s e os limites seguros do identificador",
    async (remoteState, remoteRecordId) => {
      const target = await fixture(`remote-${remoteState.toLowerCase()}`);
      const dispatch = await begin(target);
      expect(
        await completeConfirmed(
          target,
          dispatch,
          {},
          remoteRecordId,
          remoteState,
        ),
      ).toHaveLength(1);
      expect(await state(target)).toMatchObject({
        remote_record_id: remoteRecordId.toString(),
        remote_state: remoteState,
      });
    },
  );

  it.each([400, 499])(
    "aceita a borda HTTP %i como rejeição conhecida",
    async (httpStatus) => {
      const target = await fixture(`http-${httpStatus}`);
      const dispatch = await begin(target);
      expect(await completeRejected(target, dispatch, httpStatus)).toHaveLength(
        1,
      );
      expect(await state(target)).toMatchObject({
        operation_error: `RENAVE_HTTP_${httpStatus}`,
        operation_status: "REJECTED",
      });
    },
  );

  it("encaminha outcome desconhecido para reconciliação na borda segura", async () => {
    const target = await fixture("unknown");
    const dispatch = await begin(target);
    const rows = await completeUnknown(target, dispatch);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "completed_at",
        "operation_id",
        "operation_version",
        "reconcile_available_at",
        "reconcile_outbox_id",
        "send_outbox_id",
      ].sort(),
    );
    const after = await state(target);
    expect(after).toMatchObject({
      actor: SYSTEM_ACTOR,
      finalized_at: null,
      operation_error: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
      operation_status: "PENDING_RECONCILIATION",
      reconcile_count: "1",
      reconcile_error: null,
      reconcile_lease_cleared: true,
      reconcile_status: "READY",
      send_error: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
      send_lease_cleared: true,
      send_status: "COMPLETED",
      transition_reason: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(rows[0]!.reconcile_available_at.getTime()).toBe(
      after.reconcile_available_at!.getTime(),
    );
    expect(rows[0]!.reconcile_available_at.getTime()).toBeGreaterThanOrEqual(
      after.sent_at.getTime() + 60_000,
    );
  });

  it("recusa parâmetros inválidos antes de tocar o fence", async () => {
    const target = await fixture("invalid");
    const dispatch = await begin(target);
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,$5,$6)",
          [dispatch.outboxId, dispatch.owner, dispatch.token, 0, 0, "INVALIDO"],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      completeConfirmed(target, dispatch, {}, 0, "SOLICITADO"),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      completeConfirmed(target, dispatch, {}, 1, "INVALIDO"),
    ).rejects.toMatchObject({ code: "22023" });
    for (const status of [399, 500]) {
      await expect(
        completeRejected(target, dispatch, status),
      ).rejects.toMatchObject({ code: "22023" });
    }
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,$5,$6)",
          [
            dispatch.outboxId,
            dispatch.owner,
            dispatch.token,
            dispatch.operationVersion,
            9_007_199_254_740_992n,
            "SOLICITADO",
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      migratorPool.query(
        "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
        [
          dispatch.outboxId,
          dispatch.owner,
          dispatch.token,
          dispatch.operationVersion,
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await state(target)).operation_status).toBe("SENT");
  });

  it("owner, token e versão stale retornam vazio sem mutação", async () => {
    for (const [label, overrides] of [
      ["owner", { owner: randomUUID() }],
      ["token", { token: randomUUID() }],
      ["version", { operationVersion: "1" }],
    ] as const) {
      const target = await fixture(`stale-${label}`);
      const dispatch = await begin(target);
      const before = await state(target);
      await expect(
        completeConfirmed(target, dispatch, overrides),
      ).resolves.toEqual([]);
      expect(await state(target)).toEqual(before);
    }
  });

  it("lease expirada, inclusive na igualdade, não autoriza conclusão tardia", async () => {
    const target = await fixture("boundary");
    const dispatch = await begin(target);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        "update renave.operation_outbox set lease_expires_at=clock_timestamp() where id=$1",
        [dispatch.outboxId],
      ),
    );
    const before = await state(target);
    await expect(completeUnknown(target, dispatch)).resolves.toEqual([]);
    expect(await state(target)).toEqual(before);
  });

  it("somente um desfecho vence sob concorrência mista", async () => {
    const target = await fixture("mixed-race");
    const dispatch = await begin(target);
    const outcomes = await Promise.all([
      completeConfirmed(target, dispatch),
      completeRejected(target, dispatch),
      completeUnknown(target, dispatch),
    ]);
    const winner = outcomes.findIndex((outcome) => outcome.length === 1);
    expect(outcomes.filter((outcome) => outcome.length === 1)).toHaveLength(1);
    const after = await state(target);
    const expectedBundles = [
      {
        operation_error: null,
        operation_status: "CONFIRMED",
        reconcile_count: "0",
        remote_record_id: "77",
        remote_state: "SOLICITADO",
        send_error: null,
        transition_reason: "RENAVE_CONFIRMED",
      },
      {
        operation_error: "RENAVE_HTTP_422",
        operation_status: "REJECTED",
        reconcile_count: "0",
        remote_record_id: null,
        remote_state: null,
        send_error: "RENAVE_HTTP_422",
        transition_reason: "RENAVE_REJECTED",
      },
      {
        operation_error: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        operation_status: "PENDING_RECONCILIATION",
        reconcile_count: "1",
        reconcile_status: "READY",
        remote_record_id: null,
        remote_state: null,
        send_error: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        transition_reason: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
      },
    ];
    expect(after).toMatchObject({
      ...expectedBundles[winner]!,
      send_lease_cleared: true,
      send_status: "COMPLETED",
      transition_count: "3",
    });
  });

  it("revalida lease após bloquear SEND e aguardar lock posterior", async () => {
    const target = await fixture("expiry-after-send-lock");
    const dispatch = await begin(target);
    const leaseExpiry = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) =>
        (
          await client.query<{ lease_expires_at: Date }>(
            `update renave.operation_outbox
                set lease_expires_at=clock_timestamp()+interval '3 seconds'
              where id=$1 returning lease_expires_at`,
            [dispatch.outboxId],
          )
        ).rows[0]!.lease_expires_at,
    );
    const admin = await adminPool.connect();
    const completer = await migratorPool.connect();
    let adminOpen = false;
    let completerOpen = false;
    try {
      await admin.query("begin");
      adminOpen = true;
      const adminPid = (
        await admin.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await admin.query(
        "update renave.tenant set status='suspended' where id=$1",
        [target.tenant.id],
      );

      await setTenant(completer, target.tenant.id);
      completerOpen = true;
      await completer.query("set local statement_timeout='10s'");
      const completerPid = (
        await completer.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const completing = completer.query(
        "select * from renave.complete_operation_send_rejected($1,$2,$3,$4,422)",
        [
          dispatch.outboxId,
          dispatch.owner,
          dispatch.token,
          dispatch.operationVersion,
        ],
      );
      await waitForBlock(admin, completerPid, adminPid);
      const beforeExpiry = await adminPool.query<{
        before_expiry: boolean;
        observed_at: Date;
      }>(
        `select clock_timestamp() as observed_at,
                clock_timestamp() < $1::timestamptz as before_expiry`,
        [leaseExpiry],
      );
      expect(beforeExpiry.rows[0]!.before_expiry).toBe(true);
      expect(beforeExpiry.rows[0]!.observed_at.getTime()).toBeLessThan(
        leaseExpiry.getTime(),
      );
      await waitUntilDatabaseTime(leaseExpiry);

      // A completion já possui a SEND e aguarda o tenant. Recovery deve
      // ignorar a row lockada, sem bloquear apesar de a lease estar expirada.
      const skipped = await withTenant(
        migratorPool,
        target.tenant.id,
        async (client) => {
          await client.query("set local statement_timeout='1s'");
          return (
            await client.query(
              "select * from renave.recover_expired_operation_sends(1)",
            )
          ).rows;
        },
      );
      expect(skipped).toEqual([]);

      await admin.query("commit");
      adminOpen = false;
      expect((await completing).rows).toEqual([]);
      await completer.query("commit");
      completerOpen = false;
    } finally {
      if (adminOpen) await admin.query("rollback");
      if (completerOpen) await completer.query("rollback");
      admin.release();
      completer.release();
    }

    expect(await recover(target)).toHaveLength(1);
    expect(await state(target)).toMatchObject({
      operation_status: "PENDING_RECONCILIATION",
      reconcile_count: "1",
      send_status: "COMPLETED",
      transition_reason: "SEND_LEASE_EXPIRED",
    });
  });

  it("corrida simultânea em lease expirada converge e permite drain", async () => {
    const target = await fixture("expired-race");
    const dispatch = await begin(target);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at=clock_timestamp()-interval '1 ms'
          where id=$1`,
        [dispatch.outboxId],
      ),
    );

    const [completionRows, recoveryRows] = await Promise.all([
      completeUnknown(target, dispatch),
      recover(target),
    ]);
    expect(completionRows).toEqual([]);
    expect(recoveryRows.length).toBeLessThanOrEqual(1);
    const drained = recoveryRows.length === 0 ? await recover(target) : [];
    expect([...recoveryRows, ...drained]).toHaveLength(1);
    await expect(recover(target)).resolves.toEqual([]);
    expect(await state(target)).toMatchObject({
      operation_error: "SEND_LEASE_EXPIRED",
      operation_status: "PENDING_RECONCILIATION",
      reconcile_count: "1",
      reconcile_status: "READY",
      send_error: "SEND_LEASE_EXPIRED",
      send_status: "COMPLETED",
      transition_count: "3",
      transition_reason: "SEND_LEASE_EXPIRED",
    });
  });

  it("rollback externo e falha interna preservam toda a unidade atômica", async () => {
    const external = await fixture("external-rollback");
    const externalDispatch = await begin(external);
    const before = await state(external);
    await expect(
      withTenant(migratorPool, external.tenant.id, async (client) => {
        const result = await client.query(
          "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,$5,$6)",
          [
            externalDispatch.outboxId,
            externalDispatch.owner,
            externalDispatch.token,
            externalDispatch.operationVersion,
            91,
            "CONFIRMADO",
          ],
        );
        expect(result.rows).toHaveLength(1);
        throw new Error("rollback esperado");
      }),
    ).rejects.toThrow("rollback esperado");
    expect(await state(external)).toEqual(before);

    const internal = await fixture("internal-rollback");
    const internalDispatch = await begin(internal);
    const internalBefore = await state(internal);
    await adminPool.query(
      `create function renave.reject_send_completion_probe()
       returns trigger language plpgsql set search_path=pg_catalog as $$
       begin
         if new.reason_code='RENAVE_REJECTED' then raise exception 'probe'; end if;
         return new;
       end $$`,
    );
    await adminPool.query(
      `create trigger reject_send_completion_probe
       before insert on renave.operation_transition for each row
       execute function renave.reject_send_completion_probe()`,
    );
    try {
      await expect(
        completeRejected(internal, internalDispatch),
      ).rejects.toThrow();
    } finally {
      await adminPool.query(
        "drop trigger reject_send_completion_probe on renave.operation_transition",
      );
      await adminPool.query(
        "drop function renave.reject_send_completion_probe()",
      );
    }
    expect(await state(internal)).toEqual(internalBefore);
  });

  it.each(["INSERT", "UPDATE"] as const)(
    "falha ao %s RECONCILE reverte UNKNOWN depois das mutações anteriores",
    async (probeOperation) => {
      const target = await fixture(`unknown-rollback-${probeOperation}`);
      let dispatch = await begin(target);
      if (probeOperation === "UPDATE") {
        const first = (await completeUnknown(target, dispatch))[0]!;
        await withTenant(migratorPool, target.tenant.id, async (client) => {
          await client.query(
            `update renave.operation_outbox
                set delivery_status='COMPLETED',
                    completed_at=clock_timestamp(), updated_at=clock_timestamp()
              where id=$1`,
            [first.reconcile_outbox_id],
          );
          await client.query(
            `update renave.operation
                set status='PENDING_SEND', version=version+1,
                    last_error_code=null, updated_at=clock_timestamp()
              where id=$1`,
            [target.operationId],
          );
          await client.query(
            `update renave.operation_outbox
                set delivery_status='READY', available_at=clock_timestamp(),
                    completed_at=null, last_error_code=null,
                    updated_at=clock_timestamp()
              where id=$1`,
            [dispatch.outboxId],
          );
        });
        dispatch = await begin(target);
      }
      const before = await state(target);

      await adminPool.query(
        `create function renave.reject_reconcile_write_probe()
         returns trigger language plpgsql set search_path=pg_catalog as $$
         begin
           if new.event_type='RECONCILE' and tg_op='${probeOperation}' then
             raise exception 'reconcile probe';
           end if;
           return new;
         end $$`,
      );
      await adminPool.query(
        `create trigger reject_reconcile_write_probe
         before insert or update on renave.operation_outbox for each row
         execute function renave.reject_reconcile_write_probe()`,
      );
      try {
        await expect(completeUnknown(target, dispatch)).rejects.toThrow(
          "reconcile probe",
        );
      } finally {
        await adminPool.query(
          "drop trigger reject_reconcile_write_probe on renave.operation_outbox",
        );
        await adminPool.query(
          "drop function renave.reject_reconcile_write_probe()",
        );
      }
      expect(await state(target)).toEqual(before);
    },
  );

  it("reativa somente RECONCILE COMPLETED e preserva attempt_count", async () => {
    const target = await fixture("reactivate");
    const firstDispatch = await begin(target);
    const first = (await completeUnknown(target, firstDispatch))[0]!;
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox set delivery_status='COMPLETED',
          completed_at=clock_timestamp(), attempt_count=7,
          last_error_code='OLD_ERROR', updated_at=clock_timestamp()
          where id=$1`,
        [first.reconcile_outbox_id],
      );
      await client.query(
        `update renave.operation set status='PENDING_SEND', version=version+1,
          last_error_code=null, updated_at=clock_timestamp() where id=$1`,
        [target.operationId],
      );
      await client.query(
        `update renave.operation_outbox set delivery_status='READY',
          available_at=clock_timestamp(), completed_at=null,
          last_error_code=null, updated_at=clock_timestamp() where id=$1`,
        [firstDispatch.outboxId],
      );
    });
    const secondDispatch = await begin(target);
    await expect(completeUnknown(target, firstDispatch)).resolves.toEqual([]);
    await expect(
      completeConfirmed(target, secondDispatch, {
        operationVersion: firstDispatch.operationVersion,
      }),
    ).resolves.toEqual([]);
    await expect(
      completeConfirmed(target, secondDispatch, {
        token: firstDispatch.token,
      }),
    ).resolves.toEqual([]);
    const second = (await completeUnknown(target, secondDispatch))[0]!;
    expect(second.reconcile_outbox_id).toBe(first.reconcile_outbox_id);
    expect(await state(target)).toMatchObject({
      reconcile_attempt_count: 7,
      reconcile_completed_at: null,
      reconcile_count: "1",
      reconcile_error: null,
      reconcile_lease_cleared: true,
      reconcile_status: "READY",
    });
  });

  it.each(["READY", "LEASED"] as const)(
    "falha fechado com RECONCILE %s já ativo",
    async (deliveryStatus) => {
      const target = await fixture(`active-${deliveryStatus}`);
      const dispatch = await begin(target);
      await withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `insert into renave.operation_outbox(
             tenant_id,operation_id,event_type,delivery_status,
             lease_owner,lease_token,lease_expires_at
           ) values ($1,$2,'RECONCILE',$3,
             case when $3='LEASED' then $4::uuid else null end,
             case when $3='LEASED' then $5::uuid else null end,
             case when $3='LEASED' then clock_timestamp()+interval '5 min' else null end)`,
          [
            target.tenant.id,
            target.operationId,
            deliveryStatus,
            randomUUID(),
            randomUUID(),
          ],
        ),
      );
      const before = await state(target);
      await expect(completeUnknown(target, dispatch)).rejects.toMatchObject({
        code: "23000",
      });
      expect(await state(target)).toEqual(before);
    },
  );

  it.each(["tenant", "establishment"] as const)(
    "serializa suspensão de %s e conclui bookkeeping após o lock",
    async (kind) => {
      const target = await fixture(`suspend-${kind}`);
      const dispatch = await begin(target);
      const admin = await adminPool.connect();
      const completer = await migratorPool.connect();
      let adminOpen = false;
      let completerOpen = false;
      try {
        await admin.query("begin");
        adminOpen = true;
        const adminPid = (
          await admin.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        if (kind === "tenant") {
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
        await setTenant(completer, target.tenant.id);
        completerOpen = true;
        const completionPid = (
          await completer.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          )
        ).rows[0]!.pid;
        const completing = completer.query(
          "select * from renave.complete_operation_send_rejected($1,$2,$3,$4,422)",
          [
            dispatch.outboxId,
            dispatch.owner,
            dispatch.token,
            dispatch.operationVersion,
          ],
        );
        await waitForBlock(admin, completionPid, adminPid);
        await admin.query("commit");
        adminOpen = false;
        expect((await completing).rows).toHaveLength(1);
        await completer.query("commit");
        completerOpen = false;
      } finally {
        if (adminOpen) await admin.query("rollback");
        if (completerOpen) await completer.query("rollback");
        admin.release();
        completer.release();
      }
      expect((await state(target)).operation_status).toBe("REJECTED");
    },
  );

  it("mantém isolamento de tenant", async () => {
    const target = await fixture("tenant-a");
    const other = await fixture("tenant-b");
    const dispatch = await begin(target);
    const wrongTenant = await withTenant(
      migratorPool,
      other.tenant.id,
      (client) =>
        client.query(
          "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
          [
            dispatch.outboxId,
            dispatch.owner,
            dispatch.token,
            dispatch.operationVersion,
          ],
        ),
    );
    expect(wrongTenant.rows).toEqual([]);
    expect(await completeUnknown(target, dispatch)).toHaveLength(1);
  });

  it("troca GUC A→B no mesmo backend e conclui tenants em paralelo", async () => {
    const tenantA = await fixture("same-backend-a");
    const tenantB = await fixture("same-backend-b");
    const dispatchA = await begin(tenantA);
    const dispatchB = await begin(tenantB);
    const client = await migratorPool.connect();
    try {
      const firstPid = (
        await client.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await setTenant(client, tenantA.tenant.id);
      expect(
        (
          await client.query(
            "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,17,'CONFIRMADO')",
            [
              dispatchA.outboxId,
              dispatchA.owner,
              dispatchA.token,
              dispatchA.operationVersion,
            ],
          )
        ).rows,
      ).toHaveLength(1);
      await client.query("commit");

      await setTenant(client, tenantB.tenant.id);
      expect(
        (
          await client.query(
            "select * from renave.complete_operation_send_rejected($1,$2,$3,$4,422)",
            [
              dispatchB.outboxId,
              dispatchB.owner,
              dispatchB.token,
              dispatchB.operationVersion,
            ],
          )
        ).rows,
      ).toHaveLength(1);
      await client.query("commit");
      const secondPid = (
        await client.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      expect(secondPid).toBe(firstPid);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((await state(tenantA)).operation_status).toBe("CONFIRMED");
    expect((await state(tenantB)).operation_status).toBe("REJECTED");

    const concurrentA = await fixture("parallel-a");
    const concurrentB = await fixture("parallel-b");
    const [leaseA, leaseB] = await Promise.all([
      begin(concurrentA),
      begin(concurrentB),
    ]);
    const completed = await Promise.all([
      completeUnknown(concurrentA, leaseA),
      completeUnknown(concurrentB, leaseB),
    ]);
    expect(completed.map((rows) => rows.length)).toEqual([1, 1]);
  });

  it("permanece owner-only para todos os papéis de runtime", async () => {
    const signatures = [
      "renave.complete_operation_send_confirmed(uuid,uuid,uuid,bigint,bigint,text)",
      "renave.complete_operation_send_rejected(uuid,uuid,uuid,bigint,integer)",
      "renave.complete_operation_send_outcome_unknown(uuid,uuid,uuid,bigint)",
    ];
    for (const signature of signatures) {
      const privileges = await adminPool.query<{
        app: boolean;
        identity: boolean;
        maintenance: boolean;
        migrator: boolean;
        public: boolean;
      }>(
        `select
           has_function_privilege('renave_app',$1,'execute') as app,
           has_function_privilege('renave_identity_app',$1,'execute') as identity,
           has_function_privilege('renave_maintenance_app',$1,'execute') as maintenance,
           has_function_privilege('renave_migrator',$1,'execute') as migrator,
           has_function_privilege('public',$1,'execute') as public`,
        [signature],
      );
      expect(privileges.rows[0]).toEqual({
        app: false,
        identity: false,
        maintenance: false,
        migrator: true,
        public: false,
      });
    }
  });
});
