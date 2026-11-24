import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  InvalidPreparedRenaveMutationError,
  PreparedRenaveMutation,
  prepareRenaveMutation,
  readPreparedRenaveMutation,
  restorePreparedRenaveMutation,
} from "./index.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("PreparedRenaveMutation", () => {
  it("serializa uma vez e isola os bytes do objeto e das cópias devolvidas", async () => {
    let serializations = 0;
    const payload = {
      placa: "QTP4H82",
      toJSON() {
        serializations += 1;
        return { observacao: "ação 🚗", ordem: serializations };
      },
    };

    const prepared = await prepareRenaveMutation(
      "request-stock-entry",
      payload,
    );
    payload.placa = "ALTERADA";
    const firstCopy = prepared.copyBodyBytes();
    firstCopy.fill(0);
    const secondCopy = prepared.copyBodyBytes();

    expect(serializations).toBe(1);
    expect(new TextDecoder().decode(secondCopy)).toBe(
      '{"observacao":"ação 🚗","ordem":1}',
    );
    expect(prepared.byteLength).toBe(secondCopy.byteLength);
    expect(prepared.requestSha256).toBe(sha256(secondCopy));
  });

  it("restaura whitespace e Unicode byte a byte sem reserializar", async () => {
    const exact = Buffer.from('{ "z":1,\n"a":"ação" }\n', "utf8");
    const expectedHash = sha256(exact);

    const prepared = await restorePreparedRenaveMutation(
      "request-stock-entry",
      exact,
      expectedHash,
    );

    expect(Buffer.from(prepared.copyBodyBytes())).toEqual(exact);
    expect(prepared.requestSha256).toBe(expectedHash);
  });

  it("copia o buffer restaurado antes do primeiro await", async () => {
    const expected = Buffer.from('{"placa":"QTP4H82"}', "utf8");
    const source = Uint8Array.from(expected);
    const restoring = restorePreparedRenaveMutation(
      "request-stock-entry",
      source,
      sha256(source),
    );
    source.fill(0);

    const prepared = await restoring;
    expect(Buffer.from(prepared.copyBodyBytes())).toEqual(expected);
  });

  it.each([
    ["undefined", undefined],
    ["BigInt", 1n],
    ["maior que 1 MiB", { value: "x".repeat(1_048_576) }],
  ])("recusa %s antes de produzir um envelope", async (_label, payload) => {
    await expect(
      prepareRenaveMutation("request-stock-entry", payload),
    ).rejects.toBeInstanceOf(InvalidPreparedRenaveMutationError);
  });

  it("recusa referência circular", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      prepareRenaveMutation("request-stock-entry", circular),
    ).rejects.toMatchObject({ reason: "NOT_SERIALIZABLE" });
  });

  it("recusa hash divergente ou malformado", async () => {
    const body = Buffer.from("{}", "utf8");
    await expect(
      restorePreparedRenaveMutation(
        "request-stock-entry",
        body,
        "0".repeat(64),
      ),
    ).rejects.toMatchObject({ reason: "HASH_MISMATCH" });
    await expect(
      restorePreparedRenaveMutation("request-stock-entry", body, "inválido"),
    ).rejects.toMatchObject({ reason: "HASH_FORMAT" });
  });

  it("recusa operação desconhecida nas duas factories", async () => {
    const invalidOperation = "delete-everything" as "request-stock-entry";
    const body = Buffer.from("{}", "utf8");

    await expect(
      prepareRenaveMutation(invalidOperation, {}),
    ).rejects.toMatchObject({ reason: "OPERATION" });
    await expect(
      restorePreparedRenaveMutation(invalidOperation, body, sha256(body)),
    ).rejects.toMatchObject({ reason: "OPERATION" });
  });

  it.each([
    ["UTF-8 inválido", Uint8Array.of(0xc3, 0x28)],
    ["JSON truncado", Buffer.from('{"placa":', "utf8")],
    ["string", Buffer.from('"QTP4H82"', "utf8")],
    ["array", Buffer.from('[{"placa":"QTP4H82"}]', "utf8")],
  ])("recusa corpo restaurado com %s", async (_label, body) => {
    await expect(
      restorePreparedRenaveMutation("request-stock-entry", body, sha256(body)),
    ).rejects.toMatchObject({ reason: "BODY_FORMAT" });
  });

  it.each([
    ["string", "QTP4H82"],
    ["array", [{ placa: "QTP4H82" }]],
  ])("recusa payload cuja raiz serializada é %s", async (_label, payload) => {
    await expect(
      prepareRenaveMutation("request-stock-entry", payload),
    ).rejects.toMatchObject({ reason: "BODY_FORMAT" });
  });

  it("recusa construção refletida, subclasse e objeto de protótipo forjado", () => {
    const RuntimePrepared = PreparedRenaveMutation as unknown as new (
      ...args: unknown[]
    ) => PreparedRenaveMutation;

    expect(() => Reflect.construct(RuntimePrepared, [])).toThrow(
      InvalidPreparedRenaveMutationError,
    );
    class ForgedPrepared extends RuntimePrepared {}
    expect(() => new ForgedPrepared()).toThrow(
      InvalidPreparedRenaveMutationError,
    );

    const prototypeOnly = Object.create(
      PreparedRenaveMutation.prototype,
    ) as PreparedRenaveMutation;
    expect(() => prototypeOnly.copyBodyBytes()).toThrow(
      InvalidPreparedRenaveMutationError,
    );
    expect(() => prototypeOnly.operation).toThrow(
      InvalidPreparedRenaveMutationError,
    );
  });

  it("expõe snapshot nominal sem confiar em shadows ou Proxy", async () => {
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      placa: "QTP4H82",
    });
    const snapshot = readPreparedRenaveMutation(prepared);
    snapshot.body.fill(0);
    expect(
      new TextDecoder().decode(readPreparedRenaveMutation(prepared).body),
    ).toBe('{"placa":"QTP4H82"}');

    const shadowed = Object.create(PreparedRenaveMutation.prototype) as
      PreparedRenaveMutation | Record<string, unknown>;
    Object.defineProperties(shadowed, {
      copyBodyBytes: { value: () => Buffer.from("{}") },
      operation: { value: "request-stock-entry" },
      requestSha256: { value: "0".repeat(64) },
    });
    expect(() =>
      readPreparedRenaveMutation(shadowed as PreparedRenaveMutation),
    ).toThrow(InvalidPreparedRenaveMutationError);
    expect(() =>
      readPreparedRenaveMutation(
        new Proxy(prepared, {}) as PreparedRenaveMutation,
      ),
    ).toThrow(InvalidPreparedRenaveMutationError);
  });

  it("serializa somente metadados, nunca o corpo nem dados pessoais", async () => {
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      cpf: "12345678901",
      email: "pessoa@example.com",
      placa: "QTP4H82",
    });
    const serialized = JSON.stringify(prepared);

    expect(serialized).toContain(prepared.requestSha256);
    expect(serialized).not.toMatch(/12345678901|pessoa@example\.com|QTP4H82/u);
  });

  it("destrói o plaintext de forma idempotente e invalida todas as leituras", async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let internalBody: Uint8Array<ArrayBuffer> | undefined;
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
          internalBody = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
        }
        return digest(algorithm, data);
      });

    try {
      const prepared = await prepareRenaveMutation("request-stock-entry", {
        cpf: "12345678901",
        placa: "QTP4H82",
      });
      expect(internalBody).toBeDefined();
      expect(internalBody?.some((byte) => byte !== 0)).toBe(true);

      prepared.destroy();
      expect(internalBody?.every((byte) => byte === 0)).toBe(true);
      expect(() => prepared.destroy()).not.toThrow();

      for (const read of [
        () => prepared.byteLength,
        () => prepared.operation,
        () => prepared.requestSha256,
        () => prepared.copyBodyBytes(),
        () => prepared.toJSON(),
        () => readPreparedRenaveMutation(prepared),
        () => JSON.stringify(prepared),
      ]) {
        expect(read).toThrow(
          expect.objectContaining({
            code: "INVALID_PREPARED_RENAVE_MUTATION",
            reason: "DESTROYED",
          }),
        );
      }
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("recusa destroy em objeto forjado sem torná-lo um envelope destruído", () => {
    const forged = Object.create(
      PreparedRenaveMutation.prototype,
    ) as PreparedRenaveMutation;

    expect(() => forged.destroy()).toThrow(
      expect.objectContaining({ reason: "NOT_SERIALIZABLE" }),
    );
    expect(() => forged.destroy()).toThrow(
      expect.objectContaining({ reason: "NOT_SERIALIZABLE" }),
    );
  });
});
