import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
const ENVELOPE_SCHEMA_VERSION = 1 as const;
const PAYLOAD_HEADER_BYTES = 4;
const BUCKETS = [128, 256, 512, 1024, 2048, 4096] as const;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CPF_SOURCE_PATTERN = /^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/u;
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/u;
const EMAIL_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

export type RenavePrincipalPurpose = "operator-cpf" | "establishment-email";

export interface OperatorCpfBinding {
  profileId: string;
  purpose: "operator-cpf";
  subject: string;
  tenantId: string;
}

export interface EstablishmentEmailBinding {
  establishmentId: string;
  profileId: string;
  purpose: "establishment-email";
  tenantId: string;
}

export type RenavePrincipalBinding =
  OperatorCpfBinding | EstablishmentEmailBinding;

export interface RenavePrincipalKeyringConfig {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export interface RenavePrincipalPurposeConfig {
  encryption: RenavePrincipalKeyringConfig;
  hmac: RenavePrincipalKeyringConfig;
}

export interface RenavePrincipalCryptoConfig {
  environment: "homologation" | "production";
  purposes: Readonly<
    Record<RenavePrincipalPurpose, RenavePrincipalPurposeConfig>
  >;
}

export interface EncryptedRenavePrincipal {
  aadSha256: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  envelopeSchemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  keyId: string;
  nonce: Buffer;
}

export interface RenavePrincipalHmac {
  digest: Buffer;
  hmacKeyId: string;
}

export interface ProtectedRenavePrincipal extends EncryptedRenavePrincipal {
  hmac: RenavePrincipalHmac;
}

export class DecryptedRenavePrincipal {
  private constructor() {
    throw new RenavePrincipalConfigurationError();
  }

  get byteLength(): number {
    return secretState(this).bytes.byteLength;
  }

  get purpose(): RenavePrincipalPurpose {
    return secretState(this).purpose;
  }

  copyUtf8Bytes(): Buffer {
    return Buffer.from(secretState(this).bytes);
  }

  toJSON(): never {
    throw new RenavePrincipalDecryptionError();
  }

  destroy(): void {
    const state = secretStates.get(this);
    if (!state || state.destroyed) return;
    state.bytes.fill(0);
    state.destroyed = true;
  }
}

interface NormalizedBinding {
  entityKind: "establishment" | "subject";
  entityValue: string;
  profileId: string;
  purpose: RenavePrincipalPurpose;
  tenantId: string;
}

interface KeyringState {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

interface PurposeState {
  encryption: KeyringState;
  hmac: KeyringState;
}

interface CryptoState {
  destroyed: boolean;
  environment: "homologation" | "production";
  purposes: Map<RenavePrincipalPurpose, PurposeState>;
}

interface SecretState {
  bytes: Buffer;
  destroyed: boolean;
  purpose: RenavePrincipalPurpose;
}

const cryptoStates = new WeakMap<RenavePrincipalCrypto, CryptoState>();
const secretStates = new WeakMap<DecryptedRenavePrincipal, SecretState>();

export class RenavePrincipalConfigurationError extends Error {
  override name = "RenavePrincipalConfigurationError";

  constructor() {
    super("A proteção dos perfis RENAVE está indisponível.");
  }
}

export class RenavePrincipalInputError extends Error {
  override name = "RenavePrincipalInputError";

  constructor() {
    super("O perfil RENAVE contém dados inválidos.");
  }
}

export class RenavePrincipalDecryptionError extends Error {
  override name = "RenavePrincipalDecryptionError";

  constructor() {
    super("O perfil RENAVE não pôde ser autenticado.");
  }
}

function normalizeBinding(binding: RenavePrincipalBinding): NormalizedBinding {
  if (
    !binding ||
    !UUID_PATTERN.test(binding.tenantId) ||
    !UUID_PATTERN.test(binding.profileId)
  ) {
    throw new RenavePrincipalInputError();
  }
  const common = {
    profileId: binding.profileId.toLowerCase(),
    purpose: binding.purpose,
    tenantId: binding.tenantId.toLowerCase(),
  };
  if (binding.purpose === "operator-cpf") {
    if (
      typeof binding.subject !== "string" ||
      binding.subject.trim() !== binding.subject ||
      binding.subject.length < 1 ||
      binding.subject.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(binding.subject)
    ) {
      throw new RenavePrincipalInputError();
    }
    return {
      ...common,
      entityKind: "subject",
      entityValue: binding.subject,
    };
  }
  if (
    binding.purpose !== "establishment-email" ||
    !UUID_PATTERN.test(binding.establishmentId)
  ) {
    throw new RenavePrincipalInputError();
  }
  return {
    ...common,
    entityKind: "establishment",
    entityValue: binding.establishmentId.toLowerCase(),
  };
}

function normalizeCpf(value: string): string {
  if (typeof value !== "string" || !CPF_SOURCE_PATTERN.test(value)) {
    throw new RenavePrincipalInputError();
  }
  const digits = value.replace(/\D/gu, "");
  if (/^(\d)\1{10}$/u.test(digits)) throw new RenavePrincipalInputError();
  const checkDigit = (length: 9 | 10): number => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  if (
    Number(digits[9]) !== checkDigit(9) ||
    Number(digits[10]) !== checkDigit(10)
  ) {
    throw new RenavePrincipalInputError();
  }
  return digits;
}

function normalizeEmail(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value.trim() !== value ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new RenavePrincipalInputError();
  }
  const separator = value.lastIndexOf("@");
  if (separator < 1 || separator !== value.indexOf("@")) {
    throw new RenavePrincipalInputError();
  }
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    !EMAIL_LOCAL_PATTERN.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length > 253 ||
    !domain.includes(".") ||
    domain.split(".").some((label) => !EMAIL_LABEL_PATTERN.test(label))
  ) {
    throw new RenavePrincipalInputError();
  }
  // A parte local é preservada. Somente o domínio, case-insensitive por
  // definição do DNS, é canonicalizado para estabilizar HMAC e ciphertext.
  return `${local}@${domain.toLowerCase()}`;
}

function normalizeValue(
  purpose: RenavePrincipalPurpose,
  value: string,
): string {
  return purpose === "operator-cpf"
    ? normalizeCpf(value)
    : normalizeEmail(value);
}

function aad(
  binding: NormalizedBinding,
  environment: "homologation" | "production",
  keyId: string,
  hmac: RenavePrincipalHmac,
  bucket: number,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "seu-renave-principal-profile-v1",
      ENVELOPE_SCHEMA_VERSION,
      environment,
      binding.purpose,
      keyId,
      hmac.hmacKeyId,
      hmac.digest.toString("hex"),
      binding.tenantId,
      binding.entityKind,
      binding.entityValue,
      binding.profileId,
      bucket,
    ]),
    "utf8",
  );
}

function hmacMessage(
  binding: NormalizedBinding,
  environment: "homologation" | "production",
  hmacKeyId: string,
  normalizedValue: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "seu-renave-principal-hmac-v1",
      environment,
      binding.purpose,
      hmacKeyId,
      binding.tenantId,
      ...(binding.purpose === "establishment-email"
        ? [binding.entityValue]
        : []),
      normalizedValue,
    ]),
    "utf8",
  );
}

function purposeBucket(purpose: RenavePrincipalPurpose): 128 | 512 {
  return purpose === "operator-cpf" ? 128 : 512;
}

function paddedPlaintext(
  value: Buffer,
  purpose: RenavePrincipalPurpose,
): Buffer {
  const result = randomBytes(purposeBucket(purpose));
  result.writeUInt32BE(value.byteLength, 0);
  value.copy(result, PAYLOAD_HEADER_BYTES);
  return result;
}

function decodePaddedPlaintext(
  plaintext: Buffer,
  purpose: RenavePrincipalPurpose,
): string {
  if (plaintext.byteLength !== purposeBucket(purpose)) {
    throw new RenavePrincipalDecryptionError();
  }
  const valueLength = plaintext.readUInt32BE(0);
  const end = PAYLOAD_HEADER_BYTES + valueLength;
  if (valueLength < 1 || end > plaintext.byteLength) {
    throw new RenavePrincipalDecryptionError();
  }
  let decoded: string;
  try {
    // Strings JS não podem ser zeradas. Este valor fica restrito à validação
    // canônica e à cópia imediata para o segredo Buffer destruível.
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      plaintext.subarray(PAYLOAD_HEADER_BYTES, end),
    );
  } catch {
    throw new RenavePrincipalDecryptionError();
  }
  try {
    if (normalizeValue(purpose, decoded) !== decoded) {
      throw new RenavePrincipalDecryptionError();
    }
  } catch {
    throw new RenavePrincipalDecryptionError();
  }
  return decoded;
}

function assertEnvelope(payload: EncryptedRenavePrincipal): void {
  if (
    !payload ||
    payload.envelopeSchemaVersion !== ENVELOPE_SCHEMA_VERSION ||
    !KEY_ID_PATTERN.test(payload.keyId) ||
    !(payload.nonce instanceof Uint8Array) ||
    payload.nonce.byteLength !== NONCE_BYTES ||
    !(payload.authTag instanceof Uint8Array) ||
    payload.authTag.byteLength !== TAG_BYTES ||
    !(payload.aadSha256 instanceof Uint8Array) ||
    payload.aadSha256.byteLength !== DIGEST_BYTES ||
    !(payload.ciphertext instanceof Uint8Array) ||
    !BUCKETS.includes(payload.ciphertext.byteLength as (typeof BUCKETS)[number])
  ) {
    throw new RenavePrincipalDecryptionError();
  }
}

function cryptoState(instance: RenavePrincipalCrypto): CryptoState {
  const state = cryptoStates.get(instance);
  if (!state || state.destroyed) {
    throw new RenavePrincipalConfigurationError();
  }
  return state;
}

function secretState(instance: DecryptedRenavePrincipal): SecretState {
  const state = secretStates.get(instance);
  if (!state || state.destroyed) throw new RenavePrincipalDecryptionError();
  return state;
}

function decryptedSecret(
  bytes: Uint8Array,
  purpose: RenavePrincipalPurpose,
): DecryptedRenavePrincipal {
  const instance = Object.create(
    DecryptedRenavePrincipal.prototype,
  ) as DecryptedRenavePrincipal;
  secretStates.set(instance, {
    bytes: Buffer.from(bytes),
    destroyed: false,
    purpose,
  });
  Object.freeze(instance);
  return instance;
}

function copyKeyring(
  config: RenavePrincipalKeyringConfig,
  allKeyIds: Set<string>,
  allKeys: Buffer[],
): KeyringState {
  if (
    !config ||
    !KEY_ID_PATTERN.test(config.activeKeyId) ||
    !(config.keys instanceof Map) ||
    config.keys.size === 0
  ) {
    throw new RenavePrincipalConfigurationError();
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, source] of config.keys) {
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      allKeyIds.has(keyId) ||
      !(source instanceof Uint8Array) ||
      source.byteLength !== KEY_BYTES
    ) {
      throw new RenavePrincipalConfigurationError();
    }
    const copied = Buffer.from(source);
    if (allKeys.some((existing) => timingSafeEqual(existing, copied))) {
      copied.fill(0);
      throw new RenavePrincipalConfigurationError();
    }
    allKeyIds.add(keyId);
    allKeys.push(copied);
    keys.set(keyId, copied);
  }
  if (!keys.has(config.activeKeyId)) {
    throw new RenavePrincipalConfigurationError();
  }
  return { activeKeyId: config.activeKeyId, keys };
}

function digestWithState(
  state: CryptoState,
  value: string,
  binding: NormalizedBinding,
): RenavePrincipalHmac {
  const normalized = normalizeValue(binding.purpose, value);
  const valueBytes = Buffer.from(normalized, "utf8");
  const keyring = state.purposes.get(binding.purpose)!.hmac;
  const message = hmacMessage(
    binding,
    state.environment,
    keyring.activeKeyId,
    normalized,
  );
  try {
    return {
      digest: createHmac("sha256", keyring.keys.get(keyring.activeKeyId)!)
        .update(message)
        .digest(),
      hmacKeyId: keyring.activeKeyId,
    };
  } finally {
    valueBytes.fill(0);
    message.fill(0);
  }
}

/**
 * Keyrings exclusivos dos perfis RENAVE. A classe recusa material repetido
 * entre cifra/HMAC e entre CPF/e-mail para tornar a separação operacional
 * verificável, além da separação criptográfica por domínio e propósito.
 */
export class RenavePrincipalCrypto {
  constructor(config: RenavePrincipalCryptoConfig) {
    if (new.target !== RenavePrincipalCrypto) {
      throw new RenavePrincipalConfigurationError();
    }
    const purposes = new Map<RenavePrincipalPurpose, PurposeState>();
    const allKeyIds = new Set<string>();
    const allKeys: Buffer[] = [];
    try {
      if (
        !config?.purposes ||
        (config.environment !== "homologation" &&
          config.environment !== "production")
      ) {
        throw new RenavePrincipalConfigurationError();
      }
      for (const purpose of ["operator-cpf", "establishment-email"] as const) {
        const purposeConfig = config.purposes[purpose];
        if (!purposeConfig) throw new RenavePrincipalConfigurationError();
        purposes.set(purpose, {
          encryption: copyKeyring(purposeConfig.encryption, allKeyIds, allKeys),
          hmac: copyKeyring(purposeConfig.hmac, allKeyIds, allKeys),
        });
      }
      cryptoStates.set(this, {
        destroyed: false,
        environment: config.environment,
        purposes,
      });
      Object.freeze(this);
    } catch {
      for (const key of allKeys) key.fill(0);
      for (const purpose of purposes.values()) {
        purpose.encryption.keys.clear();
        purpose.hmac.keys.clear();
      }
      throw new RenavePrincipalConfigurationError();
    }
  }

  protect(
    value: string,
    binding: RenavePrincipalBinding,
  ): ProtectedRenavePrincipal {
    const state = cryptoState(this);
    const normalizedBinding = normalizeBinding(binding);
    const normalizedValue = normalizeValue(binding.purpose, value);
    const valueBytes = Buffer.from(normalizedValue, "utf8");
    const encryption = state.purposes.get(binding.purpose)!.encryption;
    const chunks: Buffer[] = [];
    let aadBytes: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let hmac: RenavePrincipalHmac | undefined;
    let nonce: Buffer | undefined;
    let plaintext: Buffer | undefined;
    let returned = false;
    try {
      plaintext = paddedPlaintext(valueBytes, binding.purpose);
      nonce = randomBytes(NONCE_BYTES);
      hmac = digestWithState(state, normalizedValue, normalizedBinding);
      aadBytes = aad(
        normalizedBinding,
        state.environment,
        encryption.activeKeyId,
        hmac,
        plaintext.byteLength,
      );
      const cipher = createCipheriv(
        "aes-256-gcm",
        encryption.keys.get(encryption.activeKeyId)!,
        nonce,
        { authTagLength: TAG_BYTES },
      );
      cipher.setAAD(aadBytes);
      chunks.push(cipher.update(plaintext), cipher.final());
      ciphertext = Buffer.concat(chunks);
      const result = {
        aadSha256: createHash("sha256").update(aadBytes).digest(),
        authTag: Buffer.from(cipher.getAuthTag()),
        ciphertext: Buffer.from(ciphertext),
        envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
        hmac,
        keyId: encryption.activeKeyId,
        nonce: Buffer.from(nonce),
      };
      returned = true;
      return result;
    } finally {
      valueBytes.fill(0);
      plaintext?.fill(0);
      nonce?.fill(0);
      aadBytes?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      ciphertext?.fill(0);
      if (!returned) hmac?.digest.fill(0);
    }
  }

  decrypt(
    payload: ProtectedRenavePrincipal,
    binding: RenavePrincipalBinding,
  ): DecryptedRenavePrincipal {
    const state = cryptoState(this);
    const normalizedBinding = normalizeBinding(binding);
    assertEnvelope(payload);
    const encryption = state.purposes.get(binding.purpose)!.encryption;
    const key = encryption.keys.get(payload.keyId);
    if (!key) throw new RenavePrincipalDecryptionError();
    if (
      !payload.hmac ||
      !KEY_ID_PATTERN.test(payload.hmac.hmacKeyId) ||
      !(payload.hmac.digest instanceof Uint8Array) ||
      payload.hmac.digest.byteLength !== DIGEST_BYTES
    ) {
      throw new RenavePrincipalDecryptionError();
    }
    const nonce = Buffer.from(payload.nonce);
    const authTag = Buffer.from(payload.authTag);
    const ciphertext = Buffer.from(payload.ciphertext);
    const aadDigest = Buffer.from(payload.aadSha256);
    const hmacDigest = Buffer.from(payload.hmac.digest);
    const aadBytes = aad(
      normalizedBinding,
      state.environment,
      payload.keyId,
      { digest: hmacDigest, hmacKeyId: payload.hmac.hmacKeyId },
      payload.ciphertext.byteLength,
    );
    const expectedAadDigest = createHash("sha256").update(aadBytes).digest();
    const chunks: Buffer[] = [];
    let plaintext: Buffer | undefined;
    try {
      if (!timingSafeEqual(aadDigest, expectedAadDigest)) {
        throw new RenavePrincipalDecryptionError();
      }
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadBytes);
      decipher.setAuthTag(authTag);
      chunks.push(decipher.update(ciphertext), decipher.final());
      plaintext = Buffer.concat(chunks);
      const decoded = decodePaddedPlaintext(plaintext, binding.purpose);
      if (!this.verifyDigest(decoded, binding, payload.hmac)) {
        throw new RenavePrincipalDecryptionError();
      }
      const decodedBytes = Buffer.from(decoded, "utf8");
      try {
        return decryptedSecret(decodedBytes, binding.purpose);
      } finally {
        decodedBytes.fill(0);
      }
    } catch {
      throw new RenavePrincipalDecryptionError();
    } finally {
      nonce.fill(0);
      authTag.fill(0);
      ciphertext.fill(0);
      aadDigest.fill(0);
      hmacDigest.fill(0);
      aadBytes.fill(0);
      expectedAadDigest.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      plaintext?.fill(0);
    }
  }

  digest(value: string, binding: RenavePrincipalBinding): RenavePrincipalHmac {
    return digestWithState(cryptoState(this), value, normalizeBinding(binding));
  }

  /**
   * Confirma igualdade sob a geração indicada. Um `true` de chave antiga não
   * prova unicidade durante rotação; a camada de persistência precisa manter
   * aliases/reindexação até aposentar a geração anterior.
   */
  verifyDigest(
    value: string,
    binding: RenavePrincipalBinding,
    candidate: RenavePrincipalHmac,
  ): boolean {
    const state = cryptoState(this);
    if (
      !candidate ||
      !KEY_ID_PATTERN.test(candidate.hmacKeyId) ||
      !(candidate.digest instanceof Uint8Array) ||
      candidate.digest.byteLength !== DIGEST_BYTES
    ) {
      throw new RenavePrincipalInputError();
    }
    const normalizedBinding = normalizeBinding(binding);
    const key = state.purposes
      .get(binding.purpose)
      ?.hmac.keys.get(candidate.hmacKeyId);
    if (!key) return false;
    const normalized = normalizeValue(binding.purpose, value);
    const message = hmacMessage(
      normalizedBinding,
      state.environment,
      candidate.hmacKeyId,
      normalized,
    );
    const candidateCopy = Buffer.from(candidate.digest);
    const expected = createHmac("sha256", key).update(message).digest();
    try {
      return timingSafeEqual(candidateCopy, expected);
    } finally {
      message.fill(0);
      candidateCopy.fill(0);
      expected.fill(0);
    }
  }

  destroy(): void {
    const state = cryptoStates.get(this);
    if (!state || state.destroyed) return;
    for (const purpose of state.purposes.values()) {
      for (const key of purpose.encryption.keys.values()) key.fill(0);
      for (const key of purpose.hmac.keys.values()) key.fill(0);
      purpose.encryption.keys.clear();
      purpose.hmac.keys.clear();
    }
    state.purposes.clear();
    state.destroyed = true;
  }
}

Object.freeze(RenavePrincipalCrypto.prototype);
Object.freeze(RenavePrincipalCrypto);
Object.freeze(DecryptedRenavePrincipal.prototype);
Object.freeze(DecryptedRenavePrincipal);
