import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  assertStockEntryRuntimeKeyGeneration,
  decodeStockEntryRateLimitHmacKeyBase64,
  PostgresStockEntryRateLimiter,
  StockEntryRateLimitInputError,
  StockEntryRuntimeKeyGenerationError,
} from "../../src/stock-entry-rate-limiter.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000055";
const SUBJECT = "oidc|stock-entry-rate-limit";

function hmac(key: Buffer, domain: string, values: readonly string[]): Buffer {
  const result = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) result.update("\0", "utf8").update(value, "utf8");
  return result.digest();
}

describe("decodeStockEntryRateLimitHmacKeyBase64", () => {
  it("aceita somente base64 canônico com pelo menos 32 bytes", () => {
    const encoded = Buffer.alloc(32, 7).toString("base64");
    expect(decodeStockEntryRateLimitHmacKeyBase64(encoded)).toEqual(
      Buffer.alloc(32, 7),
    );
    expect(() => decodeStockEntryRateLimitHmacKeyBase64("não-base64")).toThrow(
      StockEntryRateLimitInputError,
    );
    expect(() =>
      decodeStockEntryRateLimitHmacKeyBase64(
        Buffer.alloc(31).toString("base64"),
      ),
    ).toThrow(StockEntryRateLimitInputError);
  });
});

describe("assertStockEntryRuntimeKeyGeneration", () => {
  it("aceita somente a geração provisionada sem enviar peppers", async () => {
    const calls: unknown[][] = [];
    const query = vi.fn(async (_sql: string, values: unknown[]) => {
      calls.push([values[0], Buffer.from(values[1] as Uint8Array)]);
      return { rows: [{ matches: true }] };
    });
    const fingerprint = Buffer.alloc(32, 77);

    await expect(
      assertStockEntryRuntimeKeyGeneration(
        { query } as unknown as Pick<Pool, "query">,
        { fingerprint, generationId: "held-local-v1" },
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([["held-local-v1", Buffer.alloc(32, 77)]]);
    expect(fingerprint).toEqual(Buffer.alloc(32, 77));
  });

  it("falha fechado para pin ausente, divergente ou entrada inválida", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ matches: false }] });
    await expect(
      assertStockEntryRuntimeKeyGeneration(
        { query } as unknown as Pick<Pool, "query">,
        {
          fingerprint: Buffer.alloc(32, 78),
          generationId: "held-local-v2",
        },
      ),
    ).rejects.toBeInstanceOf(StockEntryRuntimeKeyGenerationError);
    await expect(
      assertStockEntryRuntimeKeyGeneration(
        { query } as unknown as Pick<Pool, "query">,
        {
          fingerprint: Buffer.alloc(31),
          generationId: "held-local-v2",
        },
      ),
    ).rejects.toBeInstanceOf(StockEntryRuntimeKeyGenerationError);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("PostgresStockEntryRateLimiter", () => {
  it("envia somente HMACs separados e mantém cópia defensiva da chave", async () => {
    const calls: Buffer[][] = [];
    const query = vi.fn(async (_sql: string, values: readonly Buffer[]) => {
      calls.push(values.map((value) => Buffer.from(value)));
      return {
        rows: [{ allowed: true, limited_scope: null, retry_after_seconds: 0 }],
      };
    });
    const sourceKey = Buffer.alloc(32, 11);
    const expectedKey = Buffer.from(sourceKey);
    const limiter = new PostgresStockEntryRateLimiter(
      { query } as unknown as Pool,
      sourceKey,
    );
    sourceKey.fill(99);

    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT_ID }),
    ).resolves.toEqual({ allowed: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(
      hmac(expectedKey, "stock-entry-limit-tenant-v1", [TENANT_ID]),
    );
    expect(calls[0]?.[1]).toEqual(
      hmac(expectedKey, "stock-entry-limit-actor-v1", [TENANT_ID, SUBJECT]),
    );
    expect(calls[0]?.[0]).not.toEqual(calls[0]?.[1]);
    expect(JSON.stringify(calls)).not.toContain(SUBJECT);
    expect(JSON.stringify(calls)).not.toContain(TENANT_ID);
    expectedKey.fill(0);
    limiter.destroy();
  });

  it("falha fechado para entrada, ausência de linha e decisão inválida", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            allowed: false,
            limited_scope: "other",
            retry_after_seconds: 0,
          },
        ],
      });
    const limiter = new PostgresStockEntryRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 12),
    );

    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: "inválido" }),
    ).rejects.toBeInstanceOf(StockEntryRateLimitInputError);
    expect(query).not.toHaveBeenCalled();
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT_ID }),
    ).rejects.toThrow("não retornou resultado");
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT_ID }),
    ).rejects.toThrow("decisão inválida");
    limiter.destroy();
  });

  it("destroy é idempotente e impede consulta posterior", async () => {
    const query = vi.fn();
    const limiter = new PostgresStockEntryRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 13),
    );

    limiter.destroy();
    limiter.destroy();
    await expect(
      limiter.acquire({ subject: SUBJECT, tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(StockEntryRateLimitInputError);
    expect(query).not.toHaveBeenCalled();
  });
});
