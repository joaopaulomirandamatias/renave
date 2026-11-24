import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  decodeLoginRateHmacKeyBase64,
  LoginRateLimitInputError,
  PostgresLoginRateLimiter,
} from "../../src/login-rate-limiter.js";

describe("PostgresLoginRateLimiter", () => {
  it("normaliza IPv6 antes do HMAC e nunca envia o endereço ao banco", async () => {
    const parameters: Buffer[] = [];
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      parameters.push(Buffer.from(values?.[0] as Buffer));
      return {
        rows: [{ allowed: true, limited_scope: null, retry_after_seconds: 0 }],
      };
    });
    const limiter = new PostgresLoginRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 7),
    );

    await limiter.consume("2001:0db8:0:0:0:0:0:1");
    await limiter.consume("2001:db8::1");

    const first = parameters[0]!;
    const second = parameters[1]!;
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    expect(query.mock.calls.flat().join(" ")).not.toContain("2001:db8");
  });

  it("mantém chave e query fora das propriedades e copia a chave de entrada", async () => {
    const inputKey = Buffer.alloc(32, 7);
    const expectedKey = Buffer.from(inputKey);
    let observed: Buffer | undefined;
    const pool = {
      marker: "pool-bound",
      async query(this: { marker: string }, _sql: string, values?: unknown[]) {
        expect(this.marker).toBe("pool-bound");
        observed = Buffer.from(values?.[0] as Buffer);
        return {
          rows: [
            { allowed: true, limited_scope: null, retry_after_seconds: 0 },
          ],
        };
      },
    };
    const limiter = new PostgresLoginRateLimiter(
      pool as unknown as Pool,
      inputKey,
    );

    expect(Reflect.ownKeys(limiter)).toEqual([]);
    inputKey.fill(0);
    await limiter.consume("127.0.0.1");

    expect(observed).toEqual(
      createHmac("sha256", expectedKey).update("127.0.0.1", "utf8").digest(),
    );
    expectedKey.fill(0);
  });

  it.each([
    {
      name: "sucesso",
      result: {
        rows: [{ allowed: true, limited_scope: null, retry_after_seconds: 0 }],
      },
      rejects: false,
    },
    { name: "resultado ausente", result: { rows: [] }, rejects: true },
    {
      name: "decisão inválida",
      result: {
        rows: [
          {
            allowed: false,
            limited_scope: "unknown",
            retry_after_seconds: 0,
          },
        ],
      },
      rejects: true,
    },
  ])("zera o digest depois de $name", async ({ result, rejects }) => {
    let digest: Buffer | undefined;
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      digest = values?.[0] as Buffer;
      expect(digest.some((byte) => byte !== 0)).toBe(true);
      return result;
    });
    const limiter = new PostgresLoginRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 7),
    );

    const operation = limiter.consume("127.0.0.1");
    if (rejects) await expect(operation).rejects.toThrow();
    else
      await expect(operation).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });

    expect(digest).toBeDefined();
    expect(digest!.every((byte) => byte === 0)).toBe(true);
  });

  it("zera o digest quando a consulta falha", async () => {
    let digest: Buffer | undefined;
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      digest = values?.[0] as Buffer;
      throw new Error("database unavailable");
    });
    const limiter = new PostgresLoginRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 7),
    );

    await expect(limiter.consume("127.0.0.1")).rejects.toThrow(
      "database unavailable",
    );
    expect(digest!.every((byte) => byte === 0)).toBe(true);
  });

  it("recusa endereço inválido antes de consultar o banco", async () => {
    const query = vi.fn();
    const limiter = new PostgresLoginRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 7),
    );
    await expect(
      limiter.consume("proxy.example.invalid"),
    ).rejects.toBeInstanceOf(LoginRateLimitInputError);
    expect(query).not.toHaveBeenCalled();
  });

  it("exige chave base64 canônica de pelo menos 32 bytes", () => {
    const valid = Buffer.alloc(32, 9).toString("base64");
    expect(decodeLoginRateHmacKeyBase64(valid)).toEqual(Buffer.alloc(32, 9));
    expect(() => decodeLoginRateHmacKeyBase64("not-base64")).toThrow(
      LoginRateLimitInputError,
    );
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      expect(() =>
        decodeLoginRateHmacKeyBase64(Buffer.alloc(16).toString("base64")),
      ).toThrow(LoginRateLimitInputError);
      expect(fill).toHaveBeenCalledWith(0);
    } finally {
      fill.mockRestore();
    }
  });

  it("destroy é idempotente e bloqueia uso antes de validar ou consultar", async () => {
    const query = vi.fn();
    const limiter = new PostgresLoginRateLimiter(
      { query } as unknown as Pool,
      Buffer.alloc(32, 7),
    );

    limiter.destroy();
    expect(() => limiter.destroy()).not.toThrow();
    await expect(limiter.consume("endereço inválido")).rejects.toBeInstanceOf(
      LoginRateLimitInputError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
