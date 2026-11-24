import { describe, expect, it } from "vitest";

import {
  decodeSerproQueryHmacKeyBase64,
  PostgresSerproQueryLimiter,
  SerproQueryLimitInputError,
} from "../../src/serpro-query-limiter.js";

describe("limite de consultas SERPRO", () => {
  it("aceita somente chave base64 canônica com pelo menos 32 bytes", () => {
    const encoded = Buffer.alloc(32, 7).toString("base64");
    expect(decodeSerproQueryHmacKeyBase64(encoded)).toEqual(
      Buffer.alloc(32, 7),
    );
    expect(() => decodeSerproQueryHmacKeyBase64("não-base64")).toThrow(
      SerproQueryLimitInputError,
    );
    expect(() =>
      decodeSerproQueryHmacKeyBase64(Buffer.alloc(16).toString("base64")),
    ).toThrow(SerproQueryLimitInputError);
  });

  it("recusa chave curta no construtor sem consultar o banco", () => {
    expect(
      () => new PostgresSerproQueryLimiter({} as never, Buffer.alloc(31)),
    ).toThrow(SerproQueryLimitInputError);
  });

  it("mantém pool e chave fora da instância e recusa forja, proxy e subclasse", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            allowed: false,
            limited_scope: "global_rate",
            retry_after_seconds: 1,
          },
        ],
      }),
    } as never;
    const key = Buffer.alloc(32, 4);
    const limiter = new PostgresSerproQueryLimiter(pool, key);
    key.fill(9);
    expect(Object.keys(limiter)).toEqual([]);
    expect(Object.isFrozen(limiter)).toBe(true);
    await expect(
      PostgresSerproQueryLimiter.prototype.acquire.call(
        Object.create(PostgresSerproQueryLimiter.prototype),
        { establishmentId: "e", subject: "s", tenantId: "t" },
      ),
    ).rejects.toThrow(SerproQueryLimitInputError);
    await expect(
      PostgresSerproQueryLimiter.prototype.acquire.call(
        new Proxy(limiter, {}),
        {
          establishmentId: "e",
          subject: "s",
          tenantId: "t",
        },
      ),
    ).rejects.toThrow(SerproQueryLimitInputError);
    class ForgedLimiter extends PostgresSerproQueryLimiter {}
    expect(() => new ForgedLimiter(pool, Buffer.alloc(32))).toThrow(
      SerproQueryLimitInputError,
    );
    limiter.destroy();
    await expect(
      limiter.acquire({ establishmentId: "e", subject: "s", tenantId: "t" }),
    ).rejects.toThrow(SerproQueryLimitInputError);
  });
});
