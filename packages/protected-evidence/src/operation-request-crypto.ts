import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type {
  OperationKind,
  OperationMutationFamily,
} from "@seu-renave/db/operation-worker";
import {
  restorePreparedRenaveMutation,
  type PreparedRenaveMutation,
  type RenaveEnvironment,
  type RenaveMutationOperation,
} from "@seu-renave/renave-connector";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_SCHEMA_VERSION = 2_147_483_647;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface OperationRequestBinding {
  actorSubjectHash: Uint8Array;
  correlationId: string;
  environment: RenaveEnvironment;
  establishmentId: string;
  idempotencyKeyDigest: Uint8Array;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  requestSchemaVersion: number;
  tenantId: string;
  vehicleKeyDigest: Uint8Array;
}

export interface EncryptedOperationRequest {
  authTag: Buffer;
  ciphertext: Buffer;
  keyId: string;
  nonce: Buffer;
  operation: RenaveMutationOperation;
  requestByteLength: number;
  requestSha256: string;
}

interface NormalizedBinding {
  actorSubjectHash: Buffer;
  correlationId: string;
  environment: RenaveEnvironment;
  establishmentId: string;
  idempotencyKeyDigest: Buffer;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  requestSchemaVersion: number;
  tenantId: string;
  vehicleKeyDigest: Buffer;
}

interface CipherState {
  activeKeyId: string;
  destroyed: boolean;
  environment: RenaveEnvironment;
  keys: Map<string, Buffer>;
}

const cipherStates = new WeakMap<OperationRequestCipher, CipherState>();

export class OperationRequestConfigurationError extends Error {
  override name = "OperationRequestConfigurationError";

  constructor() {
    super("A criptografia de requisições RENAVE está indisponível.");
  }
}

export class OperationRequestInputError extends Error {
  override name = "OperationRequestInputError";

  constructor() {
    super("A requisição RENAVE cifrada contém dados inválidos.");
  }
}

export class OperationRequestDecryptionError extends Error {
  override name = "OperationRequestDecryptionError";

  constructor() {
    super("A requisição RENAVE não pôde ser autenticada.");
  }
}

function copyFixed(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new OperationRequestInputError();
  }
  return Buffer.from(value);
}

function normalizeBinding(binding: OperationRequestBinding): NormalizedBinding {
  if (
    !binding ||
    (binding.environment !== "homologation" &&
      binding.environment !== "production") ||
    !UUID_PATTERN.test(binding.tenantId) ||
    !UUID_PATTERN.test(binding.establishmentId) ||
    !UUID_PATTERN.test(binding.correlationId) ||
    binding.kind !== "USED_STOCK_ENTRY" ||
    binding.mutationFamily !== "STOCK_ENTRY" ||
    !Number.isInteger(binding.requestSchemaVersion) ||
    binding.requestSchemaVersion < 1 ||
    binding.requestSchemaVersion > MAX_SCHEMA_VERSION
  ) {
    throw new OperationRequestInputError();
  }
  return {
    actorSubjectHash: copyFixed(binding.actorSubjectHash, DIGEST_BYTES),
    correlationId: binding.correlationId.toLowerCase(),
    environment: binding.environment,
    establishmentId: binding.establishmentId.toLowerCase(),
    idempotencyKeyDigest: copyFixed(binding.idempotencyKeyDigest, DIGEST_BYTES),
    kind: binding.kind,
    mutationFamily: binding.mutationFamily,
    requestSchemaVersion: binding.requestSchemaVersion,
    tenantId: binding.tenantId.toLowerCase(),
    vehicleKeyDigest: copyFixed(binding.vehicleKeyDigest, DIGEST_BYTES),
  };
}

function aad(
  binding: NormalizedBinding,
  keyId: string,
  operation: RenaveMutationOperation,
  requestSha256: string,
  requestByteLength: number,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "seu-renave-operation-request-v1",
      binding.environment,
      keyId,
      binding.tenantId,
      binding.establishmentId,
      binding.correlationId,
      binding.kind,
      binding.mutationFamily,
      operation,
      binding.requestSchemaVersion,
      requestSha256,
      requestByteLength,
      binding.idempotencyKeyDigest.toString("hex"),
      binding.vehicleKeyDigest.toString("hex"),
      binding.actorSubjectHash.toString("hex"),
    ]),
    "utf8",
  );
}

function assertEnvelopeMetadata(payload: EncryptedOperationRequest): void {
  if (
    !payload ||
    payload.operation !== "request-stock-entry" ||
    !SHA256_PATTERN.test(payload.requestSha256) ||
    !Number.isInteger(payload.requestByteLength) ||
    payload.requestByteLength < 1 ||
    payload.requestByteLength > MAX_REQUEST_BYTES ||
    !KEY_ID_PATTERN.test(payload.keyId) ||
    !(payload.nonce instanceof Uint8Array) ||
    payload.nonce.byteLength !== NONCE_BYTES ||
    !(payload.authTag instanceof Uint8Array) ||
    payload.authTag.byteLength !== TAG_BYTES ||
    !(payload.ciphertext instanceof Uint8Array) ||
    payload.ciphertext.byteLength !== payload.requestByteLength
  ) {
    throw new OperationRequestDecryptionError();
  }
}

function cipherState(cipher: OperationRequestCipher): CipherState {
  const state = cipherStates.get(cipher);
  if (!state || state.destroyed) {
    throw new OperationRequestConfigurationError();
  }
  return state;
}

function encryptWithState(
  state: CipherState,
  prepared: PreparedRenaveMutation,
  binding: OperationRequestBinding,
): EncryptedOperationRequest {
  const normalized = normalizeBinding(binding);
  if (normalized.environment !== state.environment) {
    throw new OperationRequestInputError();
  }
  const body = prepared.copyBodyBytes();
  try {
    if (
      prepared.operation !== "request-stock-entry" ||
      !SHA256_PATTERN.test(prepared.requestSha256) ||
      prepared.byteLength !== body.byteLength ||
      body.byteLength < 1 ||
      body.byteLength > MAX_REQUEST_BYTES
    ) {
      throw new OperationRequestInputError();
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(
      "aes-256-gcm",
      state.keys.get(state.activeKeyId)!,
      nonce,
      { authTagLength: TAG_BYTES },
    );
    cipher.setAAD(
      aad(
        normalized,
        state.activeKeyId,
        prepared.operation,
        prepared.requestSha256,
        prepared.byteLength,
      ),
    );
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return {
      authTag: Buffer.from(cipher.getAuthTag()),
      ciphertext: Buffer.from(ciphertext),
      keyId: state.activeKeyId,
      nonce: Buffer.from(nonce),
      operation: prepared.operation,
      requestByteLength: prepared.byteLength,
      requestSha256: prepared.requestSha256,
    };
  } finally {
    body.fill(0);
  }
}

/**
 * Keyring exclusivo das requisições mutáveis. As chaves não devem ser
 * compartilhadas com evidências de leitura nem entre ambientes.
 */
export class OperationRequestCipher {
  constructor(config: {
    activeKeyId: string;
    environment: RenaveEnvironment;
    keys: ReadonlyMap<string, Uint8Array>;
  }) {
    if (new.target !== OperationRequestCipher) {
      throw new OperationRequestConfigurationError();
    }
    const keys = new Map<string, Buffer>();
    try {
      if (
        !config ||
        !KEY_ID_PATTERN.test(config.activeKeyId) ||
        (config.environment !== "homologation" &&
          config.environment !== "production") ||
        !(config.keys instanceof Map) ||
        config.keys.size === 0
      ) {
        throw new OperationRequestConfigurationError();
      }
      for (const [keyId, source] of config.keys) {
        if (
          !KEY_ID_PATTERN.test(keyId) ||
          !(source instanceof Uint8Array) ||
          source.byteLength !== KEY_BYTES
        ) {
          throw new OperationRequestConfigurationError();
        }
        const key = Buffer.from(source);
        if (
          Array.from(keys.values()).some((existing) =>
            timingSafeEqual(existing, key),
          )
        ) {
          key.fill(0);
          throw new OperationRequestConfigurationError();
        }
        keys.set(keyId, key);
      }
      if (!keys.has(config.activeKeyId)) {
        throw new OperationRequestConfigurationError();
      }
      cipherStates.set(this, {
        activeKeyId: config.activeKeyId,
        destroyed: false,
        environment: config.environment,
        keys,
      });
      Object.freeze(this);
    } catch {
      for (const key of keys.values()) key.fill(0);
      keys.clear();
      throw new OperationRequestConfigurationError();
    }
  }

  encrypt(
    prepared: PreparedRenaveMutation,
    binding: OperationRequestBinding,
  ): EncryptedOperationRequest {
    return encryptOperationRequest(this, prepared, binding);
  }

  async decrypt(
    payload: EncryptedOperationRequest,
    binding: OperationRequestBinding,
  ): Promise<PreparedRenaveMutation> {
    const state = cipherState(this);
    const normalized = normalizeBinding(binding);
    if (normalized.environment !== state.environment) {
      throw new OperationRequestDecryptionError();
    }
    assertEnvelopeMetadata(payload);
    const key = state.keys.get(payload.keyId);
    if (!key) throw new OperationRequestDecryptionError();

    const nonce = Buffer.from(payload.nonce);
    const authTag = Buffer.from(payload.authTag);
    const ciphertext = Buffer.from(payload.ciphertext);
    const chunks: Buffer[] = [];
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(
        aad(
          normalized,
          payload.keyId,
          payload.operation,
          payload.requestSha256,
          payload.requestByteLength,
        ),
      );
      decipher.setAuthTag(authTag);
      chunks.push(decipher.update(ciphertext));
      chunks.push(decipher.final());
      plaintext = Buffer.concat(chunks);
      return await restorePreparedRenaveMutation(
        payload.operation,
        plaintext,
        payload.requestSha256,
      );
    } catch {
      throw new OperationRequestDecryptionError();
    } finally {
      nonce.fill(0);
      authTag.fill(0);
      ciphertext.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      plaintext?.fill(0);
    }
  }

  destroy(): void {
    const state = cipherStates.get(this);
    if (!state || state.destroyed) return;
    for (const key of state.keys.values()) key.fill(0);
    state.keys.clear();
    state.destroyed = true;
  }
}

/** Fronteira confiável usada por builders; recusa objetos sem brand runtime. */
export function encryptOperationRequest(
  cipher: OperationRequestCipher,
  prepared: PreparedRenaveMutation,
  binding: OperationRequestBinding,
): EncryptedOperationRequest {
  return encryptWithState(cipherState(cipher), prepared, binding);
}

Object.freeze(OperationRequestCipher.prototype);
Object.freeze(OperationRequestCipher);
