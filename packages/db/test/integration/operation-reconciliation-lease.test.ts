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

interface Target {
  correlationId: string;
  establishment: Establishment;
  operationId: string;
  operationVersion: string;
  outboxId: string;
  sendOutboxId: string;
  tenant: Tenant;
}

interface ClaimRow {
  attempt_count: number;
  lease_expires_at: Date;
  lease_token: string;
  operation_id: string;
  operation_version: string;
  outbox_id: string;
}

interface BeginRow {
  attempt_count: number;
  correlation_id: string;
  establishment_id: string;
  kind: string;
  lease_expires_at: Date;
  mutation_family: string;
  operation_id: string;
  operation_version: string;
  outbox_id: string;
  projection_auth_tag: Buffer;
  projection_ciphertext: Buffer;
  projection_generation: string;
  projection_key_id: string;
  projection_kind: string;
  projection_nonce: Buffer;
  projection_schema_version: number;
  projection_size: number;
  request_schema_version: number;
  sent_at: Date;
  source_request_sha256: Buffer;
}

interface LeaseState {
  attempt_count: number;
  available_at: Date;
  completed_at: Date | null;
  delivery_status: string;
  last_error_code: string | null;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  lease_token: string | null;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let sequence = 0;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function createTarget(label: string, base?: Target): Promise<Target> {
  sequence += 1;
  const tenant =
    base?.tenant ??
    (await provisionTenant(migratorPool, {
      displayName: `Reconciliation ${label} ${sequence}`,
      slug: `reconciliation-${sequence}`,
    }));
  const establishment =
    base?.establishment ??
    (await withTenant(appPool, tenant.id, (client) =>
      createEstablishment(client, {
        cnpj: "11.222.333/0001-81",
        tradeName: `Reconciliation ${label}`,
      }),
    ));
  const correlationId = randomUUID();
  const input: CreateOperationInput = {
    ...operationProjectionFields(`reconciliation:${label}:${sequence}`),
    actorSubjectHash: digest(`actor:${label}:${sequence}`),
    correlationId,
    establishmentId: establishment.id,
    idempotencyKeyDigest: digest(`idempotency:${label}:${sequence}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 0x61),
    requestCiphertext: Buffer.from(`ciphertext:${label}:${sequence}`),
    requestKeyId: "reconciliation-test-key",
    requestNonce: Buffer.alloc(12, 0x62),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}:${sequence}`),
    vehicleKeyDigest: digest(`vehicle:${label}:${sequence}`),
  };
  const created = await withTenant(appPool, tenant.id, (client) =>
    createOrReplayOperation(client, input),
  );
  const sendOwner = randomUUID();
  const result = await withTenant(migratorPool, tenant.id, async (client) => {
    const claim = await client.query<{
      lease_token: string;
      outbox_id: string;
    }>("select * from renave.claim_operation_send_leases($1,1)", [sendOwner]);
    const send = claim.rows[0]!;
    const dispatch = await client.query<{ operation_version: string }>(
      "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
      [send.outbox_id, sendOwner, send.lease_token],
    );
    const unknown = await client.query<{
      operation_version: string;
      reconcile_outbox_id: string;
    }>(
      "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
      [
        send.outbox_id,
        sendOwner,
        send.lease_token,
        dispatch.rows[0]!.operation_version,
      ],
    );
    await client.query(
      `update renave.operation_outbox
          set available_at=clock_timestamp()-interval '1 ms'
        where id=$1`,
      [unknown.rows[0]!.reconcile_outbox_id],
    );
    return {
      operationVersion: unknown.rows[0]!.operation_version,
      outboxId: unknown.rows[0]!.reconcile_outbox_id,
      sendOutboxId: send.outbox_id,
    };
  });
  return {
    correlationId,
    establishment,
    operationId: created.operation.id,
    tenant,
    ...result,
  };
}

async function claim(
  target: Target,
  owner = randomUUID(),
  limit = 100,
): Promise<{ owner: string; rows: ClaimRow[] }> {
  const rows = await withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<ClaimRow>(
          "select * from renave.claim_operation_reconciliation_leases($1,$2)",
          [owner, limit],
        )
      ).rows,
  );
  return { owner, rows };
}

async function begin(
  target: Target,
  owner: string,
  lease: ClaimRow,
): Promise<BeginRow[]> {
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<BeginRow>(
          "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
          [lease.outbox_id, owner, lease.lease_token, lease.operation_version],
        )
      ).rows,
  );
}

async function leaseState(target: Target): Promise<LeaseState> {
  return withTenant(
    migratorPool,
    target.tenant.id,
    async (client) =>
      (
        await client.query<LeaseState>(
          `select delivery_status,available_at,attempt_count,lease_owner,
                lease_token,lease_expires_at,last_error_code,completed_at
           from renave.operation_outbox where id=$1`,
          [target.outboxId],
        )
      ).rows[0]!,
  );
}

async function prepareSendCycle(
  target: Target,
  expire: boolean,
): Promise<{ operationVersion: string; owner: string; token: string }> {
  const owner = randomUUID();
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    await client.query(
      `update renave.operation_outbox
          set delivery_status='COMPLETED',completed_at=clock_timestamp(),
              lease_owner=null,lease_token=null,lease_expires_at=null
        where id=$1`,
      [target.outboxId],
    );
    await client.query(
      `update renave.operation
          set status='PENDING_SEND',version=version+1,last_error_code=null,
              updated_at=clock_timestamp() where id=$1`,
      [target.operationId],
    );
    await client.query(
      `update renave.operation_outbox
          set delivery_status='READY',available_at=clock_timestamp(),
              completed_at=null,last_error_code=null where id=$1`,
      [target.sendOutboxId],
    );
    const send = await client.query<{ lease_token: string; outbox_id: string }>(
      "select * from renave.claim_operation_send_leases($1,1)",
      [owner],
    );
    const token = send.rows[0]!.lease_token;
    const dispatched = await client.query<{ operation_version: string }>(
      "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
      [target.sendOutboxId, owner, token],
    );
    if (expire) {
      await client.query(
        "update renave.operation_outbox set lease_expires_at=clock_timestamp()-interval '1 ms' where id=$1",
        [target.sendOutboxId],
      );
    }
    return {
      operationVersion: dispatched.rows[0]!.operation_version,
      owner,
      token,
    };
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      "select $2::integer=any(pg_blocking_pids($1::integer)) as blocked",
      [blockedPid, blockerPid],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("beginReconciliation não aguardou o lock esperado");
}

async function waitUntilDatabaseTime(instant: Date): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await adminPool.query<{ reached: boolean }>(
      "select clock_timestamp()>=$1::timestamptz as reached",
      [instant],
    );
    if (result.rows[0]!.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("relógio não alcançou a expiração controlada");
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 8 });
  migratorPool = createPool(urls.migrator, { max: 32 });
});

afterAll(async () => {
  await Promise.all([adminPool.end(), appPool.end(), migratorPool.end()]);
});

describe("operation reconciliation lease", () => {
  it("claim e begin entregam envelope cifrado e metadados mínimos", async () => {
    const target = await createTarget("happy");
    const claimed = await claim(target);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({
      attempt_count: 1,
      operation_id: target.operationId,
      operation_version: target.operationVersion,
      outbox_id: target.outboxId,
    });
    const beforeBegin = await leaseState(target);
    const rows = await begin(target, claimed.owner, claimed.rows[0]!);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "attempt_count",
        "correlation_id",
        "establishment_cnpj",
        "establishment_id",
        "kind",
        "lease_expires_at",
        "mutation_family",
        "operation_id",
        "operation_version",
        "outbox_id",
        "projection_auth_tag",
        "projection_ciphertext",
        "projection_generation",
        "projection_key_id",
        "projection_kind",
        "projection_nonce",
        "projection_schema_version",
        "projection_size",
        "request_schema_version",
        "sent_at",
        "source_request_sha256",
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      correlation_id: target.correlationId,
      establishment_cnpj: target.establishment.cnpj,
      establishment_id: target.establishment.id,
      kind: "USED_STOCK_ENTRY",
      mutation_family: "STOCK_ENTRY",
      operation_id: target.operationId,
      projection_generation: "1",
      projection_key_id: "test-projection-key-v1",
      projection_kind: "STOCK_ENTRY_RECONCILIATION",
      projection_schema_version: 1,
      request_schema_version: 1,
    });
    expect(rows[0]!.projection_ciphertext).toHaveLength(
      rows[0]!.projection_size,
    );
    expect(rows[0]!.projection_nonce).toHaveLength(12);
    expect(rows[0]!.projection_auth_tag).toHaveLength(16);
    expect(Object.keys(rows[0]!)).not.toEqual(
      expect.arrayContaining(["lease_owner", "lease_token"]),
    );
    const afterBegin = await leaseState(target);
    expect(afterBegin).toMatchObject({
      attempt_count: beforeBegin.attempt_count,
      available_at: beforeBegin.available_at,
      completed_at: null,
      delivery_status: "LEASED",
      last_error_code: null,
      lease_owner: beforeBegin.lease_owner,
      lease_token: beforeBegin.lease_token,
    });
    expect(afterBegin.lease_expires_at!.getTime()).toBe(
      rows[0]!.lease_expires_at.getTime(),
    );
    expect(afterBegin.lease_expires_at!.getTime() - Date.now()).toBeGreaterThan(
      295_000,
    );
  });

  it("begin com versão anterior ou futura não altera snapshot", async () => {
    const target = await createTarget("stale-version");
    const claimed = await claim(target);
    const lease = claimed.rows[0]!;
    const before = await leaseState(target);
    for (const version of [
      (BigInt(lease.operation_version) - 1n).toString(),
      (BigInt(lease.operation_version) + 1n).toString(),
    ]) {
      const rows = await withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
          [target.outboxId, claimed.owner, lease.lease_token, version],
        ),
      );
      expect(rows.rows).toEqual([]);
      expect(await leaseState(target)).toEqual(before);
    }
  });

  it("filtra disponibilidade, tenant e estabelecimento ativos", async () => {
    const future = await createTarget("future");
    await withTenant(migratorPool, future.tenant.id, (client) =>
      client.query(
        "update renave.operation_outbox set available_at=clock_timestamp()+interval '1 hour' where id=$1",
        [future.outboxId],
      ),
    );
    expect((await claim(future)).rows).toEqual([]);

    const inactiveEstablishment = await createTarget("inactive-establishment");
    await withTenant(migratorPool, inactiveEstablishment.tenant.id, (client) =>
      client.query(
        "update renave.establishment set status='inactive' where id=$1",
        [inactiveEstablishment.establishment.id],
      ),
    );
    expect((await claim(inactiveEstablishment)).rows).toEqual([]);

    const suspended = await createTarget("suspended");
    await withTenant(migratorPool, suspended.tenant.id, (client) =>
      client.query("update renave.tenant set status='suspended'"),
    );
    await expect(claim(suspended)).rejects.toMatchObject({ code: "42501" });

    const wrongStatus = await createTarget("wrong-status");
    await withTenant(migratorPool, wrongStatus.tenant.id, (client) =>
      client.query(
        `update renave.operation
            set status='MANUAL_REVIEW',version=version+1,
                updated_at=clock_timestamp()
          where id=$1`,
        [wrongStatus.operationId],
      ),
    );
    expect((await claim(wrongStatus)).rows).toEqual([]);
  });

  it("ordena, limita e drena lotes deterministicamente", async () => {
    const first = await createTarget("ordered-a");
    const second = await createTarget("ordered-b", first);
    const third = await createTarget("ordered-c", first);
    await withTenant(migratorPool, first.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox set available_at=case id
           when $1 then clock_timestamp()-interval '30 seconds'
           when $2 then clock_timestamp()-interval '20 seconds'
           when $3 then clock_timestamp()-interval '10 seconds'
           else available_at end where id=any($4::uuid[])`,
        [
          first.outboxId,
          second.outboxId,
          third.outboxId,
          [first.outboxId, second.outboxId, third.outboxId],
        ],
      ),
    );
    const owner = randomUUID();
    const firstBatch = (await claim(first, owner, 2)).rows;
    const secondBatch = (await claim(first, owner, 2)).rows;
    expect(firstBatch.map((row) => row.outbox_id)).toEqual([
      first.outboxId,
      second.outboxId,
    ]);
    expect(secondBatch.map((row) => row.outbox_id)).toEqual([third.outboxId]);
    expect(
      new Set([...firstBatch, ...secondBatch].map((row) => row.lease_token))
        .size,
    ).toBe(3);
  });

  it("claim concorrente entrega cada linha uma vez", async () => {
    const target = await createTarget("concurrent");
    const results = await Promise.all(
      Array.from({ length: 24 }, () => claim(target, randomUUID(), 1)),
    );
    expect(results.flatMap((result) => result.rows)).toHaveLength(1);
  });

  it("24 claimers distribuem backlog multi-row sem duplicar", async () => {
    const first = await createTarget("backlog-0");
    const backlog = [first];
    for (let index = 1; index < 12; index += 1) {
      backlog.push(await createTarget(`backlog-${index}`, first));
    }
    const claims = await Promise.all(
      Array.from({ length: 24 }, () => claim(first, randomUUID(), 1)),
    );
    const ids = claims.flatMap((item) => item.rows.map((row) => row.outbox_id));
    expect(ids).toHaveLength(backlog.length);
    expect(new Set(ids).size).toBe(backlog.length);
    expect(new Set(ids)).toEqual(new Set(backlog.map((item) => item.outboxId)));
  });

  it("SKIP LOCKED pula linha ocupada e drena depois", async () => {
    const first = await createTarget("skip-a");
    const second = await createTarget("skip-b", first);
    const locker = await migratorPool.connect();
    try {
      await setTenant(locker, first.tenant.id);
      await locker.query(
        "select id from renave.operation_outbox where id=$1 for update",
        [first.outboxId],
      );
      const claimed = await withTenant(
        migratorPool,
        first.tenant.id,
        async (client) => {
          await client.query("set local statement_timeout='1s'");
          return (
            await client.query<ClaimRow>(
              "select * from renave.claim_operation_reconciliation_leases($1,1)",
              [randomUUID()],
            )
          ).rows;
        },
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.outbox_id).toBe(second.outboxId);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
    expect((await claim(first, randomUUID(), 1)).rows[0]!.outbox_id).toBe(
      first.outboxId,
    );
  });

  it("reclaim troca token, incrementa tentativa e invalida fence antigo", async () => {
    const target = await createTarget("reclaim");
    const first = await claim(target);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        "update renave.operation_outbox set lease_expires_at=clock_timestamp()-interval '1 ms' where id=$1",
        [target.outboxId],
      ),
    );
    const second = await claim(target);
    expect(second.rows[0]).toMatchObject({ attempt_count: 2 });
    expect(second.rows[0]!.lease_token).not.toBe(first.rows[0]!.lease_token);
    expect(await begin(target, first.owner, first.rows[0]!)).toEqual([]);
    const stale = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => ({
        release: (
          await client.query<{ value: boolean }>(
            "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0) as value",
            [
              target.outboxId,
              first.owner,
              first.rows[0]!.lease_token,
              target.operationVersion,
            ],
          )
        ).rows[0]!.value,
        renew: (
          await client.query<{ value: boolean }>(
            "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
            [
              target.outboxId,
              first.owner,
              first.rows[0]!.lease_token,
              target.operationVersion,
            ],
          )
        ).rows[0]!.value,
      }),
    );
    expect(stale).toEqual({ release: false, renew: false });
    expect(await begin(target, second.owner, second.rows[0]!)).toHaveLength(1);
  });

  it("token é globalmente único entre SEND, RECONCILE e tenants", async () => {
    const targetA = await createTarget("token-a");
    const targetB = await createTarget("token-b");
    const reconcileA = await claim(targetA);
    const reconcileB = await claim(targetB);
    const sendOwner = randomUUID();
    const send = await withTenant(
      migratorPool,
      targetA.tenant.id,
      async (client) => {
        await client.query(
          `update renave.operation
              set status='PENDING_SEND',version=version+1,
                  last_error_code=null,updated_at=clock_timestamp()
            where id=$1`,
          [targetA.operationId],
        );
        await client.query(
          `update renave.operation_outbox
              set delivery_status='READY',available_at=clock_timestamp(),
                  completed_at=null,last_error_code=null
            where id=$1`,
          [targetA.sendOutboxId],
        );
        return (
          await client.query<{ lease_token: string; outbox_id: string }>(
            "select * from renave.claim_operation_send_leases($1,1)",
            [sendOwner],
          )
        ).rows[0]!;
      },
    );
    const tokens = [
      reconcileA.rows[0]!.lease_token,
      reconcileB.rows[0]!.lease_token,
      send.lease_token,
    ];
    expect(new Set(tokens).size).toBe(3);
    await expect(
      withTenant(migratorPool, targetA.tenant.id, (client) =>
        client.query(
          "update renave.operation_outbox set lease_token=$1 where id=$2",
          [reconcileA.rows[0]!.lease_token, send.outbox_id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("renew e release respeitam versão, bordas e suspensão", async () => {
    const target = await createTarget("renew-release");
    const claimed = await claim(target);
    const lease = claimed.rows[0]!;
    const beforeRenew = await leaseState(target);
    const renewed = await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query<{ value: boolean }>(
        "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
        [
          target.outboxId,
          claimed.owner,
          lease.lease_token,
          lease.operation_version,
        ],
      ),
    );
    expect(renewed.rows[0]!.value).toBe(true);
    const afterRenew = await leaseState(target);
    expect(afterRenew).toMatchObject({
      attempt_count: beforeRenew.attempt_count,
      delivery_status: "LEASED",
      lease_owner: beforeRenew.lease_owner,
      lease_token: beforeRenew.lease_token,
    });
    expect(afterRenew.lease_expires_at!.getTime()).toBeGreaterThan(
      beforeRenew.lease_expires_at!.getTime(),
    );
    const staleVersion = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query<{ value: boolean }>(
          "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
          [target.outboxId, claimed.owner, lease.lease_token, "1"],
        ),
    );
    expect(staleVersion.rows[0]!.value).toBe(false);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query("update renave.tenant set status='suspended'"),
    );
    const suspended = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => ({
        release: (
          await client.query<{ value: boolean }>(
            "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,86400) as value",
            [
              target.outboxId,
              claimed.owner,
              lease.lease_token,
              lease.operation_version,
            ],
          )
        ).rows[0]!.value,
        renew: (
          await client.query<{ value: boolean }>(
            "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
            [
              target.outboxId,
              claimed.owner,
              lease.lease_token,
              lease.operation_version,
            ],
          )
        ).rows[0]!.value,
      }),
    );
    expect(suspended).toEqual({ release: true, renew: false });
    const afterRelease = await leaseState(target);
    expect(afterRelease).toMatchObject({
      attempt_count: beforeRenew.attempt_count,
      completed_at: null,
      delivery_status: "READY",
      last_error_code: "RECONCILIATION_RELEASED",
      lease_expires_at: null,
      lease_owner: null,
      lease_token: null,
    });
    expect(afterRelease.available_at.getTime() - Date.now()).toBeGreaterThan(
      86_395_000,
    );
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,-1)",
          [
            target.outboxId,
            claimed.owner,
            lease.lease_token,
            lease.operation_version,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const zeroDelay = await createTarget("release-zero");
    const zeroClaim = await claim(zeroDelay);
    expect(
      (
        await withTenant(migratorPool, zeroDelay.tenant.id, (client) =>
          client.query<{ value: boolean }>(
            "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0) as value",
            [
              zeroDelay.outboxId,
              zeroClaim.owner,
              zeroClaim.rows[0]!.lease_token,
              zeroClaim.rows[0]!.operation_version,
            ],
          ),
        )
      ).rows[0]!.value,
    ).toBe(true);
    await expect(
      withTenant(migratorPool, zeroDelay.tenant.id, (client) =>
        client.query(
          "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,86401)",
          [
            zeroDelay.outboxId,
            zeroClaim.owner,
            zeroClaim.rows[0]!.lease_token,
            zeroClaim.rows[0]!.operation_version,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const equality = await createTarget("release-equality");
    const equalityClaim = await claim(equality);
    await withTenant(migratorPool, equality.tenant.id, (client) =>
      client.query(
        "update renave.operation_outbox set lease_expires_at=clock_timestamp() where id=$1",
        [equality.outboxId],
      ),
    );
    const atBoundary = await withTenant(
      migratorPool,
      equality.tenant.id,
      (client) =>
        client.query<{ value: boolean }>(
          "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0) as value",
          [
            equality.outboxId,
            equalityClaim.owner,
            equalityClaim.rows[0]!.lease_token,
            equalityClaim.rows[0]!.operation_version,
          ],
        ),
    );
    expect(atBoundary.rows[0]!.value).toBe(false);
  });

  it.each(["renew", "release"] as const)(
    "%s revalida expiração após aguardar operação",
    async (action) => {
      const target = await createTarget(`expiry-${action}`);
      const claimed = await claim(target);
      const lease = claimed.rows[0]!;
      const expiry = await withTenant(
        migratorPool,
        target.tenant.id,
        async (client) =>
          (
            await client.query<{ lease_expires_at: Date }>(
              `update renave.operation_outbox
                  set lease_expires_at=clock_timestamp()+interval '3 seconds'
                where id=$1 returning lease_expires_at`,
              [target.outboxId],
            )
          ).rows[0]!.lease_expires_at,
      );
      const blocker = await migratorPool.connect();
      const worker = await migratorPool.connect();
      let blockerOpen = false;
      let workerOpen = false;
      try {
        await setTenant(blocker, target.tenant.id);
        blockerOpen = true;
        const blockerPid = (
          await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        await blocker.query(
          "select id from renave.operation where id=$1 for update",
          [target.operationId],
        );
        await setTenant(worker, target.tenant.id);
        workerOpen = true;
        await worker.query("set local statement_timeout='10s'");
        const workerPid = (
          await worker.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        const sql =
          action === "renew"
            ? "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value"
            : "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0) as value";
        const running = worker.query<{ value: boolean }>(sql, [
          target.outboxId,
          claimed.owner,
          lease.lease_token,
          lease.operation_version,
        ]);
        await waitForBlock(blocker, workerPid, blockerPid);
        const before = await adminPool.query<{ before: boolean }>(
          "select clock_timestamp()<$1::timestamptz as before",
          [expiry],
        );
        expect(before.rows[0]!.before).toBe(true);
        await waitUntilDatabaseTime(expiry);
        await blocker.query("commit");
        blockerOpen = false;
        expect((await running).rows[0]!.value).toBe(false);
        await worker.query("commit");
        workerOpen = false;
      } finally {
        if (blockerOpen) await blocker.query("rollback");
        if (workerOpen) await worker.query("rollback");
        blocker.release();
        worker.release();
      }
      expect((await claim(target)).rows[0]!.attempt_count).toBe(2);
    },
  );

  it("begin revalida expiração depois de aguardar lock administrativo", async () => {
    const target = await createTarget("begin-expiry");
    const claimed = await claim(target);
    const lease = claimed.rows[0]!;
    const expiry = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) =>
        (
          await client.query<{ lease_expires_at: Date }>(
            `update renave.operation_outbox
              set lease_expires_at=clock_timestamp()+interval '3 seconds'
            where id=$1 returning lease_expires_at`,
            [target.outboxId],
          )
        ).rows[0]!.lease_expires_at,
    );
    const admin = await adminPool.connect();
    const worker = await migratorPool.connect();
    let adminOpen = false;
    let workerOpen = false;
    try {
      await admin.query("begin");
      adminOpen = true;
      const adminPid = (
        await admin.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await admin.query(
        "update renave.tenant set display_name=display_name where id=$1",
        [target.tenant.id],
      );
      await setTenant(worker, target.tenant.id);
      workerOpen = true;
      await worker.query("set local statement_timeout='10s'");
      const workerPid = (
        await worker.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const beginning = worker.query(
        "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
        [
          target.outboxId,
          claimed.owner,
          lease.lease_token,
          lease.operation_version,
        ],
      );
      await waitForBlock(admin, workerPid, adminPid);
      const before = await adminPool.query<{ before: boolean }>(
        "select clock_timestamp()<$1::timestamptz as before",
        [expiry],
      );
      expect(before.rows[0]!.before).toBe(true);
      for (;;) {
        const clock = await adminPool.query<{ reached: boolean }>(
          "select clock_timestamp()>=$1::timestamptz as reached",
          [expiry],
        );
        if (clock.rows[0]!.reached) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await admin.query("commit");
      adminOpen = false;
      expect((await beginning).rows).toEqual([]);
      await worker.query("commit");
      workerOpen = false;
    } finally {
      if (adminOpen) await admin.query("rollback");
      if (workerOpen) await worker.query("rollback");
      admin.release();
      worker.release();
    }
    expect((await claim(target)).rows).toHaveLength(1);
  });

  it.each(["tenant", "establishment"] as const)(
    "begin serializa suspensão de %s e retorna vazio",
    async (kind) => {
      const target = await createTarget(`suspend-${kind}`);
      const claimed = await claim(target);
      const lease = claimed.rows[0]!;
      const admin = await adminPool.connect();
      const worker = await migratorPool.connect();
      let adminOpen = false;
      let workerOpen = false;
      try {
        await admin.query("begin");
        adminOpen = true;
        const adminPid = (
          await admin.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        await admin.query(
          kind === "tenant"
            ? "update renave.tenant set status='suspended' where id=$1"
            : "update renave.establishment set status='inactive' where id=$1",
          [kind === "tenant" ? target.tenant.id : target.establishment.id],
        );
        await setTenant(worker, target.tenant.id);
        workerOpen = true;
        const workerPid = (
          await worker.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        const beginning = worker.query(
          "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
          [
            target.outboxId,
            claimed.owner,
            lease.lease_token,
            lease.operation_version,
          ],
        );
        await waitForBlock(admin, workerPid, adminPid);
        await admin.query("commit");
        adminOpen = false;
        expect((await beginning).rows).toEqual([]);
        await worker.query("commit");
        workerOpen = false;
      } finally {
        if (adminOpen) await admin.query("rollback");
        if (workerOpen) await worker.query("rollback");
        admin.release();
        worker.release();
      }
    },
  );

  it.each(["UNKNOWN", "RECOVERY"] as const)(
    "%s preserva SEND→RECONCILE e converge após bloqueio",
    async (scenario) => {
      const target = await createTarget(`lock-order-${scenario}`);
      const send = await prepareSendCycle(target, scenario === "RECOVERY");
      const blocker = await migratorPool.connect();
      const worker = await migratorPool.connect();
      let blockerOpen = false;
      let workerOpen = false;
      try {
        await setTenant(blocker, target.tenant.id);
        blockerOpen = true;
        const blockerPid = (
          await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        await blocker.query(
          "select id from renave.operation_outbox where id=$1 for update",
          [target.outboxId],
        );

        await setTenant(worker, target.tenant.id);
        workerOpen = true;
        await worker.query("set local statement_timeout='5s'");
        const workerPid = (
          await worker.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        const running =
          scenario === "UNKNOWN"
            ? worker.query(
                "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
                [
                  target.sendOutboxId,
                  send.owner,
                  send.token,
                  send.operationVersion,
                ],
              )
            : worker.query(
                "select * from renave.recover_expired_operation_sends(1)",
              );
        await waitForBlock(blocker, workerPid, blockerPid);
        await blocker.query("commit");
        blockerOpen = false;
        expect((await running).rows).toHaveLength(1);
        await worker.query("commit");
        workerOpen = false;
      } finally {
        if (blockerOpen) await blocker.query("rollback");
        if (workerOpen) await worker.query("rollback");
        blocker.release();
        worker.release();
      }
      expect(await leaseState(target)).toMatchObject({
        delivery_status: "READY",
        lease_owner: null,
        lease_token: null,
      });
      const operation = await withTenant(
        migratorPool,
        target.tenant.id,
        (client) =>
          client.query<{ status: string }>(
            "select status from renave.operation where id=$1",
            [target.operationId],
          ),
      );
      expect(operation.rows[0]!.status).toBe("PENDING_RECONCILIATION");
    },
  );

  it("reativação COMPLETED volta a ser claimável", async () => {
    const target = await createTarget("cycle");
    const claimA = await claim(target);
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox
            set delivery_status='COMPLETED',completed_at=clock_timestamp(),
                lease_owner=null,lease_token=null,lease_expires_at=null
          where id=$1`,
        [target.outboxId],
      );
      await client.query(
        "update renave.operation set status='PENDING_SEND',version=version+1,last_error_code=null where id=$1",
        [target.operationId],
      );
      await client.query(
        "update renave.operation_outbox set delivery_status='READY',available_at=clock_timestamp(),completed_at=null,last_error_code=null where id=$1",
        [target.sendOutboxId],
      );
      const sendOwner = randomUUID();
      const send = await client.query<{
        lease_token: string;
        outbox_id: string;
      }>("select * from renave.claim_operation_send_leases($1,1)", [sendOwner]);
      const dispatch = await client.query<{ operation_version: string }>(
        "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
        [send.rows[0]!.outbox_id, sendOwner, send.rows[0]!.lease_token],
      );
      await client.query(
        "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
        [
          send.rows[0]!.outbox_id,
          sendOwner,
          send.rows[0]!.lease_token,
          dispatch.rows[0]!.operation_version,
        ],
      );
      await client.query(
        "update renave.operation_outbox set available_at=clock_timestamp()-interval '1 ms' where id=$1",
        [target.outboxId],
      );
    });
    const claimB = await claim(target);
    expect(claimB.rows[0]!.outbox_id).toBe(target.outboxId);
    expect(claimB.rows[0]!.lease_token).not.toBe(claimA.rows[0]!.lease_token);
    expect(await begin(target, claimA.owner, claimA.rows[0]!)).toEqual([]);
    const oldFence = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => ({
        release: (
          await client.query<{ value: boolean }>(
            "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0) as value",
            [
              target.outboxId,
              claimA.owner,
              claimA.rows[0]!.lease_token,
              claimA.rows[0]!.operation_version,
            ],
          )
        ).rows[0]!.value,
        renew: (
          await client.query<{ value: boolean }>(
            "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
            [
              target.outboxId,
              claimA.owner,
              claimA.rows[0]!.lease_token,
              claimA.rows[0]!.operation_version,
            ],
          )
        ).rows[0]!.value,
      }),
    );
    expect(oldFence).toEqual({ release: false, renew: false });
    expect(await begin(target, claimB.owner, claimB.rows[0]!)).toHaveLength(1);
  });

  it("rollback externo e trigger interno não deixam claim parcial", async () => {
    const external = await createTarget("rollback-external");
    await expect(
      withTenant(migratorPool, external.tenant.id, async (client) => {
        expect(
          (
            await client.query(
              "select * from renave.claim_operation_reconciliation_leases($1,1)",
              [randomUUID()],
            )
          ).rows,
        ).toHaveLength(1);
        throw new Error("rollback esperado");
      }),
    ).rejects.toThrow("rollback esperado");
    expect((await claim(external)).rows[0]!.attempt_count).toBe(1);

    const internal = await createTarget("rollback-internal");
    await adminPool.query(
      `create function renave.reject_reconciliation_claim_probe()
       returns trigger language plpgsql set search_path=pg_catalog as $$
       begin if new.event_type='RECONCILE' and new.delivery_status='LEASED'
         then raise exception 'probe'; end if; return new; end $$`,
    );
    await adminPool.query(
      `create trigger reject_reconciliation_claim_probe before update
       on renave.operation_outbox for each row
       execute function renave.reject_reconciliation_claim_probe()`,
    );
    try {
      await expect(claim(internal)).rejects.toThrow("probe");
    } finally {
      await adminPool.query(
        "drop trigger reject_reconciliation_claim_probe on renave.operation_outbox",
      );
      await adminPool.query(
        "drop function renave.reject_reconciliation_claim_probe()",
      );
    }
    expect((await claim(internal)).rows[0]!.attempt_count).toBe(1);
  });

  it.each(["renew", "release", "begin"] as const)(
    "rollback externo de %s restaura a lease",
    async (action) => {
      const target = await createTarget(`rollback-${action}`);
      const claimed = await claim(target);
      const lease = claimed.rows[0]!;
      const before = await leaseState(target);
      await expect(
        withTenant(migratorPool, target.tenant.id, async (client) => {
          const sql =
            action === "renew"
              ? "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4)"
              : action === "release"
                ? "select renave.release_operation_reconciliation_lease($1,$2,$3,$4,0)"
                : "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)";
          await client.query(sql, [
            target.outboxId,
            claimed.owner,
            lease.lease_token,
            lease.operation_version,
          ]);
          throw new Error("rollback esperado");
        }),
      ).rejects.toThrow("rollback esperado");
      expect(await leaseState(target)).toEqual(before);
    },
  );

  it("isola tenants, troca GUC no mesmo PID e reutiliza pool em paralelo", async () => {
    const a = await createTarget("tenant-a");
    const b = await createTarget("tenant-b");
    const client = await migratorPool.connect();
    try {
      const pid = (
        await client.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await setTenant(client, a.tenant.id);
      expect(
        (
          await client.query(
            "select * from renave.claim_operation_reconciliation_leases($1,1)",
            [randomUUID()],
          )
        ).rows[0]!.operation_id,
      ).toBe(a.operationId);
      await client.query("commit");
      await setTenant(client, b.tenant.id);
      expect(
        (
          await client.query(
            "select * from renave.claim_operation_reconciliation_leases($1,1)",
            [randomUUID()],
          )
        ).rows[0]!.operation_id,
      ).toBe(b.operationId);
      await client.query("commit");
      expect(
        (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0]!.pid,
      ).toBe(pid);
    } finally {
      await client.query("rollback");
      client.release();
    }

    const c = await createTarget("tenant-c");
    const d = await createTarget("tenant-d");
    const parallel = await Promise.all([claim(c), claim(d)]);
    expect(parallel.map((item) => item.rows.length)).toEqual([1, 1]);
  });

  it("permanece owner-only e valida parâmetros", async () => {
    const target = await createTarget("acl");
    await expect(
      appPool.query(
        "select * from renave.claim_operation_reconciliation_leases($1,1)",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const limit of [-1, 0, 101]) {
      await expect(claim(target, randomUUID(), limit)).rejects.toMatchObject({
        code: "22023",
      });
    }
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.claim_operation_reconciliation_leases($1,null)",
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    const signatures = [
      "renave.claim_operation_reconciliation_leases(uuid,integer)",
      "renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)",
      "renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)",
      "renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)",
    ];
    for (const signature of signatures) {
      const result = await adminPool.query(
        `select has_function_privilege('public',$1,'execute') as public,
                has_function_privilege('renave_app',$1,'execute') as app,
                has_function_privilege('renave_migrator',$1,'execute') as migrator`,
        [signature],
      );
      expect(result.rows[0]).toEqual({
        app: false,
        migrator: true,
        public: false,
      });
    }
  });
});
