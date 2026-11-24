import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { OperationKind, OperationMutationFamily } from "@seu-renave/db";
import {
  readPreparedRenaveMutation,
  type CrvType,
  type PreparedRenaveMutation,
  type RenaveEnvironment,
} from "@seu-renave/renave-connector";

const PROJECTION_KIND = "STOCK_ENTRY_RECONCILIATION" as const;
const PROJECTION_SCHEMA_VERSION = 1 as const;
const MAX_PROJECTION_BYTES = 4_096;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRAZILIAN_PLATE_PATTERN = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u;
const CPF_SOURCE_PATTERN = /^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/u;
const EMAIL_PATTERN = /^[-A-Za-z0-9_.]+@[-A-Za-z0-9_]+\.[-A-Za-z0-9_.]+$/u;
const SECURITY_CODE_PATTERN = /^\d{11}$/u;
const CRV_NUMBER_PATTERN = /^\d{12}$/u;
const RENAVAM_PATTERN = /^\d{11}$/u;
const CPF_PATTERN = /^\d{11}$/u;
const CNPJ_PATTERN = /^[A-Za-z0-9]{12}\d{2}$/u;
const MAX_PURCHASE_VALUE = 99_999_999.99;
const MAX_INT32 = 2_147_483_647;
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);
const PURPOSE = "seu-renave-operation-reconciliation-projection-v1";
const HKDF_SALT = Buffer.from(
  "seu-renave-operation-reconciliation-projection-hkdf-salt-v1",
  "utf8",
);

type JsonObject = Record<string, unknown>;
type OwnedBytes = Uint8Array<ArrayBuffer>;

export interface StockEntryReconciliationProjectionV1 {
  readonly schemaVersion: 1;
  readonly cpfOperadorResponsavel: string;
  readonly veiculo: Readonly<{
    codigoSegurancaCrv: string;
    numeroCrv?: string;
    placa: string;
    renavam?: string;
    tipoCrv: CrvType;
  }>;
}

export interface OperationReconciliationProjectionBinding {
  environment: RenaveEnvironment;
  establishmentId: string;
  generation: number;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  operationId: string;
  requestSchemaVersion: number;
  sourceRequestSha256: string;
  tenantId: string;
}

export interface EncryptedOperationReconciliationProjection {
  authTag: Buffer;
  ciphertext: Buffer;
  generation: number;
  keyId: string;
  nonce: Buffer;
  projectionByteLength: number;
  projectionKind: typeof PROJECTION_KIND;
  projectionSchemaVersion: typeof PROJECTION_SCHEMA_VERSION;
}

interface PreparedState {
  body: OwnedBytes;
  destroyed: boolean;
  sourceRequestSha256: string;
}

interface NormalizedBinding {
  environment: RenaveEnvironment;
  establishmentId: string;
  generation: number;
  kind: "USED_STOCK_ENTRY";
  mutationFamily: "STOCK_ENTRY";
  operationId: string;
  requestSchemaVersion: number;
  sourceRequestSha256: string;
  tenantId: string;
}

interface CipherState {
  activeKeyId: string;
  destroyed: boolean;
  effectiveKeys: Map<string, Buffer>;
  environment: RenaveEnvironment;
}

interface EnvelopeSnapshot {
  authTag: Buffer;
  ciphertext: Buffer;
  generation: number;
  keyId: string;
  nonce: Buffer;
  projectionByteLength: number;
}

const PREPARED_TOKEN = Symbol("PreparedOperationReconciliationProjection");
const preparedStates = new WeakMap<
  PreparedOperationReconciliationProjection,
  PreparedState
>();
const cipherStates = new WeakMap<
  OperationReconciliationProjectionCipher,
  CipherState
>();

export class OperationReconciliationProjectionInputError extends Error {
  override name = "OperationReconciliationProjectionInputError";

  constructor() {
    super("A projeção de reconciliação contém dados inválidos.");
  }
}

export class OperationReconciliationProjectionConfigurationError extends Error {
  override name = "OperationReconciliationProjectionConfigurationError";

  constructor() {
    super("A criptografia da projeção de reconciliação está indisponível.");
  }
}

export class OperationReconciliationProjectionDecryptionError extends Error {
  override name = "OperationReconciliationProjectionDecryptionError";

  constructor() {
    super("A projeção de reconciliação não pôde ser autenticada.");
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error("json");
    return value;
  }

  private space(): void {
    while (" \t\r\n".includes(this.source[this.index] ?? "\0")) {
      this.index += 1;
    }
  }

  private value(): unknown {
    this.space();
    const character = this.source[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.source.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    return this.number();
  }

  private object(): JsonObject {
    this.index += 1;
    const result = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    this.space();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.space();
      if (this.source[this.index] !== '"') throw new Error("json");
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate");
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ":") throw new Error("json");
      this.index += 1;
      result[key] = this.value();
      this.space();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") throw new Error("json");
      this.index += 1;
    }
  }

  private array(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value());
      this.space();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") throw new Error("json");
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      this.index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
    }
    throw new Error("json");
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new Error("json");
    this.index += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) throw new Error("json");
    return result;
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new StrictJsonParser(text).parse();
  } catch {
    throw new OperationReconciliationProjectionInputError();
  }
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationReconciliationProjectionInputError();
  }
  return value as JsonObject;
}

function exactKeys(
  candidate: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(candidate);
  if (
    required.some((key) => !Object.hasOwn(candidate, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OperationReconciliationProjectionInputError();
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OperationReconciliationProjectionInputError();
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isOffsetDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match || !isCalendarDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] === "Z") return true;
  const offsetHour = Number(match[7]);
  const offsetMinute = Number(match[8]);
  return (
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour !== 14 || offsetMinute === 0)
  );
}

function optionalIdentifier(value: unknown, pattern: RegExp): string {
  const result = requiredString(value);
  if (!pattern.test(result)) {
    throw new OperationReconciliationProjectionInputError();
  }
  return result;
}

function projectionFromRequest(
  value: unknown,
): StockEntryReconciliationProjectionV1 {
  const request = object(value);
  exactKeys(request, [
    "cpfOperadorResponsavel",
    "dataCompra",
    "emailEstabelecimento",
    "emailVendedor",
    "valorCompra",
    "veiculo",
  ]);
  const cpfSource = requiredString(request["cpfOperadorResponsavel"]);
  if (!CPF_SOURCE_PATTERN.test(cpfSource)) {
    throw new OperationReconciliationProjectionInputError();
  }
  const cpf = cpfSource.replace(/\D/gu, "");
  if (!CPF_PATTERN.test(cpf)) {
    throw new OperationReconciliationProjectionInputError();
  }
  const purchaseDate = requiredString(request["dataCompra"]);
  const establishmentEmail = requiredString(request["emailEstabelecimento"]);
  const sellerEmail = requiredString(request["emailVendedor"]);
  const purchaseValue = finiteNumber(request["valorCompra"]);
  if (
    !isCalendarDate(purchaseDate) ||
    !EMAIL_PATTERN.test(establishmentEmail) ||
    !EMAIL_PATTERN.test(sellerEmail) ||
    purchaseValue < 0 ||
    purchaseValue > MAX_PURCHASE_VALUE
  ) {
    throw new OperationReconciliationProjectionInputError();
  }

  const vehicle = object(request["veiculo"]);
  exactKeys(
    vehicle,
    [
      "codigoSegurancaCrv",
      "dataHoraMedicaoHodometro",
      "documentoProprietarioAtual",
      "placa",
      "quilometragemHodometro",
      "tipoCrv",
      "tipoDocumentoProprietarioAtual",
    ],
    ["numeroCrv", "renavam"],
  );
  const plate = requiredString(vehicle["placa"]);
  if (!BRAZILIAN_PLATE_PATTERN.test(plate)) {
    throw new OperationReconciliationProjectionInputError();
  }
  const securityCode = optionalIdentifier(
    vehicle["codigoSegurancaCrv"],
    SECURITY_CODE_PATTERN,
  );
  const crvType = requiredString(vehicle["tipoCrv"]);
  if (!CRV_TYPES.has(crvType as CrvType)) {
    throw new OperationReconciliationProjectionInputError();
  }
  const odometerDateTime = requiredString(vehicle["dataHoraMedicaoHodometro"]);
  const ownerDocument = requiredString(vehicle["documentoProprietarioAtual"]);
  const odometer = finiteNumber(vehicle["quilometragemHodometro"]);
  const ownerDocumentType = requiredString(
    vehicle["tipoDocumentoProprietarioAtual"],
  );
  if (
    !isOffsetDateTime(odometerDateTime) ||
    !Number.isInteger(odometer) ||
    odometer < 0 ||
    odometer > MAX_INT32 ||
    (ownerDocumentType !== "CPF" && ownerDocumentType !== "CNPJ") ||
    (ownerDocumentType === "CPF" && !CPF_PATTERN.test(ownerDocument)) ||
    (ownerDocumentType === "CNPJ" && !CNPJ_PATTERN.test(ownerDocument))
  ) {
    throw new OperationReconciliationProjectionInputError();
  }

  const optional = {
    ...(Object.hasOwn(vehicle, "renavam")
      ? { renavam: optionalIdentifier(vehicle["renavam"], RENAVAM_PATTERN) }
      : {}),
    ...(Object.hasOwn(vehicle, "numeroCrv")
      ? {
          numeroCrv: optionalIdentifier(
            vehicle["numeroCrv"],
            CRV_NUMBER_PATTERN,
          ),
        }
      : {}),
  };
  return Object.freeze({
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    cpfOperadorResponsavel: cpf,
    veiculo: Object.freeze({
      codigoSegurancaCrv: securityCode,
      placa: plate,
      tipoCrv: crvType as CrvType,
      ...optional,
    }),
  });
}

function validateProjection(
  value: unknown,
): StockEntryReconciliationProjectionV1 {
  const projection = object(value);
  exactKeys(projection, ["schemaVersion", "cpfOperadorResponsavel", "veiculo"]);
  if (
    projection["schemaVersion"] !== PROJECTION_SCHEMA_VERSION ||
    typeof projection["cpfOperadorResponsavel"] !== "string" ||
    !/^\d{11}$/u.test(projection["cpfOperadorResponsavel"])
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  const vehicle = object(projection["veiculo"]);
  exactKeys(
    vehicle,
    ["codigoSegurancaCrv", "placa", "tipoCrv"],
    ["renavam", "numeroCrv"],
  );
  const code = requiredString(vehicle["codigoSegurancaCrv"]);
  const plate = requiredString(vehicle["placa"]);
  const crvType = requiredString(vehicle["tipoCrv"]);
  if (
    !SECURITY_CODE_PATTERN.test(code) ||
    !BRAZILIAN_PLATE_PATTERN.test(plate) ||
    !CRV_TYPES.has(crvType as CrvType)
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  const optional = {
    ...(Object.hasOwn(vehicle, "renavam")
      ? { renavam: optionalIdentifier(vehicle["renavam"], RENAVAM_PATTERN) }
      : {}),
    ...(Object.hasOwn(vehicle, "numeroCrv")
      ? {
          numeroCrv: optionalIdentifier(
            vehicle["numeroCrv"],
            CRV_NUMBER_PATTERN,
          ),
        }
      : {}),
  };
  return Object.freeze({
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    cpfOperadorResponsavel: projection["cpfOperadorResponsavel"],
    veiculo: Object.freeze({
      codigoSegurancaCrv: code,
      placa: plate,
      tipoCrv: crvType as CrvType,
      ...optional,
    }),
  });
}

function canonicalBytes(
  projection: StockEntryReconciliationProjectionV1,
): OwnedBytes {
  const encoded = new TextEncoder().encode(JSON.stringify(projection));
  if (
    !isOperationReconciliationProjectionByteLengthAllowed(encoded.byteLength)
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  return encoded;
}

/** @internal Fronteira testável; não é reexportada pelo entrypoint do pacote. */
export function isOperationReconciliationProjectionByteLengthAllowed(
  byteLength: unknown,
): byteLength is number {
  return (
    typeof byteLength === "number" &&
    Number.isInteger(byteLength) &&
    byteLength >= 1 &&
    byteLength <= MAX_PROJECTION_BYTES
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function preparedState(
  prepared: PreparedOperationReconciliationProjection,
): PreparedState {
  const state = preparedStates.get(prepared);
  if (!state || state.destroyed) {
    throw new OperationReconciliationProjectionInputError();
  }
  return state;
}

let createPreparedProjection: (
  body: OwnedBytes,
  sourceRequestSha256: string,
) => PreparedOperationReconciliationProjection;

export class PreparedOperationReconciliationProjection {
  private constructor(token: symbol, state: PreparedState) {
    if (token !== PREPARED_TOKEN) {
      throw new OperationReconciliationProjectionInputError();
    }
    preparedStates.set(this, state);
    Object.freeze(this);
  }

  static {
    createPreparedProjection = (body, sourceRequestSha256) =>
      new PreparedOperationReconciliationProjection(PREPARED_TOKEN, {
        body,
        destroyed: false,
        sourceRequestSha256,
      });
  }

  get byteLength(): number {
    return preparedState(this).body.byteLength;
  }

  get projectionKind(): typeof PROJECTION_KIND {
    preparedState(this);
    return PROJECTION_KIND;
  }

  get schemaVersion(): typeof PROJECTION_SCHEMA_VERSION {
    preparedState(this);
    return PROJECTION_SCHEMA_VERSION;
  }

  copyBodyBytes(): OwnedBytes {
    const body = preparedState(this).body;
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    return copy;
  }

  consumeBodyBytes(): OwnedBytes {
    const copy = this.copyBodyBytes();
    this.destroy();
    return copy;
  }

  destroy(): void {
    const state = preparedStates.get(this);
    if (!state) throw new OperationReconciliationProjectionInputError();
    if (state.destroyed) return;
    state.body.fill(0);
    state.sourceRequestSha256 = "";
    state.destroyed = true;
  }
}

export function prepareOperationReconciliationProjection(
  source: PreparedRenaveMutation,
): PreparedOperationReconciliationProjection {
  let sourceBytes: OwnedBytes | undefined;
  try {
    const snapshot = readPreparedRenaveMutation(source);
    sourceBytes = snapshot.body;
    if (
      snapshot.operation !== "request-stock-entry" ||
      !SHA256_PATTERN.test(snapshot.requestSha256)
    ) {
      throw new OperationReconciliationProjectionInputError();
    }
    const projection = projectionFromRequest(parseJson(sourceBytes));
    return createPreparedProjection(
      canonicalBytes(projection),
      snapshot.requestSha256,
    );
  } catch {
    throw new OperationReconciliationProjectionInputError();
  } finally {
    sourceBytes?.fill(0);
  }
}

export function restoreOperationReconciliationProjection(
  source: Uint8Array,
  sourceRequestSha256: string,
): PreparedOperationReconciliationProjection {
  if (
    !(source instanceof Uint8Array) ||
    !isOperationReconciliationProjectionByteLengthAllowed(source.byteLength) ||
    !SHA256_PATTERN.test(sourceRequestSha256)
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  try {
    const projection = validateProjection(parseJson(copy));
    const canonical = canonicalBytes(projection);
    try {
      if (!bytesEqual(copy, canonical)) {
        throw new OperationReconciliationProjectionInputError();
      }
    } finally {
      canonical.fill(0);
    }
    return createPreparedProjection(copy, sourceRequestSha256);
  } catch {
    copy.fill(0);
    throw new OperationReconciliationProjectionInputError();
  }
}

function normalizeBinding(
  binding: OperationReconciliationProjectionBinding,
): NormalizedBinding {
  let environment: unknown;
  let establishmentId: unknown;
  let generation: unknown;
  let kind: unknown;
  let mutationFamily: unknown;
  let operationId: unknown;
  let requestSchemaVersion: unknown;
  let sourceRequestSha256: unknown;
  let tenantId: unknown;
  try {
    environment = binding.environment;
    establishmentId = binding.establishmentId;
    generation = binding.generation;
    kind = binding.kind;
    mutationFamily = binding.mutationFamily;
    operationId = binding.operationId;
    requestSchemaVersion = binding.requestSchemaVersion;
    sourceRequestSha256 = binding.sourceRequestSha256;
    tenantId = binding.tenantId;
  } catch {
    throw new OperationReconciliationProjectionInputError();
  }
  if (
    !binding ||
    (environment !== "homologation" && environment !== "production") ||
    typeof tenantId !== "string" ||
    !UUID_PATTERN.test(tenantId) ||
    typeof operationId !== "string" ||
    !UUID_PATTERN.test(operationId) ||
    typeof establishmentId !== "string" ||
    !UUID_PATTERN.test(establishmentId) ||
    kind !== "USED_STOCK_ENTRY" ||
    mutationFamily !== "STOCK_ENTRY" ||
    requestSchemaVersion !== 1 ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    typeof sourceRequestSha256 !== "string" ||
    !SHA256_PATTERN.test(sourceRequestSha256)
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  return {
    environment,
    establishmentId: establishmentId.toLowerCase(),
    generation: generation as number,
    kind,
    mutationFamily,
    operationId: operationId.toLowerCase(),
    requestSchemaVersion,
    sourceRequestSha256,
    tenantId: tenantId.toLowerCase(),
  };
}

function aad(
  binding: NormalizedBinding,
  keyId: string,
  byteLength: number,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      PURPOSE,
      PROJECTION_SCHEMA_VERSION,
      binding.environment,
      keyId,
      binding.tenantId,
      binding.operationId,
      binding.establishmentId,
      binding.kind,
      binding.mutationFamily,
      binding.requestSchemaVersion,
      PROJECTION_KIND,
      PROJECTION_SCHEMA_VERSION,
      binding.generation,
      binding.sourceRequestSha256,
      byteLength,
    ]),
    "utf8",
  );
}

function deriveEffectiveKey(
  master: Buffer,
  environment: RenaveEnvironment,
  keyId: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      HKDF_SALT,
      Buffer.from(JSON.stringify([PURPOSE, environment, keyId]), "utf8"),
      KEY_BYTES,
    ),
  );
}

function cipherState(
  cipher: OperationReconciliationProjectionCipher,
): CipherState {
  const state = cipherStates.get(cipher);
  if (!state || state.destroyed) {
    throw new OperationReconciliationProjectionConfigurationError();
  }
  return state;
}

function encryptProjectionWithState(
  state: CipherState,
  prepared: PreparedOperationReconciliationProjection,
  binding: OperationReconciliationProjectionBinding,
): EncryptedOperationReconciliationProjection {
  const normalized = normalizeBinding(binding);
  const preparedProjection = preparedState(prepared);
  if (
    normalized.environment !== state.environment ||
    normalized.sourceRequestSha256 !== preparedProjection.sourceRequestSha256
  ) {
    throw new OperationReconciliationProjectionInputError();
  }
  const body = new Uint8Array(preparedProjection.body.byteLength);
  body.set(preparedProjection.body);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(
      "aes-256-gcm",
      state.effectiveKeys.get(state.activeKeyId)!,
      nonce,
      { authTagLength: TAG_BYTES },
    );
    cipher.setAAD(aad(normalized, state.activeKeyId, body.byteLength));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return {
      authTag: Buffer.from(cipher.getAuthTag()),
      ciphertext: Buffer.from(ciphertext),
      generation: normalized.generation,
      keyId: state.activeKeyId,
      nonce: Buffer.from(nonce),
      projectionByteLength: body.byteLength,
      projectionKind: PROJECTION_KIND,
      projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    };
  } finally {
    body.fill(0);
  }
}

/**
 * Cifra uma projeção usando somente o estado nominal mantido pelo pacote.
 * Não despacha para métodos sobrescrevíveis do objeto recebido.
 */
export function encryptOperationReconciliationProjection(
  cipher: OperationReconciliationProjectionCipher,
  prepared: PreparedOperationReconciliationProjection,
  binding: OperationReconciliationProjectionBinding,
): EncryptedOperationReconciliationProjection {
  return encryptProjectionWithState(cipherState(cipher), prepared, binding);
}

function snapshotEnvelope(
  payload: EncryptedOperationReconciliationProjection,
): EnvelopeSnapshot {
  let authTag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let generation: unknown;
  let keyId: unknown;
  let nonce: Buffer | undefined;
  let projectionByteLength: unknown;
  let projectionKind: unknown;
  let projectionSchemaVersion: unknown;
  try {
    const rawAuthTag = payload.authTag;
    if (
      !(rawAuthTag instanceof Uint8Array) ||
      rawAuthTag.byteLength !== TAG_BYTES
    ) {
      throw new OperationReconciliationProjectionDecryptionError();
    }
    authTag = Buffer.from(rawAuthTag);
    const rawNonce = payload.nonce;
    if (
      !(rawNonce instanceof Uint8Array) ||
      rawNonce.byteLength !== NONCE_BYTES
    ) {
      throw new OperationReconciliationProjectionDecryptionError();
    }
    nonce = Buffer.from(rawNonce);
    const rawCiphertext = payload.ciphertext;
    if (!(rawCiphertext instanceof Uint8Array)) {
      throw new OperationReconciliationProjectionDecryptionError();
    }
    ciphertext = Buffer.from(rawCiphertext);
    generation = payload.generation;
    keyId = payload.keyId;
    projectionByteLength = payload.projectionByteLength;
    projectionKind = payload.projectionKind;
    projectionSchemaVersion = payload.projectionSchemaVersion;
  } catch {
    authTag?.fill(0);
    ciphertext?.fill(0);
    nonce?.fill(0);
    throw new OperationReconciliationProjectionDecryptionError();
  }
  if (
    !payload ||
    !authTag ||
    !ciphertext ||
    !nonce ||
    projectionKind !== PROJECTION_KIND ||
    projectionSchemaVersion !== PROJECTION_SCHEMA_VERSION ||
    typeof keyId !== "string" ||
    !KEY_ID_PATTERN.test(keyId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !isOperationReconciliationProjectionByteLengthAllowed(
      projectionByteLength,
    ) ||
    ciphertext.byteLength !== projectionByteLength
  ) {
    authTag.fill(0);
    ciphertext.fill(0);
    nonce.fill(0);
    throw new OperationReconciliationProjectionDecryptionError();
  }
  return {
    authTag,
    ciphertext,
    generation,
    keyId,
    nonce,
    projectionByteLength,
  };
}

function decryptProjectionWithState(
  state: CipherState,
  payload: EncryptedOperationReconciliationProjection,
  binding: OperationReconciliationProjectionBinding,
): PreparedOperationReconciliationProjection {
  try {
    const normalized = normalizeBinding(binding);
    const envelope = snapshotEnvelope(payload);
    if (
      normalized.environment !== state.environment ||
      envelope.generation !== normalized.generation
    ) {
      envelope.nonce.fill(0);
      envelope.authTag.fill(0);
      envelope.ciphertext.fill(0);
      throw new OperationReconciliationProjectionDecryptionError();
    }
    const key = state.effectiveKeys.get(envelope.keyId);
    if (!key) {
      envelope.nonce.fill(0);
      envelope.authTag.fill(0);
      envelope.ciphertext.fill(0);
      throw new OperationReconciliationProjectionDecryptionError();
    }
    const chunks: Buffer[] = [];
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(
        aad(normalized, envelope.keyId, envelope.projectionByteLength),
      );
      decipher.setAuthTag(envelope.authTag);
      chunks.push(decipher.update(envelope.ciphertext));
      chunks.push(decipher.final());
      plaintext = Buffer.concat(chunks);
      return restoreOperationReconciliationProjection(
        plaintext,
        normalized.sourceRequestSha256,
      );
    } finally {
      envelope.nonce.fill(0);
      envelope.authTag.fill(0);
      envelope.ciphertext.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      plaintext?.fill(0);
    }
  } catch {
    throw new OperationReconciliationProjectionDecryptionError();
  }
}

/**
 * Autentica e lê somente o DTO mínimo da projeção pelo estado nominal do
 * pacote. Nenhum método sobrescrevível do cipher recebido é executado.
 */
export function decryptOperationReconciliationProjection(
  cipher: OperationReconciliationProjectionCipher,
  payload: EncryptedOperationReconciliationProjection,
  binding: OperationReconciliationProjectionBinding,
): StockEntryReconciliationProjectionV1 {
  const state = cipherState(cipher);
  let prepared: PreparedOperationReconciliationProjection | undefined;
  let plaintext: OwnedBytes | undefined;
  try {
    prepared = decryptProjectionWithState(state, payload, binding);
    plaintext = prepared.copyBodyBytes();
    return validateProjection(parseJson(plaintext));
  } catch (error) {
    if (error instanceof OperationReconciliationProjectionConfigurationError) {
      throw error;
    }
    throw new OperationReconciliationProjectionDecryptionError();
  } finally {
    plaintext?.fill(0);
    prepared?.destroy();
  }
}

/** Consulta nominal usada para tratar rotação ausente sem tentar decriptar. */
export function hasOperationReconciliationProjectionKey(
  cipher: OperationReconciliationProjectionCipher,
  keyId: string,
): boolean {
  const state = cipherState(cipher);
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) return false;
  return state.effectiveKeys.has(keyId);
}

export class OperationReconciliationProjectionCipher {
  constructor(config: {
    activeKeyId: string;
    environment: RenaveEnvironment;
    masterKeys: ReadonlyMap<string, Uint8Array>;
  }) {
    if (new.target !== OperationReconciliationProjectionCipher) {
      throw new OperationReconciliationProjectionConfigurationError();
    }
    const effectiveKeys = new Map<string, Buffer>();
    const masters: Buffer[] = [];
    try {
      let activeKeyId: unknown;
      let environment: unknown;
      let masterKeys: unknown;
      try {
        activeKeyId = config.activeKeyId;
        environment = config.environment;
        masterKeys = config.masterKeys;
      } catch {
        throw new OperationReconciliationProjectionConfigurationError();
      }
      if (
        !config ||
        typeof activeKeyId !== "string" ||
        !KEY_ID_PATTERN.test(activeKeyId) ||
        (environment !== "homologation" && environment !== "production") ||
        !(masterKeys instanceof Map) ||
        Object.getPrototypeOf(masterKeys) !== Map.prototype ||
        masterKeys.size === 0
      ) {
        throw new OperationReconciliationProjectionConfigurationError();
      }
      const entries = Array.from(masterKeys.entries()) as Array<
        [unknown, unknown]
      >;
      for (const [keyId, source] of entries) {
        if (
          typeof keyId !== "string" ||
          !KEY_ID_PATTERN.test(keyId) ||
          !(source instanceof Uint8Array) ||
          source.byteLength !== KEY_BYTES
        ) {
          throw new OperationReconciliationProjectionConfigurationError();
        }
        const master = Buffer.from(source);
        if (masters.some((candidate) => timingSafeEqual(candidate, master))) {
          master.fill(0);
          throw new OperationReconciliationProjectionConfigurationError();
        }
        masters.push(master);
        effectiveKeys.set(
          keyId,
          deriveEffectiveKey(master, environment, keyId),
        );
      }
      if (!effectiveKeys.has(activeKeyId)) {
        throw new OperationReconciliationProjectionConfigurationError();
      }
      cipherStates.set(this, {
        activeKeyId,
        destroyed: false,
        effectiveKeys,
        environment,
      });
      Object.freeze(this);
    } catch {
      for (const key of effectiveKeys.values()) key.fill(0);
      effectiveKeys.clear();
      throw new OperationReconciliationProjectionConfigurationError();
    } finally {
      for (const master of masters) master.fill(0);
    }
  }

  encrypt(
    prepared: PreparedOperationReconciliationProjection,
    binding: OperationReconciliationProjectionBinding,
  ): EncryptedOperationReconciliationProjection {
    return encryptProjectionWithState(cipherState(this), prepared, binding);
  }

  decrypt(
    payload: EncryptedOperationReconciliationProjection,
    binding: OperationReconciliationProjectionBinding,
  ): PreparedOperationReconciliationProjection {
    return decryptProjectionWithState(cipherState(this), payload, binding);
  }

  destroy(): void {
    const state = cipherStates.get(this);
    if (!state) {
      throw new OperationReconciliationProjectionConfigurationError();
    }
    if (state.destroyed) return;
    for (const key of state.effectiveKeys.values()) key.fill(0);
    state.effectiveKeys.clear();
    state.destroyed = true;
  }
}

Object.freeze(PreparedOperationReconciliationProjection.prototype);
Object.freeze(PreparedOperationReconciliationProjection);
Object.freeze(OperationReconciliationProjectionCipher.prototype);
Object.freeze(OperationReconciliationProjectionCipher);
