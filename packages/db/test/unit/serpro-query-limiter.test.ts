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
});
