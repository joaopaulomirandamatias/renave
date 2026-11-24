import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  inject,
} from "vitest";

import {
  PostgresLoginRateLimiter,
  purgeStaleLoginRateBuckets,
} from "../../src/login-rate-limiter.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");

let appPool: Pool;
let identityPool: Pool;
let migratorPool: Pool;
let limiter: PostgresLoginRateLimiter;

beforeAll(() => {
  appPool = createPool(urls.app, { max: 4 });
  identityPool = createPool(urls.identity, { max: 24 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  limiter = new PostgresLoginRateLimiter(identityPool, Buffer.alloc(32, 4));
});

beforeEach(async () => {
  await migratorPool.query("delete from renave_identity.login_rate_bucket");
  await migratorPool.query(
    `update renave_identity.login_rate_policy
        set global_capacity = 100,
            global_refill_per_second = 0.000001,
            client_capacity = 10,
            client_refill_per_second = 0.000001`,
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), identityPool?.end(), migratorPool?.end()]);
});

describe("rate limit distribuído do login", () => {
  it("consome exatamente a capacidade do cliente sob concorrência", async () => {
    await migratorPool.query(
      "update renave_identity.login_rate_policy set client_capacity = 5",
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume("203.0.113.10")),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    const limited = results.filter((result) => !result.allowed);
    expect(limited).toHaveLength(15);
    expect(limited.every((result) => result.scope === "client")).toBe(true);
  });

  it("o bucket global protege contra pulverização por muitos clientes", async () => {
    await migratorPool.query(
      `update renave_identity.login_rate_policy
          set global_capacity = 3, client_capacity = 100`,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        limiter.consume(`198.51.100.${index + 1}`),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(
      results
        .filter((result) => !result.allowed)
        .every((result) => result.scope === "global"),
    ).toBe(true);
    const { rows } = await migratorPool.query<{ count: number }>(
      `select count(*)::integer as count
         from renave_identity.login_rate_bucket
        where scope = 'client'`,
    );
    expect(rows[0]?.count).toBe(3);
  });

  it("nega tabelas diretamente e execução ao papel de negócio", async () => {
    await expect(
      identityPool.query("select * from renave_identity.login_rate_bucket"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query(
        "select * from renave_identity.consume_login_rate_limit($1)",
        [Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query(
        "select * from renave_identity.consume_login_rate_limit($1)",
        [Buffer.alloc(31)],
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("remove em lote somente buckets de cliente inativos", async () => {
    await limiter.consume("203.0.113.77");
    await migratorPool.query(
      `update renave_identity.login_rate_bucket
          set last_seen_at = clock_timestamp() - interval '49 hours'
        where scope = 'client'`,
    );

    await expect(purgeStaleLoginRateBuckets(identityPool, 10)).resolves.toBe(1);
    const { rows } = await migratorPool.query<{ scope: string }>(
      "select scope from renave_identity.login_rate_bucket order by scope",
    );
    expect(rows).toEqual([{ scope: "global" }]);
  });
});
