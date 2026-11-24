import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PAYLOAD_BYTES = 1_048_576;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type EvidencePayloadKind = "request" | "response";

export interface EvidenceBinding {
  action: string;
  establishmentId: string;
  evidenceId: string;
  tenantId: string;
}

export interface EncryptedEvidencePayload {
  authTag: Buffer;
  ciphertext: Buffer;
  keyId: string;
  nonce: Buffer;
}

export class EvidenceConfigurationError extends Error {
  override name = "EvidenceConfigurationError";
}

export class EvidencePayloadError extends Error {
  override name = "EvidencePayloadError";
}

export class EvidenceDecryptionError extends Error {
  override name = "EvidenceDecryptionError";
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID.test(keyId)) {
    throw new EvidenceConfigurationError("Identificador da chave inválido.");
  }
}

function keyBytes(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length !== KEY_BYTES) {
    throw new EvidenceConfigurationError(
      "A chave de evidência deve ter exatamente 32 bytes.",
    );
  }
  return key;
}

function aad(
  binding: EvidenceBinding,
  kind: EvidencePayloadKind,
  keyId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "seu-renave-evidence-v2",
      keyId,
      binding.tenantId,
      binding.evidenceId,
      binding.establishmentId,
      binding.action,
      kind,
    ]),
    "utf8",
  );
}

function serialize(value: unknown): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new EvidencePayloadError("Payload de evidência não serializável.");
  }
  if (json === undefined) {
    throw new EvidencePayloadError("Payload de evidência ausente.");
  }
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) {
    throw new EvidencePayloadError("Tamanho do payload de evidência inválido.");
  }
  return bytes;
}

/** Decodifica uma chave de cofre/configuração sem aceitar tamanho ambíguo. */
export function decodeEvidenceKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new EvidenceConfigurationError("Chave de evidência base64 inválida.");
  }
  return keyBytes(Buffer.from(value, "base64"));
}

/**
 * Criptografia autenticada com keyring: a chave ativa cifra dados novos;
 * chaves antigas podem permanecer apenas para leitura durante a rotação.
 */
export class EvidenceCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(config: {
    activeKeyId: string;
    keys: ReadonlyMap<string, Uint8Array>;
  }) {
    assertKeyId(config.activeKeyId);
    for (const [keyId, value] of config.keys) {
      assertKeyId(keyId);
      this.keys.set(keyId, keyBytes(value));
    }
    if (!this.keys.has(config.activeKeyId)) {
      throw new EvidenceConfigurationError(
        "A chave ativa não está presente no keyring.",
      );
    }
    this.activeKeyId = config.activeKeyId;
  }

  encrypt(
    value: unknown,
    binding: EvidenceBinding,
    kind: EvidencePayloadKind,
  ): EncryptedEvidencePayload {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.activeKeyId)!,
      nonce,
      { authTagLength: TAG_BYTES },
    );
    cipher.setAAD(aad(binding, kind, this.activeKeyId));
    const ciphertext = Buffer.concat([
      cipher.update(serialize(value)),
      cipher.final(),
    ]);
    return {
      authTag: cipher.getAuthTag(),
      ciphertext,
      keyId: this.activeKeyId,
      nonce,
    };
  }

  decrypt<T>(
    payload: EncryptedEvidencePayload,
    binding: EvidenceBinding,
    kind: EvidencePayloadKind,
  ): T {
    const key = this.keys.get(payload.keyId);
    if (
      !key ||
      payload.nonce.length !== NONCE_BYTES ||
      payload.authTag.length !== TAG_BYTES ||
      payload.ciphertext.length === 0 ||
      payload.ciphertext.length > MAX_PAYLOAD_BYTES
    ) {
      throw new EvidenceDecryptionError("Evidência não pôde ser autenticada.");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, payload.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(binding, kind, payload.keyId));
      decipher.setAuthTag(payload.authTag);
      const plaintext = Buffer.concat([
        decipher.update(payload.ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      throw new EvidenceDecryptionError("Evidência não pôde ser autenticada.");
    }
  }
}
