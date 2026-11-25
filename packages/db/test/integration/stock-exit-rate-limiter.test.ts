import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import {
  PostgresStockEntryRateLimiter,
  PostgresStockExitRateLimiter,
  type StockExitRateLimitResult,
} from "../../src/api-runtime.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const KEY = Buffer.alloc(32, 82);
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
let appA: Pool;
let appB: Pool;
let migrator: Pool;

beforeAll(() => {
  appA = createPool(urls.app, { max: 8 });
  appB = createPool(urls.app, { max: 8 });
  migrator = createPool(urls.migrator, { max: 4 });
});

beforeEach(async () => {
  await migrator.query("delete from renave_stock_exit_barriers.rate_bucket");
  await migrator.query("delete from renave_runtime.stock_entry_rate_bucket");
  await migrator.query(
    `update renave_stock_exit_barriers.rate_policy set
       global_capacity=100,global_refill_per_second=0.000001,
       tenant_capacity=100,tenant_refill_per_second=0.000001,
       subject_capacity=3,subject_refill_per_second=0.000001`,
  );
});

afterAll(async () => {
  KEY.fill(0);
  await Promise.all([appA.end(), appB.end(), migrator.end()]);
});

it("serializa concorrentes sem exceder a capacidade do subject", async () => {
  const first = new PostgresStockExitRateLimiter(appA, KEY);
  const second = new PostgresStockExitRateLimiter(appB, KEY);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? first : second).acquire({
        subject: "oidc|same-subject",
        tenantId: TENANT_A,
      }),
    ),
  );
  expect(results.filter(({ allowed }) => allowed)).toHaveLength(3);
  const limited = results.filter(
    (result): result is Extract<StockExitRateLimitResult, { allowed: false }> =>
      !result.allowed,
  );
  expect(limited).toHaveLength(9);
  expect(limited.every(({ scope }) => scope === "subject")).toBe(true);
  expect(limited.every(({ retryAfterSeconds }) => retryAfterSeconds >= 1)).toBe(
    true,
  );
  first.destroy();
  second.destroy();
});

it("isola tenant e mantém quotas de entrada e saída independentes", async () => {
  await migrator.query(
    `update renave_stock_exit_barriers.rate_policy set
       global_capacity=100,tenant_capacity=1,subject_capacity=100`,
  );
  const exit = new PostgresStockExitRateLimiter(appA, KEY);
  const entry = new PostgresStockEntryRateLimiter(appA, KEY);
  await expect(
    exit.acquire({ subject: "oidc|a1", tenantId: TENANT_A }),
  ).resolves.toEqual({ allowed: true });
  await expect(
    exit.acquire({ subject: "oidc|a2", tenantId: TENANT_A }),
  ).resolves.toMatchObject({ allowed: false, scope: "tenant" });
  await expect(
    exit.acquire({ subject: "oidc|b", tenantId: TENANT_B }),
  ).resolves.toEqual({ allowed: true });
  await expect(
    entry.acquire({ subject: "oidc|a2", tenantId: TENANT_A }),
  ).resolves.toEqual({ allowed: true });
  const counts = await migrator.query<{ entry: number; exit: number }>(
    `select
       (select count(*)::integer from renave_runtime.stock_entry_rate_bucket) entry,
       (select count(*)::integer from renave_stock_exit_barriers.rate_bucket) exit`,
  );
  expect(counts.rows[0]?.entry).toBeGreaterThan(0);
  expect(counts.rows[0]?.exit).toBeGreaterThan(0);
  exit.destroy();
  entry.destroy();
});

it("aplica a capacidade global entre tenants sem afetar a entrada", async () => {
  await migrator.query(
    `update renave_stock_exit_barriers.rate_policy set
       global_capacity=1,tenant_capacity=100,subject_capacity=100`,
  );
  const exit = new PostgresStockExitRateLimiter(appA, KEY);
  const entry = new PostgresStockEntryRateLimiter(appA, KEY);
  await expect(
    exit.acquire({ subject: "oidc|global-a", tenantId: TENANT_A }),
  ).resolves.toEqual({ allowed: true });
  await expect(
    exit.acquire({ subject: "oidc|global-b", tenantId: TENANT_B }),
  ).resolves.toMatchObject({ allowed: false, scope: "global" });
  await expect(
    entry.acquire({ subject: "oidc|global-b", tenantId: TENANT_B }),
  ).resolves.toEqual({ allowed: true });
  exit.destroy();
  entry.destroy();
});

it("recusa acesso a tabelas e digests inválidos", async () => {
  await expect(
    appA.query("select * from renave_stock_exit_barriers.rate_bucket"),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    appA.query(
      "select * from renave_stock_exit_barriers.consume_rate_limit($1,$2)",
      [Buffer.alloc(31), Buffer.alloc(32)],
    ),
  ).rejects.toMatchObject({ code: "22023" });
});

it("não devolve quota quando a transação de negócio posterior faz rollback", async () => {
  await migrator.query(
    `update renave_stock_exit_barriers.rate_policy set
       global_capacity=100,tenant_capacity=1,subject_capacity=100`,
  );
  const limiter = new PostgresStockExitRateLimiter(appA, KEY);
  await expect(
    limiter.acquire({ subject: "oidc|rollback", tenantId: TENANT_A }),
  ).resolves.toEqual({ allowed: true });
  const client = await appA.connect();
  try {
    await client.query("begin");
    await client.query("select 1");
    await client.query("rollback");
  } finally {
    client.release();
  }
  await expect(
    limiter.acquire({ subject: "oidc|rollback-2", tenantId: TENANT_A }),
  ).resolves.toMatchObject({ allowed: false, scope: "tenant" });
  limiter.destroy();
});
