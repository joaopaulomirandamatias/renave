import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from "vitest";

import {
  assertStockEntryRuntimeKeyGeneration,
  PostgresStockEntryRateLimiter,
  StockEntryRuntimeKeyGenerationError,
  type StockEntryRateLimitResult,
} from "../../src/stock-entry-rate-limiter.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const KEY = Buffer.alloc(32, 55);
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

let appPoolA: Pool;
let appPoolB: Pool;
let identityPool: Pool;
let maintenancePool: Pool;
let migratorPool: Pool;
let workerPool: Pool;

beforeAll(() => {
  appPoolA = createPool(urls.app, { max: 8 });
  appPoolB = createPool(urls.app, { max: 8 });
  identityPool = createPool(urls.identity, { max: 1 });
  maintenancePool = createPool(urls.maintenance, { max: 1 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  workerPool = createPool(urls.operationWorker, { max: 1 });
});

beforeEach(async () => {
  await migratorPool.query(
    "delete from renave_runtime.stock_entry_rate_bucket",
  );
  await migratorPool.query(
    `update renave_runtime.stock_entry_rate_policy
        set global_capacity = 120,
            global_refill_per_second = 0.000001,
            tenant_capacity = 60,
            tenant_refill_per_second = 0.000001,
            actor_capacity = 15,
            actor_refill_per_second = 0.000001`,
  );
});

afterAll(async () => {
  KEY.fill(0);
  await Promise.all([
    appPoolA?.end(),
    appPoolB?.end(),
    identityPool?.end(),
    maintenancePool?.end(),
    migratorPool?.end(),
    workerPool?.end(),
  ]);
});

describe.sequential("limite distribuído de entrada de estoque", () => {
  it("mantém o fingerprint e o contrato do runtime íntegros", async () => {
    const result = await migratorPool.query<{
      fingerprint: string;
      ready: boolean;
    }>(
      `select
         renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
           as fingerprint,
         renave_runtime.api_contract_ready() as ready`,
    );
    expect(result.rows[0]?.fingerprint).toBe(
      "5c74edf2f5f0865c582c040a55c5761e8d0ca944e8aedb8a36369aa70a9d4da2",
    );
    expect(result.rows[0]?.ready).toBe(true);
  });

  it("compartilha atomicamente a capacidade do ator entre réplicas", async () => {
    await migratorPool.query(
      `update renave_runtime.stock_entry_rate_policy
          set global_capacity = 100,
              tenant_capacity = 100,
              actor_capacity = 3`,
    );
    const limiterA = new PostgresStockEntryRateLimiter(appPoolA, KEY);
    const limiterB = new PostgresStockEntryRateLimiter(appPoolB, KEY);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? limiterA : limiterB).acquire({
          subject: "oidc|same-actor",
          tenantId: TENANT_A,
        }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    const limited = results.filter(
      (
        result,
      ): result is Extract<StockEntryRateLimitResult, { allowed: false }> =>
        !result.allowed,
    );
    expect(limited).toHaveLength(9);
    expect(limited.every((result) => result.scope === "actor")).toBe(true);
    expect(limited.every((result) => result.retryAfterSeconds >= 1)).toBe(true);
    limiterA.destroy();
    limiterB.destroy();
  });

  it("recusa réplicas com geração ou fingerprint divergentes", async () => {
    const fingerprint = Buffer.alloc(32, 91);
    await expect(
      assertStockEntryRuntimeKeyGeneration(appPoolA, {
        fingerprint,
        generationId: "held-local-v1",
      }),
    ).rejects.toBeInstanceOf(StockEntryRuntimeKeyGenerationError);

    await migratorPool.query(
      `insert into renave_runtime.stock_entry_runtime_key_generation (
         generation_id, runtime_fingerprint
       ) values ($1, $2)`,
      ["held-local-v1", fingerprint],
    );
    await expect(
      assertStockEntryRuntimeKeyGeneration(appPoolA, {
        fingerprint,
        generationId: "held-local-v1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertStockEntryRuntimeKeyGeneration(appPoolB, {
        fingerprint: Buffer.alloc(32, 92),
        generationId: "held-local-v1",
      }),
    ).rejects.toBeInstanceOf(StockEntryRuntimeKeyGenerationError);
    await expect(
      assertStockEntryRuntimeKeyGeneration(appPoolB, {
        fingerprint,
        generationId: "held-local-v2",
      }),
    ).rejects.toBeInstanceOf(StockEntryRuntimeKeyGenerationError);

    await expect(
      appPoolA.query(
        `insert into renave_runtime.stock_entry_runtime_key_generation (
           generation_id, runtime_fingerprint
         ) values ('forbidden', $1)`,
        [Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    for (const statement of [
      `update renave_runtime.stock_entry_runtime_key_generation
          set generation_id = 'held-local-v2'`,
      "delete from renave_runtime.stock_entry_runtime_key_generation",
      "truncate renave_runtime.stock_entry_runtime_key_generation",
    ]) {
      await expect(migratorPool.query(statement)).rejects.toMatchObject({
        code: "42501",
      });
    }
    await expect(
      migratorPool.query(
        `insert into renave_runtime.stock_entry_runtime_key_generation (
           generation_id, runtime_fingerprint
         ) values ('held-local-v2', $1)`,
        [Buffer.alloc(32, 93)],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const locker = await appPoolA.connect();
    try {
      await locker.query("begin");
      await locker.query(
        "select renave_runtime.matches_stock_entry_runtime_key_generation($1, $2)",
        ["held-local-v1", fingerprint],
      );
      let settled = false;
      const attemptedRotation = migratorPool
        .query(
          `update renave_runtime.stock_entry_runtime_key_generation
              set runtime_fingerprint = $1`,
          [Buffer.alloc(32, 94)],
        )
        .finally(() => {
          settled = true;
        });
      const rotationExpectation = expect(
        attemptedRotation,
      ).rejects.toMatchObject({ code: "42501" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await locker.query("commit");
      await rotationExpectation;
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
    }
    fingerprint.fill(0);
  });

  it("isola tenants e aplica os escopos tenant e global", async () => {
    await migratorPool.query(
      `update renave_runtime.stock_entry_rate_policy
          set global_capacity = 100,
              tenant_capacity = 1,
              actor_capacity = 100`,
    );
    const limiter = new PostgresStockEntryRateLimiter(appPoolA, KEY);
    await expect(
      limiter.acquire({ subject: "oidc|a-1", tenantId: TENANT_A }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.acquire({ subject: "oidc|a-2", tenantId: TENANT_A }),
    ).resolves.toMatchObject({ allowed: false, scope: "tenant" });
    await expect(
      limiter.acquire({ subject: "oidc|b-1", tenantId: TENANT_B }),
    ).resolves.toEqual({ allowed: true });

    await migratorPool.query(
      "delete from renave_runtime.stock_entry_rate_bucket",
    );
    await migratorPool.query(
      `update renave_runtime.stock_entry_rate_policy
          set global_capacity = 1,
              tenant_capacity = 100,
              actor_capacity = 100`,
    );
    await expect(
      limiter.acquire({ subject: "oidc|global-a", tenantId: TENANT_A }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.acquire({ subject: "oidc|global-b", tenantId: TENANT_B }),
    ).resolves.toMatchObject({ allowed: false, scope: "global" });
    limiter.destroy();
  });

  it("remove no máximo cem buckets antigos por consumo", async () => {
    const values = Array.from({ length: 102 }, (_, index) => [
      "tenant",
      Buffer.alloc(32, index + 1),
      1,
    ]);
    for (const [scope, scopeKey, units] of values) {
      await migratorPool.query(
        `insert into renave_runtime.stock_entry_rate_bucket (
           scope, scope_key, available_units, last_refill_at, last_seen_at
         ) values ($1, $2, $3, clock_timestamp() - interval '49 hours',
                   clock_timestamp() - interval '49 hours')`,
        [scope, scopeKey, units],
      );
    }
    const limiter = new PostgresStockEntryRateLimiter(appPoolA, KEY);
    await limiter.acquire({ subject: "oidc|cleanup", tenantId: TENANT_A });

    const result = await migratorPool.query<{ count: number }>(
      `select count(*)::integer as count
         from renave_runtime.stock_entry_rate_bucket
        where scope <> 'global'
          and last_seen_at < clock_timestamp() - interval '48 hours'`,
    );
    expect(result.rows[0]?.count).toBe(2);
    limiter.destroy();
  });

  it("serializa cleanup e consumo do mesmo ator sob o lock global", async () => {
    await migratorPool.query(
      `update renave_runtime.stock_entry_rate_policy
          set global_capacity = 100,
              tenant_capacity = 100,
              actor_capacity = 100`,
    );
    const actorKey = createHmac("sha256", KEY)
      .update("stock-entry-limit-actor-v1", "utf8")
      .update("\0", "utf8")
      .update(TENANT_A, "utf8")
      .update("\0", "utf8")
      .update("oidc|stale-actor", "utf8")
      .digest();
    await migratorPool.query(
      `insert into renave_runtime.stock_entry_rate_bucket (
         scope, scope_key, available_units, last_refill_at, last_seen_at
       ) values ('actor', $1, 100, clock_timestamp() - interval '49 hours',
                 clock_timestamp() - interval '49 hours')`,
      [actorKey],
    );
    actorKey.fill(0);
    const limiterA = new PostgresStockEntryRateLimiter(appPoolA, KEY);
    const limiterB = new PostgresStockEntryRateLimiter(appPoolB, KEY);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? limiterA : limiterB).acquire({
          subject: "oidc|stale-actor",
          tenantId: TENANT_A,
        }),
      ),
    );
    expect(results.every((result) => result.allowed)).toBe(true);
    limiterA.destroy();
    limiterB.destroy();
  });

  it("expõe somente a função ao renave_app e valida digests", async () => {
    await expect(
      appPoolA.query("select * from renave_runtime.stock_entry_rate_bucket"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPoolA.query(
        "select * from renave_runtime.stock_entry_runtime_key_generation",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const pool of [identityPool, maintenancePool, workerPool]) {
      await expect(
        pool.query(
          "select * from renave_runtime.consume_stock_entry_rate_limit($1, $2)",
          [Buffer.alloc(32), Buffer.alloc(32, 1)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pool.query(
          "select renave_runtime.matches_stock_entry_runtime_key_generation($1, $2)",
          ["held-local-v1", Buffer.alloc(32)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      appPoolA.query(
        "select * from renave_runtime.consume_stock_entry_rate_limit($1, $2)",
        [Buffer.alloc(31), Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });
});
