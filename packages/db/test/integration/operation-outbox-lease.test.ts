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

const urls = inject("dbUrls");

interface Fixture {
  establishment: Establishment;
  tenant: Tenant;
}

interface LeaseClaim {
  attempt_count: number;
  event_type: string;
  lease_expires_at: Date;
  lease_token: string;
  operation_id: string;
  outbox_id: string;
}

interface LeaseState {
  attempt_count: number;
  delivery_status: string;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  lease_token: string | null;
  updated_at: Date;
}

let appPool: Pool;
let migratorPool: Pool;
let fixtureCounter = 0;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function fixture(label: string): Promise<Fixture> {
  fixtureCounter += 1;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Lease ${label} ${fixtureCounter}`,
    slug: `lease-${label}-${fixtureCounter}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Lease ${label}`,
    }),
  );
  return { establishment, tenant };
}

function operationInput(target: Fixture, label: string): CreateOperationInput {
  return {
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId: target.establishment.id,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 3),
    requestCiphertext: Buffer.from(`encrypted:${label}`, "utf8"),
    requestKeyId: "lease-test-key",
    requestNonce: Buffer.alloc(12, 4),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}`),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

async function seed(target: Fixture, label: string): Promise<string> {
  const result = await withTenant(appPool, target.tenant.id, (client) =>
    createOrReplayOperation(client, operationInput(target, label)),
  );
  return result.operation.id;
}

async function claim(
  tenantId: string,
  owner: string,
  limit = 1,
): Promise<LeaseClaim[]> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<LeaseClaim>(
      `select * from renave.claim_operation_send_leases($1, $2)`,
      [owner, limit],
    );
    return rows;
  });
}

async function renew(
  tenantId: string,
  outboxId: string,
  owner: string,
  token: string,
): Promise<boolean> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<{ result: boolean }>(
      `select renave.renew_operation_send_lease($1, $2, $3) as result`,
      [outboxId, owner, token],
    );
    return rows[0]!.result;
  });
}

async function release(
  tenantId: string,
  outboxId: string,
  owner: string,
  token: string,
  delay: number,
): Promise<boolean> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<{ result: boolean }>(
      `select renave.release_operation_send_lease(
         $1, $2, $3, $4
       ) as result`,
      [outboxId, owner, token, delay],
    );
    return rows[0]!.result;
  });
}

async function leaseState(
  tenantId: string,
  outboxId: string,
): Promise<LeaseState> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<LeaseState>(
      `select attempt_count, delivery_status, lease_expires_at,
              lease_owner, lease_token, updated_at
         from renave.operation_outbox
        where id = $1`,
      [outboxId],
    );
    return rows[0]!;
  });
}

async function activateTenant(client: PoolClient, tenantId: string) {
  await client.query("begin");
  await client.query("select set_config('renave.tenant_id', $1, true)", [
    tenantId,
  ]);
}

beforeAll(() => {
  appPool = createPool(urls.app, { max: 12 });
  migratorPool = createPool(urls.migrator, { max: 24 });
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end()]);
});

describe("operation outbox claim/lease", () => {
  it("permanece sem grant runtime e falha sem tenant", async () => {
    await expect(
      migratorPool.query(
        "select * from renave.claim_operation_send_leases($1, $2)",
        [randomUUID(), 1],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const target = await fixture("no-runtime-grant");
    await expect(
      withTenant(appPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.claim_operation_send_leases($1, $2)",
          [randomUUID(), 1],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const privileges = await migratorPool.query<{
      app_execute: boolean;
      migrator_execute: boolean;
      public_execute: boolean;
    }>(
      `select
         has_function_privilege(
           'renave_app',
           'renave.claim_operation_send_leases(uuid,integer)',
           'execute'
         ) as app_execute,
         has_function_privilege(
           'renave_migrator',
           'renave.claim_operation_send_leases(uuid,integer)',
           'execute'
         ) as migrator_execute,
         has_function_privilege(
           'public',
           'renave.claim_operation_send_leases(uuid,integer)',
           'execute'
         ) as public_execute`,
    );
    expect(privileges.rows[0]).toEqual({
      app_execute: false,
      migrator_execute: true,
      public_execute: false,
    });
  });

  it("recusa limites de lote fora do contrato antes de tocar a fila", async () => {
    const target = await fixture("invalid-input");
    await seed(target, `invalid-input-${randomUUID()}`);
    for (const limit of [0, 101]) {
      await expect(
        claim(target.tenant.id, randomUUID(), limit),
      ).rejects.toMatchObject({ code: "22023" });
    }
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.claim_operation_send_leases(null, 1)",
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          "select * from renave.claim_operation_send_leases($1, null)",
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("recusa delay negativo ou acima do teto", async () => {
    const target = await fixture("invalid-delay");
    for (const delay of [-1, 86401]) {
      await expect(
        release(
          target.tenant.id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          delay,
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }
  });

  it("recusa parâmetros nulos de renew e release", async () => {
    const target = await fixture("null-parameters");
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `select renave.release_operation_send_lease(
             null, $1, $2, 0
           )`,
          [randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(`select renave.renew_operation_send_lease(null, $1, $2)`, [
          randomUUID(),
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(`select renave.renew_operation_send_lease($1, null, $2)`, [
          randomUUID(),
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(`select renave.renew_operation_send_lease($1, $2, null)`, [
          randomUUID(),
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `select renave.release_operation_send_lease(
             $1, null, $2, 0
           )`,
          [randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `select renave.release_operation_send_lease(
             $1, $2, null, 0
           )`,
          [randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migratorPool, target.tenant.id, (client) =>
        client.query(
          `select renave.release_operation_send_lease(
             $1, $2, $3, null
           )`,
          [randomUUID(), randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("retorna somente metadados de lease e isola tenants", async () => {
    const tenantA = await fixture("tenant-a");
    const tenantB = await fixture("tenant-b");
    const operationA = await seed(tenantA, `tenant-a-${randomUUID()}`);
    const operationB = await seed(tenantB, `tenant-b-${randomUUID()}`);

    const claimsA = await claim(tenantA.tenant.id, randomUUID(), 10);
    const claimsB = await claim(tenantB.tenant.id, randomUUID(), 10);

    expect(claimsA).toHaveLength(1);
    expect(claimsB).toHaveLength(1);
    expect(claimsA[0]!.operation_id).toBe(operationA);
    expect(claimsB[0]!.operation_id).toBe(operationB);
    expect(Object.keys(claimsA[0]!).sort()).toEqual([
      "attempt_count",
      "event_type",
      "lease_expires_at",
      "lease_token",
      "operation_id",
      "outbox_id",
    ]);
    expect(JSON.stringify(claimsA)).not.toMatch(
      /cipher|nonce|auth|digest|sha256|key_id/iu,
    );
  });

  it("60 claimers concorrentes entregam um evento exatamente uma vez", async () => {
    const target = await fixture("concurrency");
    const operationId = await seed(target, `concurrency-${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        claim(target.tenant.id, randomUUID(), 1),
      ),
    );
    const claimed = results.flat();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.operation_id).toBe(operationId);
    expect(claimed[0]!.attempt_count).toBe(1);
  });

  it("distribui lotes concorrentes sem perder nem duplicar eventos", async () => {
    const target = await fixture("concurrent-batches");
    const operationIds = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        seed(target, `concurrent-batch-${index}-${randomUUID()}`),
      ),
    );
    const batches = await Promise.all(
      Array.from({ length: 6 }, () => claim(target.tenant.id, randomUUID(), 3)),
    );
    const claimed = batches.flat();
    expect(claimed).toHaveLength(12);
    expect(new Set(claimed.map((item) => item.outbox_id)).size).toBe(12);
    expect(new Set(claimed.map((item) => item.lease_token)).size).toBe(12);
    expect(claimed.map((item) => item.operation_id).sort()).toEqual(
      operationIds.sort(),
    );
  });

  it("SKIP LOCKED deixa outro claimer avançar para a próxima linha", async () => {
    const target = await fixture("skip-locked");
    await seed(target, `skip-locked-a-${randomUUID()}`);
    await seed(target, `skip-locked-b-${randomUUID()}`);
    const firstClient = await migratorPool.connect();
    const secondClient = await migratorPool.connect();
    try {
      await activateTenant(firstClient, target.tenant.id);
      const first = await firstClient.query<LeaseClaim>(
        "select * from renave.claim_operation_send_leases($1, 1)",
        [randomUUID()],
      );
      expect(first.rows).toHaveLength(1);

      await activateTenant(secondClient, target.tenant.id);
      await secondClient.query("set local statement_timeout = '2s'");
      const second = await secondClient.query<LeaseClaim>(
        "select * from renave.claim_operation_send_leases($1, 1)",
        [randomUUID()],
      );
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.outbox_id).not.toBe(first.rows[0]!.outbox_id);
      await secondClient.query("commit");
    } finally {
      await firstClient.query("rollback");
      await secondClient.query("rollback").catch(() => undefined);
      firstClient.release();
      secondClient.release();
    }
  });

  it("preserva a ordem por prioridade, criação e id no retorno do lote", async () => {
    const target = await fixture("ordering");
    const operations = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        seed(target, `ordering-${index}-${randomUUID()}`),
      ),
    );
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox
            set available_at = case
              when operation_id = $1 then timestamptz '2026-01-01 00:00:02+00'
              else timestamptz '2026-01-01 00:00:01+00'
            end
          where operation_id = any($2::uuid[])`,
        [operations[0], operations],
      );
    });
    const expected = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query<{ id: string }>(
          `select id
             from renave.operation_outbox
            where operation_id = any($1::uuid[])
            order by available_at, created_at, id`,
          [operations],
        ),
    );

    const claimed = await claim(target.tenant.id, randomUUID(), 4);
    expect(claimed.map((item) => item.outbox_id)).toEqual(
      expected.rows.map((item) => item.id),
    );
  });

  it("lease válido não é retomado; expirado recebe novo token e tentativa", async () => {
    const target = await fixture("expiry");
    await seed(target, `expiry-${randomUUID()}`);
    const ownerA = randomUUID();
    const first = (await claim(target.tenant.id, ownerA))[0]!;

    expect(await claim(target.tenant.id, randomUUID())).toEqual([]);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [first.outbox_id],
      ),
    );
    const second = (await claim(target.tenant.id, randomUUID()))[0]!;
    expect(second.outbox_id).toBe(first.outbox_id);
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(second.attempt_count).toBe(2);
  });

  it("renew/release exigem lease atual e cercam worker obsoleto", async () => {
    const target = await fixture("fencing");
    const otherTenant = await fixture("fencing-other-tenant");
    await seed(target, `fencing-${randomUUID()}`);
    const ownerA = randomUUID();
    const first = (await claim(target.tenant.id, ownerA))[0]!;
    const initialState = await leaseState(target.tenant.id, first.outbox_id);
    expect(
      await renew(
        target.tenant.id,
        first.outbox_id,
        randomUUID(),
        first.lease_token,
      ),
    ).toBe(false);
    expect(
      await renew(target.tenant.id, first.outbox_id, ownerA, randomUUID()),
    ).toBe(false);
    expect(
      await renew(
        otherTenant.tenant.id,
        first.outbox_id,
        ownerA,
        first.lease_token,
      ),
    ).toBe(false);
    expect(
      await release(
        otherTenant.tenant.id,
        first.outbox_id,
        ownerA,
        first.lease_token,
        0,
      ),
    ).toBe(false);
    expect(await leaseState(target.tenant.id, first.outbox_id)).toEqual(
      initialState,
    );
    expect(
      await renew(target.tenant.id, first.outbox_id, ownerA, first.lease_token),
    ).toBe(true);
    const afterRenew = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query<{ attempt_count: number; lease_expires_at: Date }>(
          `select attempt_count, lease_expires_at
             from renave.operation_outbox where id = $1`,
          [first.outbox_id],
        ),
    );
    expect(afterRenew.rows[0]!.attempt_count).toBe(1);
    expect(afterRenew.rows[0]!.lease_expires_at.getTime()).toBeGreaterThan(
      first.lease_expires_at.getTime(),
    );

    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [first.outbox_id],
      ),
    );
    const expiredState = await leaseState(target.tenant.id, first.outbox_id);
    expect(
      await renew(target.tenant.id, first.outbox_id, ownerA, first.lease_token),
    ).toBe(false);
    expect(
      await release(
        target.tenant.id,
        first.outbox_id,
        ownerA,
        first.lease_token,
        0,
      ),
    ).toBe(false);
    expect(await leaseState(target.tenant.id, first.outbox_id)).toEqual(
      expiredState,
    );

    const ownerB = randomUUID();
    const second = (await claim(target.tenant.id, ownerB))[0]!;
    const reclaimedState = await leaseState(target.tenant.id, first.outbox_id);
    expect(
      await renew(target.tenant.id, first.outbox_id, ownerA, first.lease_token),
    ).toBe(false);
    expect(
      await release(
        target.tenant.id,
        first.outbox_id,
        ownerA,
        first.lease_token,
        0,
      ),
    ).toBe(false);
    expect(await leaseState(target.tenant.id, first.outbox_id)).toEqual(
      reclaimedState,
    );

    expect(
      await release(
        target.tenant.id,
        second.outbox_id,
        ownerB,
        second.lease_token,
        60,
      ),
    ).toBe(true);
    const releasedState = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query<{
          available_in_future: boolean;
          attempt_count: number;
          delivery_status: string;
          last_error_code: string | null;
          lease_cleared: boolean;
        }>(
          `select attempt_count, delivery_status, last_error_code,
                  available_at > clock_timestamp() as available_in_future,
                  lease_owner is null and lease_token is null
                    and lease_expires_at is null as lease_cleared
             from renave.operation_outbox
            where id = $1`,
          [second.outbox_id],
        ),
    );
    expect(releasedState.rows[0]).toEqual({
      available_in_future: true,
      attempt_count: 2,
      delivery_status: "READY",
      last_error_code: "PRE_DISPATCH_RELEASED",
      lease_cleared: true,
    });
    expect(await claim(target.tenant.id, randomUUID())).toEqual([]);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set available_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [second.outbox_id],
      ),
    );
    const third = (await claim(target.tenant.id, randomUUID()))[0]!;
    expect(third.attempt_count).toBe(3);
  });

  it("renew/release falham após suspensão do tenant ou avanço da operação", async () => {
    const suspended = await fixture("suspended-tenant");
    await seed(suspended, `suspended-${randomUUID()}`);
    const owner = randomUUID();
    const leased = (await claim(suspended.tenant.id, owner))[0]!;
    await withTenant(migratorPool, suspended.tenant.id, (client) =>
      client.query(
        `update renave.tenant set status = 'suspended' where id = $1`,
        [suspended.tenant.id],
      ),
    );
    const suspendedState = await leaseState(
      suspended.tenant.id,
      leased.outbox_id,
    );
    expect(
      await renew(
        suspended.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).toBe(false);
    expect(
      await release(
        suspended.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
        0,
      ),
    ).toBe(false);
    expect(await leaseState(suspended.tenant.id, leased.outbox_id)).toEqual(
      suspendedState,
    );

    const advanced = await fixture("advanced-operation");
    const operationId = await seed(advanced, `advanced-${randomUUID()}`);
    const advancedOwner = randomUUID();
    const advancedLease = (await claim(advanced.tenant.id, advancedOwner))[0]!;
    await withTenant(migratorPool, advanced.tenant.id, (client) =>
      client.query(
        `update renave.operation
            set status = 'SENT', version = version + 1,
                sent_at = clock_timestamp(), updated_at = clock_timestamp()
          where id = $1`,
        [operationId],
      ),
    );
    const advancedState = await leaseState(
      advanced.tenant.id,
      advancedLease.outbox_id,
    );
    expect(
      await renew(
        advanced.tenant.id,
        advancedLease.outbox_id,
        advancedOwner,
        advancedLease.lease_token,
      ),
    ).toBe(false);
    expect(
      await release(
        advanced.tenant.id,
        advancedLease.outbox_id,
        advancedOwner,
        advancedLease.lease_token,
        0,
      ),
    ).toBe(false);
    expect(
      await leaseState(advanced.tenant.id, advancedLease.outbox_id),
    ).toEqual(advancedState);
  });

  it("rollback do claim preserva READY e não incrementa tentativa", async () => {
    const target = await fixture("rollback");
    await seed(target, `rollback-${randomUUID()}`);
    await expect(
      withTenant(migratorPool, target.tenant.id, async (client) => {
        const result = await client.query<LeaseClaim>(
          "select * from renave.claim_operation_send_leases($1, 1)",
          [randomUUID()],
        );
        expect(result.rows).toHaveLength(1);
        throw new Error("rollback esperado");
      }),
    ).rejects.toThrow("rollback esperado");

    const claimed = (await claim(target.tenant.id, randomUUID()))[0]!;
    expect(claimed.attempt_count).toBe(1);
  });

  it("itens futuros ou com operação fora de PENDING_SEND falham fechado", async () => {
    const target = await fixture("closed");
    const future = await seed(target, `future-${randomUUID()}`);
    const telemetry = await seed(target, `telemetry-${randomUUID()}`);
    const sent = await seed(target, `sent-${randomUUID()}`);
    await withTenant(migratorPool, target.tenant.id, async (client) => {
      await client.query(
        `update renave.operation_outbox
            set available_at = clock_timestamp() + interval '1 day'
          where operation_id = $1`,
        [future],
      );
      await client.query(
        `update renave.operation_outbox set attempt_count = 10
          where operation_id = $1`,
        [telemetry],
      );
      await client.query(
        `update renave.operation
            set status = 'SENT', version = version + 1,
                sent_at = clock_timestamp(), updated_at = clock_timestamp()
          where id = $1`,
        [sent],
      );
    });

    const claimed = await claim(target.tenant.id, randomUUID(), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      attempt_count: 11,
      operation_id: telemetry,
    });
  });

  it("pool reutilizado alterna tenants sem carregar lease anterior", async () => {
    const serialPool = createPool(urls.migrator, { max: 1 });
    try {
      const tenantA = await fixture("pool-a");
      const tenantB = await fixture("pool-b");
      const operationA = await seed(tenantA, `pool-a-${randomUUID()}`);
      const operationB = await seed(tenantB, `pool-b-${randomUUID()}`);
      const claimA = await withTenant(
        serialPool,
        tenantA.tenant.id,
        async (client) => {
          const pid = await client.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          );
          const lease = await client.query<LeaseClaim>(
            "select * from renave.claim_operation_send_leases($1, 1)",
            [randomUUID()],
          );
          return { lease: lease.rows[0]!, pid: pid.rows[0]!.pid };
        },
      );
      const afterA = await serialPool.query<{
        pid: number;
        tenant_id: string | null;
      }>(
        `select pg_backend_pid() as pid,
                current_setting('renave.tenant_id', true) as tenant_id`,
      );
      const claimB = await withTenant(
        serialPool,
        tenantB.tenant.id,
        async (client) => {
          const pid = await client.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          );
          const lease = await client.query<LeaseClaim>(
            "select * from renave.claim_operation_send_leases($1, 1)",
            [randomUUID()],
          );
          return { lease: lease.rows[0]!, pid: pid.rows[0]!.pid };
        },
      );
      expect(claimA.lease.operation_id).toBe(operationA);
      expect(claimB.lease.operation_id).toBe(operationB);
      expect(claimA.pid).toBe(claimB.pid);
      expect(afterA.rows[0]!.pid).toBe(claimA.pid);
      expect([null, ""]).toContain(afterA.rows[0]!.tenant_id);
    } finally {
      await serialPool.end();
    }
  });
});
