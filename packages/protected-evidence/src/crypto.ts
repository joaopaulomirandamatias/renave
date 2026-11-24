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
    key.fill(0);
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
    bytes.fill(0);
    throw new EvidencePayloadError("Tamanho do payload de evidência inválido.");
  }
  return bytes;
}

/** Decodifica uma chave de cofre/configuração sem aceitar tamanho ambíguo. */
export function decodeEvidenceKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new EvidenceConfigurationError("Chave de evidência base64 inválida.");
  }
  const decoded = Buffer.from(value, "base64");
  try {
    return keyBytes(decoded);
  } finally {
    decoded.fill(0);
  }
}

interface EvidenceCipherState {
  activeKeyId: string;
  destroyed: boolean;
  keys: Map<string, Buffer>;
}

const evidenceCipherState = new WeakMap<EvidenceCipher, EvidenceCipherState>();

function availableState(cipher: EvidenceCipher): EvidenceCipherState {
  const state = evidenceCipherState.get(cipher);
  if (!state || state.destroyed) {
    throw new EvidenceConfigurationError("Cifrador de evidência indisponível.");
  }
  return state;
}

/**
 * Criptografia autenticada com keyring: a chave ativa cifra dados novos;
 * chaves antigas podem permanecer apenas para leitura durante a rotação.
 */
export class EvidenceCipher {
  constructor(config: {
    activeKeyId: string;
    keys: ReadonlyMap<string, Uint8Array>;
  }) {
    const keys = new Map<string, Buffer>();
    try {
      const activeKeyId = config.activeKeyId;
      assertKeyId(activeKeyId);
      for (const [keyId, value] of config.keys) {
        assertKeyId(keyId);
        const key = keyBytes(value);
        const previousKey = keys.get(keyId);
        try {
          keys.set(keyId, key);
        } catch (error) {
          key.fill(0);
          throw error;
        }
        previousKey?.fill(0);
      }
      if (!keys.has(activeKeyId)) {
        throw new EvidenceConfigurationError(
          "A chave ativa não está presente no keyring.",
        );
      }
      evidenceCipherState.set(this, {
        activeKeyId,
        destroyed: false,
        keys,
      });
    } catch (error) {
      for (const key of keys.values()) key.fill(0);
      keys.clear();
      throw error;
    }
  }

  encrypt(
    value: unknown,
    binding: EvidenceBinding,
    kind: EvidencePayloadKind,
  ): EncryptedEvidencePayload {
    const state = availableState(this);
    const nonce = randomBytes(NONCE_BYTES);
    let additionalData: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      additionalData = aad(binding, kind, state.activeKeyId);
      plaintext = serialize(value);
      const cipher = createCipheriv(
        "aes-256-gcm",
        state.keys.get(state.activeKeyId)!,
        nonce,
        { authTagLength: TAG_BYTES },
      );
      cipher.setAAD(additionalData);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        authTag: cipher.getAuthTag(),
        ciphertext,
        keyId: state.activeKeyId,
        nonce,
      };
    } finally {
      additionalData?.fill(0);
      plaintext?.fill(0);
    }
  }

  decrypt<T>(
    payload: EncryptedEvidencePayload,
    binding: EvidenceBinding,
    kind: EvidencePayloadKind,
  ): T {
    const state = availableState(this);
    const key = state.keys.get(payload.keyId);
    if (
      !key ||
      payload.nonce.length !== NONCE_BYTES ||
      payload.authTag.length !== TAG_BYTES ||
      payload.ciphertext.length === 0 ||
      payload.ciphertext.length > MAX_PAYLOAD_BYTES
    ) {
      throw new EvidenceDecryptionError("Evidência não pôde ser autenticada.");
    }
    let additionalData: Buffer | undefined;
    let plaintext: Buffer | undefined;
    const plaintextChunks: Buffer[] = [];
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, payload.nonce, {
        authTagLength: TAG_BYTES,
      });
      additionalData = aad(binding, kind, payload.keyId);
      decipher.setAAD(additionalData);
      decipher.setAuthTag(payload.authTag);
      plaintextChunks.push(decipher.update(payload.ciphertext));
      plaintextChunks.push(decipher.final());
      plaintext = Buffer.concat(plaintextChunks);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      throw new EvidenceDecryptionError("Evidência não pôde ser autenticada.");
    } finally {
      additionalData?.fill(0);
      for (const chunk of plaintextChunks) chunk.fill(0);
      plaintext?.fill(0);
    }
  }

  destroy(): void {
    const state = evidenceCipherState.get(this);
    if (!state || state.destroyed) return;
    state.destroyed = true;
    for (const key of state.keys.values()) key.fill(0);
    state.keys.clear();
  }
}
