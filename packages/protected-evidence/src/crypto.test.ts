import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeEvidenceKeyBase64,
  EvidenceCipher,
  EvidenceConfigurationError,
  EvidenceDecryptionError,
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
