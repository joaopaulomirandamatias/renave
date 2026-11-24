import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  decodeEvidenceKeyBase64,
  EvidenceCipher,
  EvidenceConfigurationError,
  EvidenceDecryptionError,
  EvidencePayloadError,
} from "./crypto.js";

const binding = {
  action: "renave.vehicle.eligibility.read",
  establishmentId: "22222222-2222-4222-8222-222222222222",
  evidenceId: "33333333-3333-4333-8333-333333333333",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

function cipher(key = Buffer.alloc(32, 7)): EvidenceCipher {
  return new EvidenceCipher({
    activeKeyId: "key-2026-11",
    keys: new Map([["key-2026-11", key]]),
  });
}

function aadBytes(kind: "request" | "response"): number {
  return Buffer.byteLength(
    JSON.stringify([
      "seu-renave-evidence-v2",
      "key-2026-11",
      binding.tenantId,
      binding.evidenceId,
      binding.establishmentId,
      binding.action,
      kind,
    ]),
    "utf8",
  );
}

describe("EvidenceCipher", () => {
  it("cifra e decifra JSON sem expor o plaintext", () => {
    const value = { placa: "ABC1D23", diagnostico: { veiculoApto: true } };
    const encrypted = cipher().encrypt(value, binding, "request");

    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("ABC1D23");
    expect(cipher().decrypt(encrypted, binding, "request")).toEqual(value);
  });

  it("gera nonce novo para o mesmo payload", () => {
    const first = cipher().encrypt({ same: true }, binding, "request");
    const second = cipher().encrypt({ same: true }, binding, "request");

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("mantém cópia própria da chave e falha fechado após destroy", () => {
    const key = Buffer.alloc(32, 7);
    const instance = cipher(key);
    expect(Object.getOwnPropertyNames(instance)).toEqual([]);
    key.fill(0);
    const encrypted = instance.encrypt({ protected: true }, binding, "request");

    expect(instance.decrypt(encrypted, binding, "request")).toEqual({
      protected: true,
    });
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      instance.destroy();
      instance.destroy();

      const destroyedKeys = fill.mock.instances.filter(
        (value): value is Buffer =>
          Buffer.isBuffer(value) &&
          value.length === 32 &&
          value.every((byte) => byte === 0),
      );
      expect(destroyedKeys).toHaveLength(1);
    } finally {
      fill.mockRestore();
    }

    expect(() =>
      instance.encrypt(
        {
          toJSON(): never {
            throw new Error("serialização alcançada");
          },
        },
        binding,
        "request",
      ),
    ).toThrow(EvidenceConfigurationError);
    const unreadablePayload = new Proxy(encrypted, {
      get(): never {
        throw new Error("payload acessado");
      },
    });
    expect(() =>
      instance.decrypt(unreadablePayload, binding, "request"),
    ).toThrow(EvidenceConfigurationError);
  });

  it("zera cópias parciais quando a construção do keyring falha", () => {
    const validSource = Buffer.alloc(32, 3);
    const invalidSource = Buffer.alloc(31, 4);
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      expect(
        () =>
          new EvidenceCipher({
            activeKeyId: "key-valid",
            keys: new Map([
              ["key-valid", validSource],
              ["key-invalid", invalidSource],
            ]),
          }),
      ).toThrow(EvidenceConfigurationError);

      const zeroedCopies = fill.mock.instances.filter(
        (value): value is Buffer =>
          Buffer.isBuffer(value) && value.every((byte) => byte === 0),
      );
      expect(zeroedCopies.some((value) => value.length === 32)).toBe(true);
      expect(zeroedCopies.some((value) => value.length === 31)).toBe(true);
      expect(validSource.every((byte) => byte === 3)).toBe(true);
      expect(invalidSource.every((byte) => byte === 4)).toBe(true);
    } finally {
      fill.mockRestore();
    }
  });

  it("zera AAD e plaintext serializado ao cifrar em sucesso e erro", () => {
    const value = { marker: "serialized-plaintext-2026" };
    const plaintextBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const additionalDataBytes = aadBytes("request");
    const instance = cipher();
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      instance.encrypt(value, binding, "request");
      expect(() =>
        instance.encrypt("x".repeat(1_048_576), binding, "request"),
      ).toThrow(EvidencePayloadError);

      const zeroedBuffers = fill.mock.instances.filter(
        (buffer): buffer is Buffer =>
          Buffer.isBuffer(buffer) && buffer.every((byte) => byte === 0),
      );
      expect(
        zeroedBuffers.some((buffer) => buffer.length === plaintextBytes),
      ).toBe(true);
      expect(
        zeroedBuffers.filter((buffer) => buffer.length === additionalDataBytes),
      ).toHaveLength(2);
      expect(zeroedBuffers.some((buffer) => buffer.length > 1_048_576)).toBe(
        true,
      );
    } finally {
      fill.mockRestore();
    }
  });

  it("zera buffers temporários de plaintext em sucesso e erro", () => {
    const value = { marker: "temporary-plaintext-2026" };
    const plaintextBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const additionalDataBytes = aadBytes("response");
    const instance = cipher();
    const encrypted = instance.encrypt(value, binding, "response");
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      expect(instance.decrypt(encrypted, binding, "response")).toEqual(value);
      const tampered = {
        ...encrypted,
        authTag: Buffer.from(encrypted.authTag),
      };
      tampered.authTag[0] = tampered.authTag[0]! ^ 1;
      expect(() => instance.decrypt(tampered, binding, "response")).toThrow(
        EvidenceDecryptionError,
      );

      const zeroedPlaintexts = fill.mock.instances.filter(
        (buffer): buffer is Buffer =>
          Buffer.isBuffer(buffer) &&
          buffer.length === plaintextBytes &&
          buffer.every((byte) => byte === 0),
      );
      expect(zeroedPlaintexts.length).toBeGreaterThanOrEqual(2);
      const zeroedAdditionalData = fill.mock.instances.filter(
        (buffer): buffer is Buffer =>
          Buffer.isBuffer(buffer) &&
          buffer.length === additionalDataBytes &&
          buffer.every((byte) => byte === 0),
      );
      expect(zeroedAdditionalData).toHaveLength(2);
    } finally {
      fill.mockRestore();
    }
  });

  it("recusa ciphertext adulterado, chave errada e AAD de outro tenant", () => {
    const encrypted = cipher().encrypt(
      { secret: "evidence" },
      binding,
      "response",
    );
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;

    expect(() => cipher().decrypt(tampered, binding, "response")).toThrow(
      EvidenceDecryptionError,
    );
    expect(() =>
      cipher(Buffer.alloc(32, 8)).decrypt(encrypted, binding, "response"),
    ).toThrow(EvidenceDecryptionError);
    expect(() =>
      cipher().decrypt(
        encrypted,
        { ...binding, tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        "response",
      ),
    ).toThrow(EvidenceDecryptionError);
  });

  it("autentica o keyId mesmo quando dois IDs apontam para os mesmos bytes", () => {
    const key = Buffer.alloc(32, 9);
    const rotating = new EvidenceCipher({
      activeKeyId: "key-new",
      keys: new Map([
        ["key-new", key],
        ["key-old", key],
      ]),
    });
    const encrypted = rotating.encrypt({ protected: true }, binding, "request");

    expect(() =>
      rotating.decrypt({ ...encrypted, keyId: "key-old" }, binding, "request"),
    ).toThrow(EvidenceDecryptionError);
  });

  it("valida chave ativa, tamanho e base64 estritamente", () => {
    expect(
      () =>
        new EvidenceCipher({
          activeKeyId: "missing",
          keys: new Map([["other", randomBytes(32)]]),
        }),
    ).toThrow(EvidenceConfigurationError);
    expect(() => cipher(Buffer.alloc(31))).toThrow(EvidenceConfigurationError);
    expect(
      decodeEvidenceKeyBase64(Buffer.alloc(32, 1).toString("base64")),
    ).toHaveLength(32);
    expect(() => decodeEvidenceKeyBase64("not-a-key")).toThrow(
      EvidenceConfigurationError,
    );
  });
});
