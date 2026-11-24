import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  prepareRenaveMutation,
  restorePreparedRenaveMutation,
} from "@seu-renave/renave-connector";

import {
  OperationRequestCipher,
  OperationRequestConfigurationError,
  OperationRequestDecryptionError,
  OperationRequestInputError,
  type EncryptedOperationRequest,
  type OperationRequestBinding,
} from "./operation-request-crypto.js";

const binding: OperationRequestBinding = {
  actorSubjectHash: Buffer.alloc(32, 1),
  correlationId: "33333333-3333-4333-8333-333333333333",
  environment: "homologation",
  establishmentId: "22222222-2222-4222-8222-222222222222",
  idempotencyKeyDigest: Buffer.alloc(32, 2),
  kind: "USED_STOCK_ENTRY",
  mutationFamily: "STOCK_ENTRY",
  requestSchemaVersion: 1,
  tenantId: "11111111-1111-4111-8111-111111111111",
  vehicleKeyDigest: Buffer.alloc(32, 3),
};

function createCipher(
  activeKeyId = "operation-key-2026-11",
  keys: ReadonlyMap<string, Uint8Array> = new Map([
    ["operation-key-2026-11", Buffer.alloc(32, 7)],
  ]),
  environment: "homologation" | "production" = "homologation",
): OperationRequestCipher {
  return new OperationRequestCipher({ activeKeyId, environment, keys });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneEnvelope(
  source: EncryptedOperationRequest,
): EncryptedOperationRequest {
  return {
    ...source,
    authTag: Buffer.from(source.authTag),
    ciphertext: Buffer.from(source.ciphertext),
    nonce: Buffer.from(source.nonce),
  };
}

describe("OperationRequestCipher", () => {
  it("preserva exatamente whitespace, Unicode e newline", async () => {
    const exact = Buffer.from('{ "z":1,\n"a":"ação 🚗" }\n', "utf8");
    const prepared = await restorePreparedRenaveMutation(
      "request-stock-entry",
      exact,
      sha256(exact),
    );
    const cipher = createCipher();

    const encrypted = cipher.encrypt(prepared, binding);
    const restored = await cipher.decrypt(encrypted, binding);

    expect(encrypted.ciphertext).toHaveLength(exact.length);
    expect(encrypted.ciphertext).not.toEqual(exact);
    expect(encrypted.requestSha256).toBe(sha256(exact));
    expect(Buffer.from(restored.copyBodyBytes())).toEqual(exact);
  });

  it("gera nonce e ciphertext novos sem mudar o hash do plaintext", async () => {
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      placa: "QTP4H82",
    });
    const cipher = createCipher();
    const first = cipher.encrypt(prepared, binding);
    const second = cipher.encrypt(prepared, binding);

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.requestSha256).toBe(second.requestSha256);
  });

  it("copia chave, binding e envelope em vez de compartilhar buffers", async () => {
    const key = Buffer.alloc(32, 7);
    const actor = Buffer.from(binding.actorSubjectHash);
    const localBinding = { ...binding, actorSubjectHash: actor };
    const cipher = createCipher(
      "operation-key-2026-11",
      new Map([["operation-key-2026-11", key]]),
    );
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      seguro: true,
    });
    const encrypted = cipher.encrypt(prepared, localBinding);
    key.fill(0);
    actor.fill(0);

    const restored = await cipher.decrypt(encrypted, binding);
    const firstCopy = restored.copyBodyBytes();
    firstCopy.fill(0);

    expect(new TextDecoder().decode(restored.copyBodyBytes())).toBe(
      '{"seguro":true}',
    );
  });

  it.each([
    ["environment", { ...binding, environment: "production" }],
    [
      "tenantId",
      { ...binding, tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ],
    [
      "establishmentId",
      {
        ...binding,
        establishmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ],
    [
      "correlationId",
      {
        ...binding,
        correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ],
    ["kind", { ...binding, kind: "UNKNOWN" }],
    ["mutationFamily", { ...binding, mutationFamily: "UNKNOWN" }],
    ["schema", { ...binding, requestSchemaVersion: 2 }],
    ["idempotency", { ...binding, idempotencyKeyDigest: Buffer.alloc(32, 9) }],
    ["vehicle", { ...binding, vehicleKeyDigest: Buffer.alloc(32, 9) }],
    ["actor", { ...binding, actorSubjectHash: Buffer.alloc(32, 9) }],
  ] as const)("autentica o campo de AAD %s", async (_field, changed) => {
    const cipher = createCipher();
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      value: 1,
    });
    const encrypted = cipher.encrypt(prepared, binding);

    await expect(
      cipher.decrypt(encrypted, changed as unknown as OperationRequestBinding),
    ).rejects.toBeInstanceOf(
      changed.kind === "UNKNOWN" || changed.mutationFamily === "UNKNOWN"
        ? OperationRequestInputError
        : OperationRequestDecryptionError,
    );
  });

  it("fixa o ambiente no keyring e recusa reuso homologação-produção", async () => {
    const cipher = createCipher();
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      value: 1,
    });
    const encrypted = cipher.encrypt(prepared, binding);
    const productionBinding = {
      ...binding,
      environment: "production" as const,
    };

    expect(() => cipher.encrypt(prepared, productionBinding)).toThrow(
      OperationRequestInputError,
    );
    await expect(
      cipher.decrypt(encrypted, productionBinding),
    ).rejects.toBeInstanceOf(OperationRequestDecryptionError);
  });

  it.each(["ciphertext", "nonce", "authTag"] as const)(
    "recusa %s adulterado",
    async (field) => {
      const cipher = createCipher();
      const prepared = await prepareRenaveMutation("request-stock-entry", {
        value: 1,
      });
      const tampered = cloneEnvelope(cipher.encrypt(prepared, binding));
      tampered[field][0] = tampered[field][0]! ^ 1;

      await expect(cipher.decrypt(tampered, binding)).rejects.toBeInstanceOf(
        OperationRequestDecryptionError,
      );
    },
  );

  it.each([
    ["nonce curto", { nonce: Buffer.alloc(11) }],
    ["tag curta", { authTag: Buffer.alloc(15) }],
    ["ciphertext vazio", { ciphertext: Buffer.alloc(0) }],
    ["hash malformado", { requestSha256: "inválido" }],
    ["tamanho divergente", { requestByteLength: 999 }],
  ])(
    "recusa envelope com %s usando erro sanitizado",
    async (_label, change) => {
      const cipher = createCipher();
      const prepared = await prepareRenaveMutation("request-stock-entry", {
        cpf: "12345678901",
        placa: "QTP4H82",
      });
      const malformed = {
        ...cloneEnvelope(cipher.encrypt(prepared, binding)),
        ...change,
      } as EncryptedOperationRequest;

      let error: unknown;
      try {
        await cipher.decrypt(malformed, binding);
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toBeInstanceOf(OperationRequestDecryptionError);
      expect(JSON.stringify(error)).not.toMatch(/12345678901|QTP4H82/u);
    },
  );

  it("recusa troca de keyId, hash e combinações de dois envelopes", async () => {
    const cipher = new OperationRequestCipher({
      activeKeyId: "new",
      environment: "homologation",
      keys: new Map([
        ["new", Buffer.alloc(32, 7)],
        ["old", Buffer.alloc(32, 8)],
      ]),
    });
    const firstPrepared = await prepareRenaveMutation("request-stock-entry", {
      value: 1,
    });
    const secondPrepared = await prepareRenaveMutation("request-stock-entry", {
      value: 2,
    });
    const first = cipher.encrypt(firstPrepared, binding);
    const second = cipher.encrypt(secondPrepared, binding);
    const candidates = [
      { ...cloneEnvelope(first), keyId: "old" },
      { ...cloneEnvelope(first), requestSha256: second.requestSha256 },
      { ...cloneEnvelope(first), nonce: Buffer.from(second.nonce) },
      { ...cloneEnvelope(first), authTag: Buffer.from(second.authTag) },
      { ...cloneEnvelope(first), ciphertext: Buffer.from(second.ciphertext) },
    ];

    for (const candidate of candidates) {
      await expect(cipher.decrypt(candidate, binding)).rejects.toBeInstanceOf(
        OperationRequestDecryptionError,
      );
    }
  });

  it("mantém leitura de chave antiga durante rotação e falha após retirada", async () => {
    const oldKey = Buffer.alloc(32, 4);
    const newKey = Buffer.alloc(32, 5);
    const oldCipher = createCipher("old", new Map([["old", oldKey]]));
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      value: "old",
    });
    const oldEnvelope = oldCipher.encrypt(prepared, binding);
    const rotating = createCipher(
      "new",
      new Map([
        ["old", oldKey],
        ["new", newKey],
      ]),
    );
    const newEnvelope = rotating.encrypt(prepared, binding);

    await expect(rotating.decrypt(oldEnvelope, binding)).resolves.toMatchObject(
      { requestSha256: prepared.requestSha256 },
    );
    await expect(rotating.decrypt(newEnvelope, binding)).resolves.toMatchObject(
      { requestSha256: prepared.requestSha256 },
    );
    expect(newEnvelope.keyId).toBe("new");
    await expect(
      createCipher("new", new Map([["new", newKey]])).decrypt(
        oldEnvelope,
        binding,
      ),
    ).rejects.toBeInstanceOf(OperationRequestDecryptionError);
  });

  it("recusa configuração inválida e material duplicado sob IDs distintos", () => {
    expect(() =>
      createCipher("missing", new Map([["other", randomBytes(32)]])),
    ).toThrow(OperationRequestConfigurationError);
    expect(() =>
      createCipher("short", new Map([["short", randomBytes(31)]])),
    ).toThrow(OperationRequestConfigurationError);
    const duplicate = Buffer.alloc(32, 6);
    expect(
      () =>
        new OperationRequestCipher({
          activeKeyId: "a",
          environment: "homologation",
          keys: new Map([
            ["a", duplicate],
            ["b", Buffer.from(duplicate)],
          ]),
        }),
    ).toThrow(OperationRequestConfigurationError);
  });

  it("recusa subclasse e objetos sem brand runtime", async () => {
    class ForgedCipher extends OperationRequestCipher {}
    expect(
      () =>
        new ForgedCipher({
          activeKeyId: "key",
          environment: "homologation",
          keys: new Map([["key", Buffer.alloc(32, 7)]]),
        }),
    ).toThrow(OperationRequestConfigurationError);

    const prototypeOnly = Object.create(
      OperationRequestCipher.prototype,
    ) as OperationRequestCipher;
    const prepared = await prepareRenaveMutation("request-stock-entry", {});
    expect(() => prototypeOnly.encrypt(prepared, binding)).toThrow(
      OperationRequestConfigurationError,
    );
    expect(() =>
      Object.defineProperty(createCipher(), "encrypt", {
        value: () => ({ forged: true }),
      }),
    ).toThrow(TypeError);
  });

  it("aceita exatamente 1 MiB e a preparação recusa acima do limite", async () => {
    const overhead = Buffer.byteLength('{"v":""}', "utf8");
    const exact = { v: "x".repeat(1_048_576 - overhead) };
    const prepared = await prepareRenaveMutation("request-stock-entry", exact);
    const cipher = createCipher();
    const encrypted = cipher.encrypt(prepared, binding);

    expect(encrypted.requestByteLength).toBe(1_048_576);
    await expect(cipher.decrypt(encrypted, binding)).resolves.toMatchObject({
      byteLength: 1_048_576,
    });
    await expect(
      prepareRenaveMutation("request-stock-entry", {
        v: `${exact.v}x`,
      }),
    ).rejects.toMatchObject({ reason: "BODY_SIZE" });
  });

  it("zera o keyring no destroy e bloqueia uso posterior", async () => {
    const cipher = createCipher();
    const prepared = await prepareRenaveMutation("request-stock-entry", {});
    cipher.destroy();
    cipher.destroy();

    expect(() => cipher.encrypt(prepared, binding)).toThrow(
      OperationRequestConfigurationError,
    );
    await expect(
      cipher.decrypt(
        {
          authTag: Buffer.alloc(16),
          ciphertext: Buffer.from("{}"),
          keyId: "operation-key-2026-11",
          nonce: Buffer.alloc(12),
          operation: "request-stock-entry",
          requestByteLength: 2,
          requestSha256: sha256(Buffer.from("{}")),
        },
        binding,
      ),
    ).rejects.toBeInstanceOf(OperationRequestConfigurationError);
  });
});
