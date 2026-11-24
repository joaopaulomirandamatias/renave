import {
  createHash,
  createPublicKey,
  KeyObject,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

const SCHEMA_VERSION = 1 as const;
const ALGORITHM = "Ed25519" as const;
const AUDIENCE = "seu-renave/profile-verification/v1" as const;
const DIGEST_BYTES = 32;
const MIN_NONCE_BYTES = 16;
const MAX_NONCE_BYTES = 64;
const MAX_TTL_LIMIT_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_LIMIT_MS = 5 * 60 * 1_000;
const MAX_TOKEN_BYTES = 16 * 1_024;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const METHOD_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f\ud800-\udfff]{1,255}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const OFFSET_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

export const RENAVE_PROFILE_EVIDENCE_AUDIENCE = AUDIENCE;

export type RenaveProfileEvidenceEnvironment = "homologation" | "production";
export type RenaveProfileEvidenceProvider =
  | "oidc_verified_claim"
  | "regulated_provider"
  | "mailbox_challenge"
  | "serpro_registry";
export type RenaveProfileEvidenceTargetType = "operator" | "establishment";

export interface RenaveProfileEvidenceClaims {
  algorithm: typeof ALGORITHM;
  audience: typeof AUDIENCE;
  environment: RenaveProfileEvidenceEnvironment;
  expectedProfileVersion: number;
  expiresAt: string;
  issuedAt: string;
  issuerKeyId: string;
  methodVersion: string;
  nonce: string;
  profileId: string;
  provider: RenaveProfileEvidenceProvider;
  schemaVersion: typeof SCHEMA_VERSION;
  targetId: string;
  targetType: RenaveProfileEvidenceTargetType;
  tenantId: string;
  valueHmac: string;
  valueHmacKeyId: string;
}

export interface RenaveProfileEvidenceBinding {
  environment: RenaveProfileEvidenceEnvironment;
  expectedProfileVersion: number;
  methodVersion: string;
  profileId: string;
  provider: RenaveProfileEvidenceProvider;
  targetId: string;
  targetType: RenaveProfileEvidenceTargetType;
  tenantId: string;
  valueHmac: Uint8Array;
  valueHmacKeyId: string;
}

export interface RenaveProfileEvidenceKeyring {
  keys: ReadonlyMap<string, KeyObject | string | Uint8Array>;
}

export interface RenaveProfileEvidenceVerifierConfig {
  clock?: () => Date;
  environment: RenaveProfileEvidenceEnvironment;
  keyring: RenaveProfileEvidenceKeyring;
  maxFutureSkewMs?: number;
  maxTtlMs: number;
}

export interface VerifiedProfileEvidenceSnapshot {
  evidenceDigest: Buffer;
  environment: RenaveProfileEvidenceEnvironment;
  expectedProfileVersion: number;
  expiresAt: string;
  issuedAt: string;
  issuerKeyId: string;
  methodVersion: string;
  nonce: Buffer;
  profileId: string;
  provider: RenaveProfileEvidenceProvider;
  targetId: string;
  targetType: RenaveProfileEvidenceTargetType;
  tenantId: string;
  valueHmac: Buffer;
  valueHmacKeyId: string;
}

interface VerifiedState extends VerifiedProfileEvidenceSnapshot {
  destroyed: boolean;
}

interface VerifierState {
  clock: () => Date;
  destroyed: boolean;
  environment: RenaveProfileEvidenceEnvironment;
  keys: Map<string, KeyObject>;
  maxFutureSkewMs: number;
  maxTtlMs: number;
}

const CONSTRUCTION_TOKEN = Symbol("VerifiedProfileEvidence");
const verifiedStates = new WeakMap<VerifiedProfileEvidence, VerifiedState>();
const destroyedEvidence = new WeakSet<VerifiedProfileEvidence>();
const verifierStates = new WeakMap<
  RenaveProfileEvidenceVerifier,
  VerifierState
>();
const destroyedVerifiers = new WeakSet<RenaveProfileEvidenceVerifier>();

export class RenaveProfileEvidenceConfigurationError extends Error {
  readonly code = "RENAVE_PROFILE_EVIDENCE_CONFIGURATION_INVALID";

  constructor() {
    super("A verificação de evidência de perfil RENAVE está indisponível.");
    this.name = "RenaveProfileEvidenceConfigurationError";
  }
}

export class RenaveProfileEvidenceInvalidError extends Error {
  readonly code = "RENAVE_PROFILE_EVIDENCE_INVALID";

  constructor() {
    super("A evidência de perfil RENAVE é inválida.");
    this.name = "RenaveProfileEvidenceInvalidError";
  }
}

function verifiedState(evidence: VerifiedProfileEvidence): VerifiedState {
  const state = verifiedStates.get(evidence);
  if (!state || state.destroyed || destroyedEvidence.has(evidence)) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  return state;
}

function verifierState(verifier: RenaveProfileEvidenceVerifier): VerifierState {
  const state = verifierStates.get(verifier);
  if (!state || state.destroyed) {
    throw new RenaveProfileEvidenceConfigurationError();
  }
  return state;
}

export class VerifiedProfileEvidence {
  private constructor(token: symbol, state: VerifiedState) {
    if (
      token !== CONSTRUCTION_TOKEN ||
      new.target !== VerifiedProfileEvidence
    ) {
      throw new RenaveProfileEvidenceInvalidError();
    }
    verifiedStates.set(this, state);
    Object.freeze(this);
  }

  get evidenceDigest(): Buffer {
    return Buffer.from(verifiedState(this).evidenceDigest);
  }

  get provider(): RenaveProfileEvidenceProvider {
    return verifiedState(this).provider;
  }

  get targetType(): RenaveProfileEvidenceTargetType {
    return verifiedState(this).targetType;
  }

  destroy(): void {
    const state = verifiedStates.get(this);
    if (!state) {
      if (destroyedEvidence.has(this)) return;
      throw new RenaveProfileEvidenceInvalidError();
    }
    if (state.destroyed) return;
    state.evidenceDigest.fill(0);
    state.nonce.fill(0);
    state.valueHmac.fill(0);
    state.targetId = "";
    state.tenantId = "";
    state.profileId = "";
    state.destroyed = true;
    destroyedEvidence.add(this);
    verifiedStates.delete(this);
  }

  toJSON(): Readonly<{
    evidenceDigest: string;
    environment: RenaveProfileEvidenceEnvironment;
    expectedProfileVersion: number;
    expiresAt: string;
    issuerKeyId: string;
    methodVersion: string;
    provider: RenaveProfileEvidenceProvider;
    targetType: RenaveProfileEvidenceTargetType;
  }> {
    const state = verifiedState(this);
    return Object.freeze({
      evidenceDigest: state.evidenceDigest.toString("hex"),
      environment: state.environment,
      expectedProfileVersion: state.expectedProfileVersion,
      expiresAt: state.expiresAt,
      issuerKeyId: state.issuerKeyId,
      methodVersion: state.methodVersion,
      provider: state.provider,
      targetType: state.targetType,
    });
  }

  static create(token: symbol, state: VerifiedState): VerifiedProfileEvidence {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new RenaveProfileEvidenceInvalidError();
    }
    return new VerifiedProfileEvidence(CONSTRUCTION_TOKEN, state);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function decodeBase64Url(
  value: unknown,
  minimum: number,
  maximum: number,
): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength < minimum ||
    decoded.byteLength > maximum ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw new RenaveProfileEvidenceInvalidError();
  }
  return decoded;
}

function canonicalTimestamp(value: unknown): {
  iso: string;
  milliseconds: number;
} {
  if (typeof value !== "string") {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const match = OFFSET_DATE_TIME.exec(value);
  if (!match) throw new RenaveProfileEvidenceInvalidError();
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction = "",
    zone,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [
    yearNumber,
    monthNumber,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
  ] = parts;
  if (
    parts.some((part) => !Number.isInteger(part)) ||
    !yearNumber ||
    !monthNumber ||
    !dayNumber ||
    hourNumber === undefined ||
    minuteNumber === undefined ||
    secondNumber === undefined ||
    monthNumber > 12 ||
    hourNumber > 23 ||
    minuteNumber > 59 ||
    secondNumber > 59
  ) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const offsetHours = zone === "Z" ? 0 : Number(offsetHour);
  const offsetMinutes = zone === "Z" ? 0 : Number(offsetMinute);
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const localMilliseconds = Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  const local = new Date(localMilliseconds);
  if (
    local.getUTCFullYear() !== yearNumber ||
    local.getUTCMonth() !== monthNumber - 1 ||
    local.getUTCDate() !== dayNumber ||
    local.getUTCHours() !== hourNumber ||
    local.getUTCMinutes() !== minuteNumber ||
    local.getUTCSeconds() !== secondNumber
  ) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  const milliseconds = localMilliseconds - (sign === "-" ? -offset : offset);
  if (!Number.isFinite(milliseconds)) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function validProviderTarget(
  provider: unknown,
  targetType: unknown,
): provider is RenaveProfileEvidenceProvider {
  return (
    (targetType === "operator" &&
      (provider === "oidc_verified_claim" ||
        provider === "regulated_provider")) ||
    (targetType === "establishment" &&
      (provider === "mailbox_challenge" || provider === "serpro_registry"))
  );
}

function normalizeTargetId(targetType: unknown, targetId: unknown): string {
  if (typeof targetId !== "string" || targetId.trim() !== targetId) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  if (
    targetType === "operator" &&
    targetId.trim().length > 0 &&
    SUBJECT_PATTERN.test(targetId)
  ) {
    return targetId;
  }
  if (targetType === "establishment" && UUID_PATTERN.test(targetId))
    return targetId;
  throw new RenaveProfileEvidenceInvalidError();
}

function normalizedClaims(value: unknown): {
  claims: RenaveProfileEvidenceClaims;
  expiresAtMs: number;
  issuedAtMs: number;
  nonce: Buffer;
  valueHmac: Buffer;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "algorithm",
      "audience",
      "environment",
      "expectedProfileVersion",
      "expiresAt",
      "issuedAt",
      "issuerKeyId",
      "methodVersion",
      "nonce",
      "profileId",
      "provider",
      "schemaVersion",
      "targetId",
      "targetType",
      "tenantId",
      "valueHmac",
      "valueHmacKeyId",
    ]) ||
    value.algorithm !== ALGORITHM ||
    value.audience !== AUDIENCE ||
    (value.environment !== "homologation" &&
      value.environment !== "production") ||
    !Number.isSafeInteger(value.expectedProfileVersion) ||
    (value.expectedProfileVersion as number) < 1 ||
    typeof value.issuerKeyId !== "string" ||
    !KEY_ID_PATTERN.test(value.issuerKeyId) ||
    typeof value.valueHmacKeyId !== "string" ||
    !KEY_ID_PATTERN.test(value.valueHmacKeyId) ||
    typeof value.methodVersion !== "string" ||
    !METHOD_VERSION_PATTERN.test(value.methodVersion) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    (value.targetType !== "operator" && value.targetType !== "establishment") ||
    !validProviderTarget(value.provider, value.targetType) ||
    typeof value.tenantId !== "string" ||
    !UUID_PATTERN.test(value.tenantId) ||
    typeof value.profileId !== "string" ||
    !UUID_PATTERN.test(value.profileId)
  ) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const targetId = normalizeTargetId(value.targetType, value.targetId);
  const issuedAt = canonicalTimestamp(value.issuedAt);
  const expiresAt = canonicalTimestamp(value.expiresAt);
  let nonce: Buffer | undefined;
  let valueHmac: Buffer | undefined;
  try {
    nonce = decodeBase64Url(value.nonce, MIN_NONCE_BYTES, MAX_NONCE_BYTES);
    valueHmac = decodeBase64Url(value.valueHmac, DIGEST_BYTES, DIGEST_BYTES);
    return {
      claims: {
        algorithm: ALGORITHM,
        audience: AUDIENCE,
        environment: value.environment,
        expectedProfileVersion: value.expectedProfileVersion as number,
        expiresAt: expiresAt.iso,
        issuedAt: issuedAt.iso,
        issuerKeyId: value.issuerKeyId,
        methodVersion: value.methodVersion,
        nonce: nonce.toString("base64url"),
        profileId: value.profileId,
        provider: value.provider,
        schemaVersion: SCHEMA_VERSION,
        targetId,
        targetType: value.targetType,
        tenantId: value.tenantId,
        valueHmac: valueHmac.toString("base64url"),
        valueHmacKeyId: value.valueHmacKeyId,
      },
      expiresAtMs: expiresAt.milliseconds,
      issuedAtMs: issuedAt.milliseconds,
      nonce,
      valueHmac,
    };
  } catch (error) {
    nonce?.fill(0);
    valueHmac?.fill(0);
    throw error;
  }
}

function lengthPrefixed(label: string, value: Uint8Array): Buffer {
  const labelBytes = Buffer.from(label, "utf8");
  const labelLength = Buffer.allocUnsafe(4);
  const valueLength = Buffer.allocUnsafe(4);
  try {
    labelLength.writeUInt32BE(labelBytes.byteLength);
    valueLength.writeUInt32BE(value.byteLength);
    return Buffer.concat([labelLength, labelBytes, valueLength, value]);
  } finally {
    labelLength.fill(0);
    valueLength.fill(0);
    labelBytes.fill(0);
  }
}

function signingPayload(claims: RenaveProfileEvidenceClaims): Buffer {
  const binary = {
    nonce: Buffer.from(claims.nonce, "base64url"),
    valueHmac: Buffer.from(claims.valueHmac, "base64url"),
  };
  const values: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["domain", Buffer.from("seu-renave/profile-evidence/signature/v1", "utf8")],
    ["schemaVersion", Buffer.from(String(claims.schemaVersion), "utf8")],
    ["algorithm", Buffer.from(claims.algorithm, "utf8")],
    ["audience", Buffer.from(claims.audience, "utf8")],
    ["environment", Buffer.from(claims.environment, "utf8")],
    ["provider", Buffer.from(claims.provider, "utf8")],
    ["issuerKeyId", Buffer.from(claims.issuerKeyId, "utf8")],
    ["tenantId", Buffer.from(claims.tenantId, "utf8")],
    ["targetType", Buffer.from(claims.targetType, "utf8")],
    ["targetId", Buffer.from(claims.targetId, "utf8")],
    ["profileId", Buffer.from(claims.profileId, "utf8")],
    [
      "expectedProfileVersion",
      Buffer.from(String(claims.expectedProfileVersion), "utf8"),
    ],
    ["valueHmacKeyId", Buffer.from(claims.valueHmacKeyId, "utf8")],
    ["valueHmac", binary.valueHmac],
    ["issuedAt", Buffer.from(claims.issuedAt, "utf8")],
    ["expiresAt", Buffer.from(claims.expiresAt, "utf8")],
    ["nonce", binary.nonce],
    ["methodVersion", Buffer.from(claims.methodVersion, "utf8")],
  ];
  const chunks: Buffer[] = [];
  try {
    for (const [label, value] of values)
      chunks.push(lengthPrefixed(label, value));
    return Buffer.concat(chunks);
  } finally {
    for (const [, value] of values) {
      if (Buffer.isBuffer(value)) value.fill(0);
    }
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function encodeRenaveProfileEvidenceClaims(input: unknown): Buffer {
  const normalized = normalizedClaims(input);
  try {
    return signingPayload(normalized.claims);
  } finally {
    normalized.nonce.fill(0);
    normalized.valueHmac.fill(0);
  }
}

function normalizeBinding(binding: RenaveProfileEvidenceBinding): {
  binding: Omit<RenaveProfileEvidenceBinding, "valueHmac">;
  valueHmac: Buffer;
} {
  if (!binding || !(binding.valueHmac instanceof Uint8Array)) {
    throw new RenaveProfileEvidenceInvalidError();
  }
  const valueHmac = Buffer.from(binding.valueHmac);
  if (valueHmac.byteLength !== DIGEST_BYTES) {
    valueHmac.fill(0);
    throw new RenaveProfileEvidenceInvalidError();
  }
  const syntheticNonce = Buffer.alloc(MIN_NONCE_BYTES);
  let synthetic: ReturnType<typeof normalizedClaims> | undefined;
  try {
    synthetic = normalizedClaims({
      algorithm: ALGORITHM,
      audience: AUDIENCE,
      environment: binding.environment,
      expectedProfileVersion: binding.expectedProfileVersion,
      expiresAt: "2000-01-01T00:01:00.000Z",
      issuedAt: "2000-01-01T00:00:00.000Z",
      issuerKeyId: "binding-validation",
      methodVersion: binding.methodVersion,
      nonce: syntheticNonce.toString("base64url"),
      profileId: binding.profileId,
      provider: binding.provider,
      schemaVersion: SCHEMA_VERSION,
      targetId: binding.targetId,
      targetType: binding.targetType,
      tenantId: binding.tenantId,
      valueHmac: valueHmac.toString("base64url"),
      valueHmacKeyId: binding.valueHmacKeyId,
    });
    return {
      binding: {
        environment: binding.environment,
        expectedProfileVersion: binding.expectedProfileVersion,
        methodVersion: binding.methodVersion,
        profileId: binding.profileId,
        provider: binding.provider,
        targetId: binding.targetId,
        targetType: binding.targetType,
        tenantId: binding.tenantId,
        valueHmacKeyId: binding.valueHmacKeyId,
      },
      valueHmac,
    };
  } catch (error) {
    valueHmac.fill(0);
    throw error;
  } finally {
    syntheticNonce.fill(0);
    synthetic?.nonce.fill(0);
    synthetic?.valueHmac.fill(0);
  }
}

function sameBinding(
  claims: RenaveProfileEvidenceClaims,
  expected: Omit<RenaveProfileEvidenceBinding, "valueHmac">,
  expectedHmac: Buffer,
  actualHmac: Buffer,
): boolean {
  return (
    claims.environment === expected.environment &&
    claims.provider === expected.provider &&
    claims.tenantId === expected.tenantId &&
    claims.targetType === expected.targetType &&
    claims.targetId === expected.targetId &&
    claims.profileId === expected.profileId &&
    claims.expectedProfileVersion === expected.expectedProfileVersion &&
    claims.valueHmacKeyId === expected.valueHmacKeyId &&
    claims.methodVersion === expected.methodVersion &&
    expectedHmac.byteLength === actualHmac.byteLength &&
    timingSafeEqual(expectedHmac, actualHmac)
  );
}

function publicKey(material: KeyObject | string | Uint8Array): KeyObject {
  let encoded: Buffer | undefined;
  try {
    if (
      typeof material === "string" &&
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(material)
    ) {
      throw new RenaveProfileEvidenceConfigurationError();
    }
    const parsed =
      material instanceof KeyObject
        ? material
        : typeof material === "string"
          ? createPublicKey(material)
          : (() => {
              encoded = Buffer.from(material);
              return createPublicKey({
                key: encoded,
                format: "der",
                type: "spki",
              });
            })();
    if (parsed.type !== "public" || parsed.asymmetricKeyType !== "ed25519") {
      throw new Error("invalid key");
    }
    return parsed;
  } catch {
    throw new RenaveProfileEvidenceConfigurationError();
  } finally {
    encoded?.fill(0);
  }
}

export class RenaveProfileEvidenceVerifier {
  constructor(config: RenaveProfileEvidenceVerifierConfig) {
    if (new.target !== RenaveProfileEvidenceVerifier) {
      throw new RenaveProfileEvidenceConfigurationError();
    }
    const keys = new Map<string, KeyObject>();
    try {
      const maxFutureSkewMs = config?.maxFutureSkewMs ?? 60_000;
      if (
        (config?.environment !== "homologation" &&
          config?.environment !== "production") ||
        !Number.isSafeInteger(config.maxTtlMs) ||
        config.maxTtlMs < 1 ||
        config.maxTtlMs > MAX_TTL_LIMIT_MS ||
        !Number.isSafeInteger(maxFutureSkewMs) ||
        maxFutureSkewMs < 0 ||
        maxFutureSkewMs > MAX_FUTURE_SKEW_LIMIT_MS ||
        !config.keyring?.keys ||
        config.keyring.keys.size < 1 ||
        (config.clock !== undefined && typeof config.clock !== "function")
      ) {
        throw new RenaveProfileEvidenceConfigurationError();
      }
      for (const [keyId, material] of config.keyring.keys) {
        if (!KEY_ID_PATTERN.test(keyId) || keys.has(keyId)) {
          throw new RenaveProfileEvidenceConfigurationError();
        }
        keys.set(keyId, publicKey(material));
      }
      verifierStates.set(this, {
        clock: config.clock ?? (() => new Date()),
        destroyed: false,
        environment: config.environment,
        keys,
        maxFutureSkewMs,
        maxTtlMs: config.maxTtlMs,
      });
      Object.freeze(this);
    } catch (error) {
      keys.clear();
      if (error instanceof RenaveProfileEvidenceConfigurationError) throw error;
      throw new RenaveProfileEvidenceConfigurationError();
    }
  }

  verify(
    token: string,
    binding: RenaveProfileEvidenceBinding,
  ): VerifiedProfileEvidence {
    const state = verifierState(this);
    let parsed: unknown;
    try {
      if (
        typeof token !== "string" ||
        Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
      ) {
        throw new RenaveProfileEvidenceInvalidError();
      }
      parsed = JSON.parse(token) as unknown;
    } catch {
      throw new RenaveProfileEvidenceInvalidError();
    }
    if (!plainRecord(parsed) || !exactKeys(parsed, ["claims", "signature"])) {
      throw new RenaveProfileEvidenceInvalidError();
    }
    const normalized = normalizedClaims(parsed.claims);
    let signature: Buffer | undefined;
    let payload: Buffer | undefined;
    let expected: ReturnType<typeof normalizeBinding> | undefined;
    let evidenceDigest: Buffer | undefined;
    let returned = false;
    try {
      signature = decodeBase64Url(parsed.signature, 64, 64);
      payload = signingPayload(normalized.claims);
      const key = state.keys.get(normalized.claims.issuerKeyId);
      if (!key || !verifySignature(null, payload, key, signature)) {
        throw new RenaveProfileEvidenceInvalidError();
      }
      expected = normalizeBinding(binding);
      const nowValue = state.clock();
      const now = nowValue instanceof Date ? nowValue.getTime() : Number.NaN;
      const ttl = normalized.expiresAtMs - normalized.issuedAtMs;
      if (
        !Number.isFinite(now) ||
        normalized.claims.environment !== state.environment ||
        normalized.expiresAtMs <= normalized.issuedAtMs ||
        ttl > state.maxTtlMs ||
        normalized.issuedAtMs > now + state.maxFutureSkewMs ||
        normalized.expiresAtMs <= now ||
        !sameBinding(
          normalized.claims,
          expected.binding,
          expected.valueHmac,
          normalized.valueHmac,
        )
      ) {
        throw new RenaveProfileEvidenceInvalidError();
      }
      const digestClaims = lengthPrefixed("claims", payload);
      const digestSignature = lengthPrefixed("signature", signature);
      try {
        evidenceDigest = createHash("sha256")
          .update(digestClaims)
          .update(digestSignature)
          .digest();
      } finally {
        digestClaims.fill(0);
        digestSignature.fill(0);
      }
      const result = VerifiedProfileEvidence.create(CONSTRUCTION_TOKEN, {
        evidenceDigest,
        environment: normalized.claims.environment,
        expectedProfileVersion: normalized.claims.expectedProfileVersion,
        expiresAt: normalized.claims.expiresAt,
        issuedAt: normalized.claims.issuedAt,
        issuerKeyId: normalized.claims.issuerKeyId,
        methodVersion: normalized.claims.methodVersion,
        nonce: Buffer.from(normalized.nonce),
        profileId: normalized.claims.profileId,
        provider: normalized.claims.provider,
        targetId: normalized.claims.targetId,
        targetType: normalized.claims.targetType,
        tenantId: normalized.claims.tenantId,
        valueHmac: Buffer.from(normalized.valueHmac),
        valueHmacKeyId: normalized.claims.valueHmacKeyId,
        destroyed: false,
      });
      returned = true;
      return result;
    } catch (error) {
      if (error instanceof RenaveProfileEvidenceInvalidError) throw error;
      throw new RenaveProfileEvidenceInvalidError();
    } finally {
      payload?.fill(0);
      signature?.fill(0);
      normalized.nonce.fill(0);
      normalized.valueHmac.fill(0);
      expected?.valueHmac.fill(0);
      if (!returned) evidenceDigest?.fill(0);
    }
  }

  destroy(): void {
    const state = verifierStates.get(this);
    if (!state) {
      if (destroyedVerifiers.has(this)) return;
      throw new RenaveProfileEvidenceConfigurationError();
    }
    if (state.destroyed) return;
    state.keys.clear();
    state.destroyed = true;
    destroyedVerifiers.add(this);
    verifierStates.delete(this);
  }
}

export function readVerifiedProfileEvidence(
  evidence: VerifiedProfileEvidence,
): VerifiedProfileEvidenceSnapshot {
  const state = verifiedState(evidence);
  return Object.freeze({
    evidenceDigest: Buffer.from(state.evidenceDigest),
    environment: state.environment,
    expectedProfileVersion: state.expectedProfileVersion,
    expiresAt: state.expiresAt,
    issuedAt: state.issuedAt,
    issuerKeyId: state.issuerKeyId,
    methodVersion: state.methodVersion,
    nonce: Buffer.from(state.nonce),
    profileId: state.profileId,
    provider: state.provider,
    targetId: state.targetId,
    targetType: state.targetType,
    tenantId: state.tenantId,
    valueHmac: Buffer.from(state.valueHmac),
    valueHmacKeyId: state.valueHmacKeyId,
  });
}

Object.freeze(VerifiedProfileEvidence.prototype);
Object.freeze(VerifiedProfileEvidence);
Object.freeze(RenaveProfileEvidenceVerifier.prototype);
Object.freeze(RenaveProfileEvidenceVerifier);
