import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  decodeStockExitRateLimitHmacKeyBase64,
  PostgresStockExitRateLimiter,
  StockExitRateLimitInputError,
} from "../../src/stock-exit-rate-limiter.js";

const TENANT = "00000000-0000-4000-8000-000000000082";
const SUBJECT = "oidc|stock-exit-rate-limit";

function hmac(key: Buffer, domain: string, values: readonly string[]) {
  const output = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) output.update("\0").update(value);
  return output.digest();
}

describe("PostgresStockExitRateLimiter", () => {
  it("usa apenas HMACs e domínios exclusivos da saída", async () => {
    const calls: Buffer[][] = [];
    const query = vi.fn(async (_sql: string, values: readonly Buffer[]) => {
      calls.push(values.map((value) => Buffer.from(value)));
      return {
        rows: [{ allowed: true, limited_scope: null, retry_after_seconds: 0 }],
      };
    });
    const source = Buffer.alloc(32, 82);
    const expected = Buffer.from(source);
    const limiter = new PostgresStockExitRateLimiter(
      { query } as unknown as Pool,
      source,
    );
    source.fill(0);
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT }),
    ).resolves.toEqual({ allowed: true });
    expect(calls[0]).toEqual([
      hmac(expected, "stock-exit-limit-tenant-v1", [TENANT]),
      hmac(expected, "stock-exit-limit-subject-v1", [TENANT, SUBJECT]),
    ]);
    expect(JSON.stringify(calls)).not.toContain(SUBJECT);
    expect(JSON.stringify(calls)).not.toContain(TENANT);
    expected.fill(0);
    limiter.destroy();
  });

  it("recusa entrada, decisão e uso após destroy", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            allowed: false,
            limited_scope: "actor",
            retry_after_seconds: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { allowed: true, limited_scope: null, retry_after_seconds: 0 },
          { allowed: true, limited_scope: null, retry_after_seconds: 0 },
        ],
      });
    const limiter = new PostgresStockExitRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 83),
    );
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: "invalid" }),
    ).rejects.toBeInstanceOf(StockExitRateLimitInputError);
    expect(query).not.toHaveBeenCalled();
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT }),
    ).rejects.toBeInstanceOf(StockExitRateLimitInputError);
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT }),
    ).rejects.toBeInstanceOf(StockExitRateLimitInputError);
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT }),
    ).rejects.toBeInstanceOf(StockExitRateLimitInputError);
    limiter.destroy();
    limiter.destroy();
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT }),
    ).rejects.toBeInstanceOf(StockExitRateLimitInputError);
  });

  it("decodifica somente base64 canônico com 32 bytes ou mais", () => {
    const encoded = Buffer.alloc(32, 84).toString("base64");
    expect(decodeStockExitRateLimitHmacKeyBase64(encoded)).toEqual(
      Buffer.alloc(32, 84),
    );
    for (const invalid of ["invalid", Buffer.alloc(31).toString("base64")]) {
      expect(() => decodeStockExitRateLimitHmacKeyBase64(invalid)).toThrow(
        StockExitRateLimitInputError,
      );
    }
  });
});
