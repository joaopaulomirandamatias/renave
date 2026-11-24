import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresTenantAdminRateLimiter,
  TenantAdminRateLimitInputError,
} from "../../src/tenant-admin-rate-limiter.js";

const input = {
  subject: "oidc|tenant-admin-test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

function tenantDigest(key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update("tenant-admin-tenant-v1", "utf8")
    .update("\0", "utf8")
    .update(input.tenantId, "utf8")
    .digest();
}

describe("PostgresTenantAdminRateLimiter", () => {
  it("oculta o estado, copia a chave, vincula a query e zera os digests", async () => {
    const inputKey = Buffer.alloc(32, 9);
    const expectedKey = Buffer.from(inputKey);
    let tenantKey: Buffer | undefined;
    let actorKey: Buffer | undefined;
    let tenantSnapshot: Buffer | undefined;
    const pool = {
      marker: "pool-bound",
      async query(this: { marker: string }, _sql: string, values?: unknown[]) {
        expect(this.marker).toBe("pool-bound");
        tenantKey = values?.[0] as Buffer;
        actorKey = values?.[1] as Buffer;
        tenantSnapshot = Buffer.from(tenantKey);
        return {
          rows: [
            { allowed: true, limited_scope: null, retry_after_seconds: 0 },
          ],
        };
      },
    };
    const limiter = new PostgresTenantAdminRateLimiter(
      pool as unknown as Pool,
      inputKey,
    );

    expect(Reflect.ownKeys(limiter)).toEqual([]);
    inputKey.fill(0);
    await expect(limiter.consume(input)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });

    expect(tenantSnapshot).toEqual(tenantDigest(expectedKey));
    expect(tenantKey!.every((byte) => byte === 0)).toBe(true);
    expect(actorKey!.every((byte) => byte === 0)).toBe(true);
    expectedKey.fill(0);
  });

  it("zera os digests quando a query falha", async () => {
    let tenantKey: Buffer | undefined;
    let actorKey: Buffer | undefined;
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      tenantKey = values?.[0] as Buffer;
      actorKey = values?.[1] as Buffer;
      throw new Error("database unavailable");
    });
    const limiter = new PostgresTenantAdminRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 9),
    );

    await expect(limiter.consume(input)).rejects.toThrow(
      "database unavailable",
    );
    expect(tenantKey!.every((byte) => byte === 0)).toBe(true);
    expect(actorKey!.every((byte) => byte === 0)).toBe(true);
  });

  it("destroy é idempotente e bloqueia uso antes de validar ou consultar", async () => {
    const query = vi.fn();
    const limiter = new PostgresTenantAdminRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 9),
    );

    limiter.destroy();
    expect(() => limiter.destroy()).not.toThrow();
    await expect(
      limiter.consume({ subject: "", tenantId: "" }),
    ).rejects.toBeInstanceOf(TenantAdminRateLimitInputError);
    expect(query).not.toHaveBeenCalled();
  });
});
