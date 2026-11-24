import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";

const SCHEMA_VERSION = 1 as const;
const ALGORITHM = "Ed25519" as const;
const AUDIENCE = "seu-renave/operation-promotion-decision/v1" as const;
const ACTION = "promote-held-local-operation" as const;
const EFFECT = "allow" as const;
const MAX_ARTIFACT_BYTES = 32 * 1_024;
const MAX_KEYRING_BYTES = 64 * 1_024;
const MAX_KEYS = 16;
const MAX_TTL_LIMIT_MS = 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_LIMIT_MS = 5 * 60 * 1_000;
const DIGEST_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MIN_NONCE_BYTES = 16;
const MAX_NONCE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const POLICY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const EVIDENCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_BIGINT = /^[1-9][0-9]{0,18}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UF = new Set([
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
]);

export const OPERATION_PROMOTION_DECISION_AUDIENCE = AUDIENCE;
export const OPERATION_PROMOTION_DECISION_ACTION = ACTION;

export type OperationPromotionDecisionEnvironment =
  "homologation" | "production";
export type OperationPromotionServiceNature =
  "establishment" | "ite" | "manufacturer";

export interface OperationAuthorizationBindingClaims {
  credentialLinkVersion: string;
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  jurisdictionGeneration: string;
  jurisdictionUf: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  scopeGeneration: string;
  serviceNature: OperationPromotionServiceNature;
}

export interface OperationPromotionDecisionClaims {
  action: typeof ACTION;
  algorithm: typeof ALGORITHM;
  audience: typeof AUDIENCE;
  binding: OperationAuthorizationBindingClaims;
  changedByDigest: string;
  decisionId: string;
  effect: typeof EFFECT;
  environment: OperationPromotionDecisionEnvironment;
  evidence: Readonly<{ digest: string; type: string }>;
  expiresAt: string;
  executorWorkloadDigest: string;
  issuedAt: string;
  issuerKeyId: string;
  logicalDatabaseId: string;
  nonce: string;
  notBefore: string;
  operationId: string;
  policy: Readonly<{ digest: string; id: string; version: string }>;
  schemaVersion: typeof SCHEMA_VERSION;
  tenantId: string;
}

export interface OperationPromotionKeyring {
  keys: ReadonlyMap<string, KeyObject>;
}

export interface OperationPromotionDecisionVerifierConfig {
  clock?: () => Date;
  environment: OperationPromotionDecisionEnvironment;
  keyring: OperationPromotionKeyring;
  logicalDatabaseId: string;
  maxFutureSkewMs?: number;
  maxTtlMs: number;
}

interface NormalizedClaims {
  claims: OperationPromotionDecisionClaims;
  changedByDigest: Buffer;
  evidenceDigest: Buffer;
  executorWorkloadDigest: Buffer;
  expiresAtMs: number;
  issuedAtMs: number;
  nonce: Buffer;
  notBeforeMs: number;
  policyDigest: Buffer;
}

interface VerifiedState {
  binding: OperationAuthorizationBindingClaims;
  artifactDigest: Buffer;
  authorizationBindingDigest: Buffer;
  changedByDigest: Buffer;
  decisionId: string;
  destroyed: boolean;
  environment: OperationPromotionDecisionEnvironment;
  evidenceManifestDigest: Buffer;
  executorWorkloadDigest: Buffer;
  expiresAt: string;
  issuedAt: string;
  issuerKeyId: string;
  logicalDatabaseId: string;
  notBefore: string;
  operationId: string;
  policyVersion: string;
  tenantId: string;
}

interface VerifierState {
  clock: () => Date;
  destroyed: boolean;
  environment: OperationPromotionDecisionEnvironment;
  keys: Map<string, KeyObject>;
  logicalDatabaseId: string;
  maxFutureSkewMs: number;
  maxTtlMs: number;
}

const verifiedStates = new WeakMap<
  VerifiedOperationPromotionDecision,
  VerifiedState
>();
const verifierStates = new WeakMap<
  OperationPromotionDecisionVerifier,
  VerifierState
>();
const parsedKeyrings = new WeakSet<object>();
const CONSTRUCTION_TOKEN = Symbol("VerifiedOperationPromotionDecision");

export class OperationPromotionDecisionConfigurationError extends Error {
  readonly code = "OPERATION_PROMOTION_DECISION_CONFIGURATION_INVALID";
  override name = "OperationPromotionDecisionConfigurationError";

  constructor() {
    super("A verificação da decisão de promoção está indisponível.");
  }
}

export class OperationPromotionDecisionInvalidError extends Error {
  readonly code = "OPERATION_PROMOTION_DECISION_INVALID";
  override name = "OperationPromotionDecisionInvalidError";

  constructor() {
    super("A decisão de promoção é inválida.");
  }
}

function invalid(): never {
  throw new OperationPromotionDecisionInvalidError();
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
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function decodeBase64Url(
  value: unknown,
  minimum: number,
  maximum: number,
): Buffer {
  if (typeof value !== "string" || !BASE64URL.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength < minimum ||
    decoded.byteLength > maximum ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    return invalid();
  }
  return decoded;
}

function timestamp(value: unknown): { iso: string; milliseconds: number } {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) invalid();
  const parsed = new Date(value);
  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds) || parsed.toISOString() !== value) {
    invalid();
  }
  return { iso: value, milliseconds };
}

function positiveBigint(value: unknown): value is string {
  if (typeof value !== "string" || !POSITIVE_BIGINT.test(value)) return false;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function normalizedBinding(
  value: unknown,
): OperationAuthorizationBindingClaims {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "credentialLinkVersion",
      "establishmentProfileId",
      "establishmentProfileVersion",
      "jurisdictionGeneration",
      "jurisdictionUf",
      "operatorProfileId",
      "operatorProfileVersion",
      "scopeGeneration",
      "serviceNature",
    ]) ||
    (value.serviceNature !== "establishment" &&
      value.serviceNature !== "ite" &&
      value.serviceNature !== "manufacturer") ||
    typeof value.jurisdictionUf !== "string" ||
    !UF.has(value.jurisdictionUf) ||
    !positiveBigint(value.jurisdictionGeneration) ||
    !positiveBigint(value.scopeGeneration) ||
    !positiveBigint(value.credentialLinkVersion) ||
    typeof value.operatorProfileId !== "string" ||
    !UUID.test(value.operatorProfileId) ||
    !positiveBigint(value.operatorProfileVersion) ||
    typeof value.establishmentProfileId !== "string" ||
    !UUID.test(value.establishmentProfileId) ||
    !positiveBigint(value.establishmentProfileVersion)
  ) {
    invalid();
  }
  return Object.freeze({
    credentialLinkVersion: value.credentialLinkVersion,
    establishmentProfileId: value.establishmentProfileId,
    establishmentProfileVersion: value.establishmentProfileVersion,
    jurisdictionGeneration: value.jurisdictionGeneration,
    jurisdictionUf: value.jurisdictionUf,
    operatorProfileId: value.operatorProfileId,
    operatorProfileVersion: value.operatorProfileVersion,
    scopeGeneration: value.scopeGeneration,
    serviceNature: value.serviceNature,
  });
}

function normalizedClaims(value: unknown): NormalizedClaims {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "action",
      "algorithm",
      "audience",
      "binding",
      "changedByDigest",
      "decisionId",
      "effect",
      "environment",
      "evidence",
      "expiresAt",
      "executorWorkloadDigest",
      "issuedAt",
      "issuerKeyId",
      "logicalDatabaseId",
      "nonce",
      "notBefore",
      "operationId",
      "policy",
      "schemaVersion",
      "tenantId",
    ]) ||
    value.action !== ACTION ||
    value.algorithm !== ALGORITHM ||
    value.audience !== AUDIENCE ||
    value.effect !== EFFECT ||
    value.schemaVersion !== SCHEMA_VERSION ||
    (value.environment !== "homologation" &&
      value.environment !== "production") ||
    typeof value.issuerKeyId !== "string" ||
    !KEY_ID.test(value.issuerKeyId) ||
    typeof value.logicalDatabaseId !== "string" ||
    !UUID.test(value.logicalDatabaseId) ||
    typeof value.tenantId !== "string" ||
    !UUID.test(value.tenantId) ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    typeof value.decisionId !== "string" ||
    !UUID.test(value.decisionId) ||
    !plainRecord(value.policy) ||
    !exactKeys(value.policy, ["digest", "id", "version"]) ||
    typeof value.policy.id !== "string" ||
    !POLICY_TOKEN.test(value.policy.id) ||
    typeof value.policy.version !== "string" ||
    !POLICY_VERSION.test(value.policy.version) ||
    !plainRecord(value.evidence) ||
    !exactKeys(value.evidence, ["digest", "type"]) ||
    typeof value.evidence.type !== "string" ||
    !EVIDENCE_TYPE.test(value.evidence.type)
  ) {
    invalid();
  }
  const binding = normalizedBinding(value.binding);
  const issuedAt = timestamp(value.issuedAt);
  const notBefore = timestamp(value.notBefore);
  const expiresAt = timestamp(value.expiresAt);
  let changedByDigest: Buffer | undefined;
  let evidenceDigest: Buffer | undefined;
  let executorWorkloadDigest: Buffer | undefined;
  let policyDigest: Buffer | undefined;
  let nonce: Buffer | undefined;
  try {
    changedByDigest = decodeBase64Url(
      value.changedByDigest,
      DIGEST_BYTES,
      DIGEST_BYTES,
    );
    evidenceDigest = decodeBase64Url(
      value.evidence.digest,
      DIGEST_BYTES,
      DIGEST_BYTES,
    );
    executorWorkloadDigest = decodeBase64Url(
      value.executorWorkloadDigest,
      DIGEST_BYTES,
      DIGEST_BYTES,
    );
    policyDigest = decodeBase64Url(
      value.policy.digest,
      DIGEST_BYTES,
      DIGEST_BYTES,
    );
    nonce = decodeBase64Url(value.nonce, MIN_NONCE_BYTES, MAX_NONCE_BYTES);
    const claims: OperationPromotionDecisionClaims = {
      action: ACTION,
      algorithm: ALGORITHM,
      audience: AUDIENCE,
      binding,
      changedByDigest: changedByDigest.toString("base64url"),
      decisionId: value.decisionId,
      effect: EFFECT,
      environment: value.environment,
      evidence: Object.freeze({
        digest: evidenceDigest.toString("base64url"),
        type: value.evidence.type,
      }),
      expiresAt: expiresAt.iso,
      executorWorkloadDigest: executorWorkloadDigest.toString("base64url"),
      issuedAt: issuedAt.iso,
      issuerKeyId: value.issuerKeyId,
      logicalDatabaseId: value.logicalDatabaseId,
      nonce: nonce.toString("base64url"),
      notBefore: notBefore.iso,
      operationId: value.operationId,
      policy: Object.freeze({
        digest: policyDigest.toString("base64url"),
        id: value.policy.id,
        version: value.policy.version,
      }),
      schemaVersion: SCHEMA_VERSION,
      tenantId: value.tenantId,
    };
    return {
      changedByDigest,
      claims: Object.freeze(claims),
      evidenceDigest,
      executorWorkloadDigest,
      expiresAtMs: expiresAt.milliseconds,
      issuedAtMs: issuedAt.milliseconds,
      nonce,
      notBeforeMs: notBefore.milliseconds,
      policyDigest,
    };
  } catch (error) {
    changedByDigest?.fill(0);
    evidenceDigest?.fill(0);
    executorWorkloadDigest?.fill(0);
    policyDigest?.fill(0);
    nonce?.fill(0);
    throw error;
  }
}

function lengthPrefixed(label: string, value: Uint8Array): Buffer {
  const labelBytes = Buffer.from(label, "utf8");
  const header = Buffer.allocUnsafe(8);
  try {
    header.writeUInt32BE(labelBytes.byteLength, 0);
    header.writeUInt32BE(value.byteLength, 4);
    return Buffer.concat([
      header.subarray(0, 4),
      labelBytes,
      header.subarray(4),
      value,
    ]);
  } finally {
    labelBytes.fill(0);
    header.fill(0);
  }
}

function signingPayload(claims: OperationPromotionDecisionClaims): Buffer {
  const binary = {
    changedByDigest: Buffer.from(claims.changedByDigest, "base64url"),
    evidenceDigest: Buffer.from(claims.evidence.digest, "base64url"),
    executorWorkloadDigest: Buffer.from(
      claims.executorWorkloadDigest,
      "base64url",
    ),
    nonce: Buffer.from(claims.nonce, "base64url"),
    policyDigest: Buffer.from(claims.policy.digest, "base64url"),
  };
  const text = (value: string | number): Buffer =>
    Buffer.from(String(value), "utf8");
  const values: ReadonlyArray<readonly [string, Buffer]> = [
    ["domain", text("seu-renave/operation-promotion-decision/signature/v1")],
    ["schemaVersion", text(claims.schemaVersion)],
    ["algorithm", text(claims.algorithm)],
    ["audience", text(claims.audience)],
    ["action", text(claims.action)],
    ["effect", text(claims.effect)],
    ["issuerKeyId", text(claims.issuerKeyId)],
    ["environment", text(claims.environment)],
    ["logicalDatabaseId", text(claims.logicalDatabaseId)],
    ["tenantId", text(claims.tenantId)],
    ["operationId", text(claims.operationId)],
    ["decisionId", text(claims.decisionId)],
    ["issuedAt", text(claims.issuedAt)],
    ["notBefore", text(claims.notBefore)],
    ["expiresAt", text(claims.expiresAt)],
    ["nonce", binary.nonce],
    ["changedByDigest", binary.changedByDigest],
    ["executorWorkloadDigest", binary.executorWorkloadDigest],
    ["policy.id", text(claims.policy.id)],
    ["policy.version", text(claims.policy.version)],
    ["policy.digest", binary.policyDigest],
    ["evidence.type", text(claims.evidence.type)],
    ["evidence.digest", binary.evidenceDigest],
    ["binding.serviceNature", text(claims.binding.serviceNature)],
    ["binding.jurisdictionUf", text(claims.binding.jurisdictionUf)],
    [
      "binding.jurisdictionGeneration",
      text(claims.binding.jurisdictionGeneration),
    ],
    ["binding.scopeGeneration", text(claims.binding.scopeGeneration)],
    [
      "binding.credentialLinkVersion",
      text(claims.binding.credentialLinkVersion),
    ],
    ["binding.operatorProfileId", text(claims.binding.operatorProfileId)],
    [
      "binding.operatorProfileVersion",
      text(claims.binding.operatorProfileVersion),
    ],
    [
      "binding.establishmentProfileId",
      text(claims.binding.establishmentProfileId),
    ],
    [
      "binding.establishmentProfileVersion",
      text(claims.binding.establishmentProfileVersion),
    ],
  ];
  const chunks: Buffer[] = [];
  try {
    for (const [label, value] of values)
      chunks.push(lengthPrefixed(label, value));
    return Buffer.concat(chunks);
  } finally {
    for (const [, value] of values) value.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function authorizationBindingPayload(
  binding: OperationAuthorizationBindingClaims,
): Buffer {
  const values: ReadonlyArray<readonly [string, Buffer]> = [
    [
      "domain",
      Buffer.from(
        "seu-renave/operation-promotion-decision/authorization-binding/v1",
        "utf8",
      ),
    ],
    ["serviceNature", Buffer.from(binding.serviceNature, "utf8")],
    ["jurisdictionUf", Buffer.from(binding.jurisdictionUf, "utf8")],
    [
      "jurisdictionGeneration",
      Buffer.from(binding.jurisdictionGeneration, "utf8"),
    ],
    ["scopeGeneration", Buffer.from(binding.scopeGeneration, "utf8")],
    [
      "credentialLinkVersion",
      Buffer.from(binding.credentialLinkVersion, "utf8"),
    ],
    ["operatorProfileId", Buffer.from(binding.operatorProfileId, "utf8")],
    [
      "operatorProfileVersion",
      Buffer.from(binding.operatorProfileVersion, "utf8"),
    ],
    [
      "establishmentProfileId",
      Buffer.from(binding.establishmentProfileId, "utf8"),
    ],
    [
      "establishmentProfileVersion",
      Buffer.from(binding.establishmentProfileVersion, "utf8"),
    ],
  ];
  const chunks: Buffer[] = [];
  try {
    for (const [label, value] of values)
      chunks.push(lengthPrefixed(label, value));
    return Buffer.concat(chunks);
  } finally {
    for (const [, value] of values) value.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function digestFields(
  fields: ReadonlyArray<readonly [string, Uint8Array]>,
): Buffer {
  const chunks: Buffer[] = [];
  try {
    for (const [label, value] of fields)
      chunks.push(lengthPrefixed(label, value));
    const hash = createHash("sha256");
    for (const chunk of chunks) hash.update(chunk);
    return hash.digest();
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function encodeOperationPromotionDecisionClaims(input: unknown): Buffer {
  const normalized = normalizedClaims(input);
  try {
    return signingPayload(normalized.claims);
  } finally {
    normalized.changedByDigest.fill(0);
    normalized.evidenceDigest.fill(0);
    normalized.executorWorkloadDigest.fill(0);
    normalized.nonce.fill(0);
    normalized.policyDigest.fill(0);
  }
}

function parseExactJson(
  input: string | Uint8Array,
  maximum: number,
): {
  parsed: unknown;
  raw: string;
} {
  let bytes: Buffer | undefined;
  try {
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > maximum) invalid();
      return { parsed: JSON.parse(input) as unknown, raw: input };
    }
    bytes = Buffer.from(input);
    if (bytes.byteLength < 1 || bytes.byteLength > maximum) invalid();
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { parsed: JSON.parse(raw) as unknown, raw };
  } catch (error) {
    if (error instanceof OperationPromotionDecisionInvalidError) throw error;
    return invalid();
  } finally {
    bytes?.fill(0);
  }
}

function publicKeyFromSpki(value: unknown): KeyObject {
  const encoded = decodeBase64Url(value, 44, 44);
  try {
    if (
      !encoded
        .subarray(0, ED25519_SPKI_PREFIX.byteLength)
        .equals(ED25519_SPKI_PREFIX)
    ) {
      throw new Error("invalid Ed25519 SPKI");
    }
    const key = createPublicKey({ key: encoded, format: "der", type: "spki" });
    const exported = key.export({ format: "der", type: "spki" });
    try {
      if (
        key.type !== "public" ||
        key.asymmetricKeyType !== "ed25519" ||
        !Buffer.isBuffer(exported) ||
        !exported.equals(encoded)
      ) {
        throw new Error("invalid Ed25519 key");
      }
      return key;
    } finally {
      if (Buffer.isBuffer(exported)) exported.fill(0);
    }
  } catch {
    throw new OperationPromotionDecisionConfigurationError();
  } finally {
    encoded.fill(0);
  }
}

export function parseOperationPromotionKeyring(
  input: string | Uint8Array,
): OperationPromotionKeyring {
  let document: ReturnType<typeof parseExactJson>;
  try {
    document = parseExactJson(input, MAX_KEYRING_BYTES);
  } catch {
    throw new OperationPromotionDecisionConfigurationError();
  }
  const value = document.parsed;
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["algorithm", "audience", "keys", "schemaVersion"]) ||
    value.algorithm !== ALGORITHM ||
    value.audience !== AUDIENCE ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > MAX_KEYS
  ) {
    throw new OperationPromotionDecisionConfigurationError();
  }
  const keys = new Map<string, KeyObject>();
  const canonicalKeys: Array<{ keyId: string; publicKeySpki: string }> = [];
  try {
    for (const candidate of value.keys) {
      if (
        !plainRecord(candidate) ||
        !exactKeys(candidate, ["keyId", "publicKeySpki"]) ||
        typeof candidate.keyId !== "string" ||
        !KEY_ID.test(candidate.keyId) ||
        typeof candidate.publicKeySpki !== "string" ||
        keys.has(candidate.keyId)
      ) {
        throw new OperationPromotionDecisionConfigurationError();
      }
      keys.set(candidate.keyId, publicKeyFromSpki(candidate.publicKeySpki));
      canonicalKeys.push({
        keyId: candidate.keyId,
        publicKeySpki: candidate.publicKeySpki,
      });
    }
    const canonical = JSON.stringify({
      algorithm: ALGORITHM,
      audience: AUDIENCE,
      keys: canonicalKeys,
      schemaVersion: SCHEMA_VERSION,
    });
    if (canonical !== document.raw) {
      throw new OperationPromotionDecisionConfigurationError();
    }
    const keyring = Object.freeze({ keys });
    parsedKeyrings.add(keyring);
    return keyring;
  } catch (error) {
    keys.clear();
    if (error instanceof OperationPromotionDecisionConfigurationError)
      throw error;
    throw new OperationPromotionDecisionConfigurationError();
  }
}

function verifiedState(
  decision: VerifiedOperationPromotionDecision,
): VerifiedState {
  const state = verifiedStates.get(decision);
  if (!state || state.destroyed) invalid();
  return state;
}

export class VerifiedOperationPromotionDecision {
  private constructor(token: symbol, state: VerifiedState) {
    if (
      token !== CONSTRUCTION_TOKEN ||
      new.target !== VerifiedOperationPromotionDecision
    ) {
      invalid();
    }
    verifiedStates.set(this, state);
    Object.freeze(this);
  }

  get binding(): OperationAuthorizationBindingClaims {
    return Object.freeze({ ...verifiedState(this).binding });
  }

  get environment(): OperationPromotionDecisionEnvironment {
    return verifiedState(this).environment;
  }

  get expiresAt(): string {
    return verifiedState(this).expiresAt;
  }

  get logicalDatabaseId(): string {
    return verifiedState(this).logicalDatabaseId;
  }

  get operationId(): string {
    return verifiedState(this).operationId;
  }

  get tenantId(): string {
    return verifiedState(this).tenantId;
  }

  promotionInput(): Readonly<{
    artifactDigest: Buffer;
    authorizationBindingDigest: Buffer;
    changedByDigest: Buffer;
    credentialLinkVersion: string;
    decisionId: string;
    environment: OperationPromotionDecisionEnvironment;
    establishmentProfileId: string;
    establishmentProfileVersion: string;
    evidenceManifestDigest: Buffer;
    executorWorkloadDigest: Buffer;
    expiresAt: Date;
    issuedAt: Date;
    issuerKeyId: string;
    jurisdictionGeneration: string;
    jurisdictionUf: string;
    logicalDatabaseId: string;
    notBefore: Date;
    operationId: string;
    operatorProfileId: string;
    operatorProfileVersion: string;
    policyVersion: string;
    scopeGeneration: string;
    serviceNature: OperationPromotionServiceNature;
  }> {
    const state = verifiedState(this);
    return Object.freeze({
      artifactDigest: Buffer.from(state.artifactDigest),
      authorizationBindingDigest: Buffer.from(state.authorizationBindingDigest),
      changedByDigest: Buffer.from(state.changedByDigest),
      credentialLinkVersion: state.binding.credentialLinkVersion,
      decisionId: state.decisionId,
      environment: state.environment,
      establishmentProfileId: state.binding.establishmentProfileId,
      establishmentProfileVersion: state.binding.establishmentProfileVersion,
      evidenceManifestDigest: Buffer.from(state.evidenceManifestDigest),
      executorWorkloadDigest: Buffer.from(state.executorWorkloadDigest),
      expiresAt: new Date(state.expiresAt),
      issuedAt: new Date(state.issuedAt),
      issuerKeyId: state.issuerKeyId,
      jurisdictionGeneration: state.binding.jurisdictionGeneration,
      jurisdictionUf: state.binding.jurisdictionUf,
      logicalDatabaseId: state.logicalDatabaseId,
      notBefore: new Date(state.notBefore),
      operationId: state.operationId,
      operatorProfileId: state.binding.operatorProfileId,
      operatorProfileVersion: state.binding.operatorProfileVersion,
      policyVersion: state.policyVersion,
      scopeGeneration: state.binding.scopeGeneration,
      serviceNature: state.binding.serviceNature,
    });
  }

  destroy(): void {
    const state = verifiedStates.get(this);
    if (!state || state.destroyed) return;
    state.artifactDigest.fill(0);
    state.authorizationBindingDigest.fill(0);
    state.changedByDigest.fill(0);
    state.evidenceManifestDigest.fill(0);
    state.executorWorkloadDigest.fill(0);
    state.decisionId = "";
    state.issuerKeyId = "";
    state.logicalDatabaseId = "";
    state.operationId = "";
    state.policyVersion = "";
    state.tenantId = "";
    state.destroyed = true;
    verifiedStates.delete(this);
  }

  static create(state: VerifiedState): VerifiedOperationPromotionDecision {
    return new VerifiedOperationPromotionDecision(CONSTRUCTION_TOKEN, state);
  }
}

export class OperationPromotionDecisionVerifier {
  constructor(config: OperationPromotionDecisionVerifierConfig) {
    if (new.target !== OperationPromotionDecisionVerifier) {
      throw new OperationPromotionDecisionConfigurationError();
    }
    const maxFutureSkewMs = config?.maxFutureSkewMs ?? 30_000;
    if (
      (config?.environment !== "homologation" &&
        config?.environment !== "production") ||
      !UUID.test(config.logicalDatabaseId) ||
      !Number.isSafeInteger(config.maxTtlMs) ||
      config.maxTtlMs < 1 ||
      config.maxTtlMs > MAX_TTL_LIMIT_MS ||
      !Number.isSafeInteger(maxFutureSkewMs) ||
      maxFutureSkewMs < 0 ||
      maxFutureSkewMs > MAX_FUTURE_SKEW_LIMIT_MS ||
      !config.keyring ||
      !parsedKeyrings.has(config.keyring as object) ||
      !(config.keyring.keys instanceof Map) ||
      config.keyring.keys.size < 1 ||
      config.keyring.keys.size > MAX_KEYS ||
      (config.clock !== undefined && typeof config.clock !== "function")
    ) {
      throw new OperationPromotionDecisionConfigurationError();
    }
    const keys = new Map<string, KeyObject>();
    for (const [keyId, key] of config.keyring.keys) {
      if (
        !KEY_ID.test(keyId) ||
        key.type !== "public" ||
        key.asymmetricKeyType !== "ed25519" ||
        keys.has(keyId)
      ) {
        throw new OperationPromotionDecisionConfigurationError();
      }
      keys.set(keyId, key);
    }
    verifierStates.set(this, {
      clock: config.clock ?? (() => new Date()),
      destroyed: false,
      environment: config.environment,
      keys,
      logicalDatabaseId: config.logicalDatabaseId,
      maxFutureSkewMs,
      maxTtlMs: config.maxTtlMs,
    });
    Object.freeze(this);
  }

  verify(input: string | Uint8Array): VerifiedOperationPromotionDecision {
    const state = verifierStates.get(this);
    if (!state || state.destroyed) {
      throw new OperationPromotionDecisionConfigurationError();
    }
    const document = parseExactJson(input, MAX_ARTIFACT_BYTES);
    if (
      !plainRecord(document.parsed) ||
      !exactKeys(document.parsed, ["claims", "signature"])
    ) {
      invalid();
    }
    const normalized = normalizedClaims(document.parsed.claims);
    let signature: Buffer | undefined;
    let payload: Buffer | undefined;
    let authorizationBindingDigest: Buffer | undefined;
    let artifactDigest: Buffer | undefined;
    let returned = false;
    try {
      signature = decodeBase64Url(
        document.parsed.signature,
        SIGNATURE_BYTES,
        SIGNATURE_BYTES,
      );
      const canonical = JSON.stringify({
        claims: normalized.claims,
        signature: signature.toString("base64url"),
      });
      if (canonical !== document.raw) invalid();
      payload = signingPayload(normalized.claims);
      const key = state.keys.get(normalized.claims.issuerKeyId);
      if (!key || !verifySignature(null, payload, key, signature)) invalid();
      const nowValue = state.clock();
      const now = nowValue instanceof Date ? nowValue.getTime() : Number.NaN;
      if (
        !Number.isFinite(now) ||
        normalized.claims.environment !== state.environment ||
        normalized.claims.logicalDatabaseId !== state.logicalDatabaseId ||
        normalized.issuedAtMs > normalized.notBeforeMs ||
        normalized.notBeforeMs >= normalized.expiresAtMs ||
        normalized.expiresAtMs - normalized.issuedAtMs > state.maxTtlMs ||
        normalized.issuedAtMs > now + state.maxFutureSkewMs ||
        normalized.notBeforeMs > now + state.maxFutureSkewMs ||
        normalized.expiresAtMs <= now
      ) {
        invalid();
      }
      const artifactDomain = Buffer.from(
        "seu-renave/operation-promotion-decision/artifact/v1",
        "utf8",
      );
      let bindingPayload: Buffer | undefined;
      try {
        bindingPayload = authorizationBindingPayload(normalized.claims.binding);
        authorizationBindingDigest = createHash("sha256")
          .update(bindingPayload)
          .digest();
        artifactDigest = digestFields([
          ["domain", artifactDomain],
          ["claims", payload],
          ["signature", signature],
        ]);
      } finally {
        bindingPayload?.fill(0);
        artifactDomain.fill(0);
      }
      const result = VerifiedOperationPromotionDecision.create({
        artifactDigest,
        authorizationBindingDigest,
        binding: normalized.claims.binding,
        changedByDigest: Buffer.from(normalized.changedByDigest),
        decisionId: normalized.claims.decisionId,
        destroyed: false,
        environment: normalized.claims.environment,
        evidenceManifestDigest: Buffer.from(normalized.evidenceDigest),
        executorWorkloadDigest: Buffer.from(normalized.executorWorkloadDigest),
        expiresAt: normalized.claims.expiresAt,
        issuedAt: normalized.claims.issuedAt,
        issuerKeyId: normalized.claims.issuerKeyId,
        logicalDatabaseId: normalized.claims.logicalDatabaseId,
        notBefore: normalized.claims.notBefore,
        operationId: normalized.claims.operationId,
        policyVersion: normalized.claims.policy.version,
        tenantId: normalized.claims.tenantId,
      });
      returned = true;
      return result;
    } finally {
      normalized.changedByDigest.fill(0);
      normalized.evidenceDigest.fill(0);
      normalized.executorWorkloadDigest.fill(0);
      normalized.nonce.fill(0);
      normalized.policyDigest.fill(0);
      signature?.fill(0);
      payload?.fill(0);
      if (!returned) {
        authorizationBindingDigest?.fill(0);
        artifactDigest?.fill(0);
      }
    }
  }

  destroy(): void {
    const state = verifierStates.get(this);
    if (!state || state.destroyed) return;
    state.keys.clear();
    state.destroyed = true;
    verifierStates.delete(this);
  }
}
