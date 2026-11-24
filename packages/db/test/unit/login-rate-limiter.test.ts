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
      parameters.push(values?.[0] as Buffer);
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
    expect(() =>
      decodeLoginRateHmacKeyBase64(Buffer.alloc(16).toString("base64")),
    ).toThrow(LoginRateLimitInputError);
  });
});
