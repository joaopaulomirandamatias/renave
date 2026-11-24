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

import { PostgresSerproQueryLimiter } from "../../src/serpro-query-limiter.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const key = Buffer.alloc(32, 9);

let adminPool: Pool;
let appPoolA: Pool;
let appPoolB: Pool;
let identityPool: Pool;

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPoolA = createPool(urls.app, { max: 4 });
  appPoolB = createPool(urls.app, { max: 4 });
  identityPool = createPool(urls.identity, { max: 1 });
});

beforeEach(async () => {
  await adminPool.query("truncate renave_operations.serpro_query_lease");
  await adminPool.query("truncate renave_operations.serpro_query_window");
  await adminPool.query(
    `update renave_operations.serpro_query_policy
        set global_concurrency = 3, tenant_concurrency = 2,
            actor_concurrency = 1, global_per_window = 100,
            tenant_per_window = 100, actor_per_window = 100,
            window_size = interval '1 minute', lease_ttl = interval '3 minutes'
      where singleton`,
  );
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPoolA?.end(),
    appPoolB?.end(),
    identityPool?.end(),
  ]);
});

function input(tenantId: string, subject: string, establishmentId: string) {
  return { establishmentId, subject, tenantId };
}

describe.sequential("limite distribuído de consultas SERPRO", () => {
  it("impõe concorrência por tenant sem permitir monopolizar o global", async () => {
    const limiterA = new PostgresSerproQueryLimiter(appPoolA, key);
    const limiterB = new PostgresSerproQueryLimiter(appPoolB, key);
    const first = await limiterA.acquire(
      input("tenant-a", "subject-1", "store-1"),
    );
    const second = await limiterB.acquire(
      input("tenant-a", "subject-2", "store-2"),
    );
    const denied = await limiterA.acquire(
      input("tenant-a", "subject-3", "store-3"),
    );
    const otherTenant = await limiterB.acquire(
      input("tenant-b", "subject-4", "store-4"),
    );

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(denied).toMatchObject({
      allowed: false,
      scope: "tenant_concurrency",
    });
    expect(otherTenant.allowed).toBe(true);

    await Promise.all(
      [first, second, otherTenant].map((result) =>
        result.allowed ? result.permit.release() : Promise.resolve(),
      ),
    );
    const { rows } = await adminPool.query<{ count: string }>(
      "select count(*)::text as count from renave_operations.serpro_query_lease",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("contabiliza volume mesmo depois de liberar a concorrência", async () => {
    await adminPool.query(
      `update renave_operations.serpro_query_policy
          set actor_per_window = 2, actor_concurrency = 1
        where singleton`,
    );
    const limiter = new PostgresSerproQueryLimiter(appPoolA, key);
    const request = input("tenant-a", "subject-1", "store-1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acquired = await limiter.acquire(request);
      expect(acquired.allowed).toBe(true);
      if (acquired.allowed) await acquired.permit.release();
    }
    await expect(limiter.acquire(request)).resolves.toMatchObject({
      allowed: false,
      scope: "actor_rate",
    });
  });

  it("recupera lease expirado pelo relógio do banco", async () => {
    const limiter = new PostgresSerproQueryLimiter(appPoolA, key);
    const request = input("tenant-a", "subject-1", "store-1");
    const abandoned = await limiter.acquire(request);
    expect(abandoned.allowed).toBe(true);
    await adminPool.query(
      `update renave_operations.serpro_query_lease
          set acquired_at = clock_timestamp() - interval '10 minutes',
              expires_at = clock_timestamp() - interval '1 second'`,
    );
    await expect(limiter.acquire(request)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("nega tabelas e funções aos papéis errados", async () => {
    await expect(
      appPoolA.query("select * from renave_operations.serpro_query_lease"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query(
        "select * from renave_runtime.acquire_serpro_query_permit(gen_random_uuid(), $1, $1)",
        [Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
