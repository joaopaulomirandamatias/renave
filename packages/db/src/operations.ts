import type { TenantClient } from "./tenant-context.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_CIPHERTEXT_BYTES = 1_048_576;
const MAX_SCHEMA_VERSION = 2_147_483_647;

export const operationKinds = ["USED_STOCK_ENTRY"] as const;
export const operationMutationFamilies = ["STOCK_ENTRY"] as const;
export const operationStatuses = [
  "HELD_LOCAL",
  "PENDING_SEND",
  "SENT",
  "REJECTED",
  "PENDING_RECONCILIATION",
  "CONFIRMED",
  "MANUAL_REVIEW",
] as const;

export type OperationKind = (typeof operationKinds)[number];
export type OperationMutationFamily =
  (typeof operationMutationFamilies)[number];
export type OperationStatus = (typeof operationStatuses)[number];

export interface OperationRecord {
  correlationId: string;
  createdAt: Date;
  establishmentId: string;
  id: string;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  status: OperationStatus;
  updatedAt: Date;
  version: string;
}

export interface CreateOperationInput {
  actorSubjectHash: Buffer;
  correlationId: string;
  establishmentId: string;
  idempotencyKeyDigest: Buffer;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  operationId: string;
  reconciliationProjectionAuthTag: Buffer;
  reconciliationProjectionByteLength: number;
  reconciliationProjectionCiphertext: Buffer;
  reconciliationProjectionGeneration: number;
  reconciliationProjectionKeyId: string;
  reconciliationProjectionKind: "STOCK_ENTRY_RECONCILIATION";
  reconciliationProjectionNonce: Buffer;
  reconciliationProjectionSchemaVersion: 1;
  requestAuthTag: Buffer;
  requestCiphertext: Buffer;
  requestKeyId: string;
  requestNonce: Buffer;
  requestSchemaVersion: number;
  requestSha256: Buffer;
  vehicleKeyDigest: Buffer;
}

export interface CreateHeldLocalOperationInput extends CreateOperationInput {
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  subject: string;
}

export interface CreateOperationResult {
  operation: OperationRecord;
  replayed: boolean;
}

export class OperationInputError extends Error {
  override name = "OperationInputError";

  constructor() {
    super("A operação contém dados inválidos.");
  }
}

export class OperationIdempotencyConflictError extends Error {
  override name = "OperationIdempotencyConflictError";

  constructor() {
    super("A chave de idempotência já foi usada por outra solicitação.");
  }
}

export class OperationActiveConflictError extends Error {
  override name = "OperationActiveConflictError";

  constructor() {
    super("Já existe uma operação ativa para o veículo.");
  }
}

export class OperationIdentifierConflictError extends Error {
  override name = "OperationIdentifierConflictError";

  constructor() {
    super("O identificador da operação já está em uso.");
  }
}

export class OperationCredentialLinkNotEnabledError extends Error {
  override name = "OperationCredentialLinkNotEnabledError";

  constructor() {
    super("O vínculo de credencial do estabelecimento não está habilitado.");
  }
}

export class OperationStorageError extends Error {
  override name = "OperationStorageError";

  constructor() {
    super("A operação não pôde ser persistida.");
  }
}

interface CreateOperationRow {
  operation_id: string;
  replayed: boolean;
}

interface OperationRow {
  correlation_id: string;
  created_at: Date;
  establishment_id: string;
  kind: string;
  mutation_family: string;
  operation_id: string;
  status: string;
  updated_at: Date;
  version: string;
}

interface NormalizedOperationInput {
  actorSubjectHash: Buffer;
  correlationId: string;
  establishmentId: string;
  idempotencyKeyDigest: Buffer;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  operationId: string;
  subject?: string;
  operatorProfileId?: string;
  operatorProfileVersion?: string;
  establishmentProfileId?: string;
  establishmentProfileVersion?: string;
  reconciliationProjectionAuthTag: Buffer;
  reconciliationProjectionByteLength: number;
  reconciliationProjectionCiphertext: Buffer;
  reconciliationProjectionGeneration: number;
  reconciliationProjectionKeyId: string;
  reconciliationProjectionKind: "STOCK_ENTRY_RECONCILIATION";
  reconciliationProjectionNonce: Buffer;
  reconciliationProjectionSchemaVersion: 1;
  requestAuthTag: Buffer;
  requestCiphertext: Buffer;
  requestKeyId: string;
  requestNonce: Buffer;
  requestSchemaVersion: number;
  requestSha256: Buffer;
  vehicleKeyDigest: Buffer;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function copyBuffer(value: unknown, expectedSize?: number): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    (expectedSize === undefined
      ? value.byteLength < 1 || value.byteLength > MAX_CIPHERTEXT_BYTES
      : value.byteLength !== expectedSize)
  ) {
    throw new OperationInputError();
  }
  return Buffer.from(value);
}

function copyProjectionCiphertext(value: unknown): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength < 1 ||
    value.byteLength > 4096
  ) {
    throw new OperationInputError();
  }
  return Buffer.from(value);
}

function normalizeInput(
  input: CreateOperationInput | CreateHeldLocalOperationInput,
): NormalizedOperationInput {
  const heldLocal = "subject" in input ? input : undefined;
  if (
    !input ||
    !isUuid(input.operationId) ||
    !isUuid(input.establishmentId) ||
    !isUuid(input.correlationId) ||
    input.kind !== "USED_STOCK_ENTRY" ||
    input.mutationFamily !== "STOCK_ENTRY" ||
    !Number.isInteger(input.requestSchemaVersion) ||
    input.requestSchemaVersion < 1 ||
    input.requestSchemaVersion > MAX_SCHEMA_VERSION ||
    typeof input.requestKeyId !== "string" ||
    !KEY_ID_PATTERN.test(input.requestKeyId) ||
    input.reconciliationProjectionKind !== "STOCK_ENTRY_RECONCILIATION" ||
    input.reconciliationProjectionSchemaVersion !== 1 ||
    input.reconciliationProjectionGeneration !== 1 ||
    !Number.isInteger(input.reconciliationProjectionByteLength) ||
    input.reconciliationProjectionByteLength < 1 ||
    input.reconciliationProjectionByteLength > 4096 ||
    !Buffer.isBuffer(input.reconciliationProjectionCiphertext) ||
    input.reconciliationProjectionCiphertext.byteLength !==
      input.reconciliationProjectionByteLength ||
    typeof input.reconciliationProjectionKeyId !== "string" ||
    !KEY_ID_PATTERN.test(input.reconciliationProjectionKeyId)
  ) {
    throw new OperationInputError();
  }

  return {
    actorSubjectHash: copyBuffer(input.actorSubjectHash, 32),
    correlationId: input.correlationId.toLowerCase(),
    establishmentId: input.establishmentId.toLowerCase(),
    idempotencyKeyDigest: copyBuffer(input.idempotencyKeyDigest, 32),
    kind: input.kind,
    mutationFamily: input.mutationFamily,
    operationId: input.operationId.toLowerCase(),
    ...(heldLocal?.subject === undefined ? {} : { subject: heldLocal.subject }),
    ...(heldLocal?.operatorProfileId === undefined
      ? {}
      : { operatorProfileId: heldLocal.operatorProfileId.toLowerCase() }),
    ...(heldLocal?.operatorProfileVersion === undefined
      ? {}
      : { operatorProfileVersion: heldLocal.operatorProfileVersion }),
    ...(heldLocal?.establishmentProfileId === undefined
      ? {}
      : {
          establishmentProfileId:
            heldLocal.establishmentProfileId.toLowerCase(),
        }),
    ...(heldLocal?.establishmentProfileVersion === undefined
      ? {}
      : { establishmentProfileVersion: heldLocal.establishmentProfileVersion }),
    reconciliationProjectionAuthTag: copyBuffer(
      input.reconciliationProjectionAuthTag,
      16,
    ),
    reconciliationProjectionByteLength:
      input.reconciliationProjectionByteLength,
    reconciliationProjectionCiphertext: copyProjectionCiphertext(
      input.reconciliationProjectionCiphertext,
    ),
    reconciliationProjectionGeneration:
      input.reconciliationProjectionGeneration,
    reconciliationProjectionKeyId: input.reconciliationProjectionKeyId,
    reconciliationProjectionKind: input.reconciliationProjectionKind,
    reconciliationProjectionNonce: copyBuffer(
      input.reconciliationProjectionNonce,
      12,
    ),
    reconciliationProjectionSchemaVersion:
      input.reconciliationProjectionSchemaVersion,
    requestAuthTag: copyBuffer(input.requestAuthTag, 16),
    requestCiphertext: copyBuffer(input.requestCiphertext),
    requestKeyId: input.requestKeyId,
    requestNonce: copyBuffer(input.requestNonce, 12),
    requestSchemaVersion: input.requestSchemaVersion,
    requestSha256: copyBuffer(input.requestSha256, 32),
    vehicleKeyDigest: copyBuffer(input.vehicleKeyDigest, 32),
  };
}

function databaseMessage(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapCreateError(error: unknown): never {
  const message = databaseMessage(error);
  const code = databaseCode(error);
  if (code === "23000" && message === "operation: conflito de idempotência") {
    throw new OperationIdempotencyConflictError();
  }
  if (code === "23000" && message === "operation: mutação ativa conflitante") {
    throw new OperationActiveConflictError();
  }
  if (code === "23000" && message === "operation: identificador já utilizado") {
    throw new OperationIdentifierConflictError();
  }
  if (
    code === "55000" &&
    (message === "operation: vínculo credencial não habilitado" ||
      message === "operation: escopo credencial não habilitado" ||
      message === "operation: jurisdição regulatória não verificada" ||
      message === "operation: autorização indisponível" ||
      message === "operation: selo regulatório ausente ou obsoleto")
  ) {
    throw new OperationCredentialLinkNotEnabledError();
  }
  throw new OperationStorageError();
}

function isOperationKind(value: string): value is OperationKind {
  return operationKinds.some((candidate) => candidate === value);
}

function isMutationFamily(value: string): value is OperationMutationFamily {
  return operationMutationFamilies.some((candidate) => candidate === value);
}

function isOperationStatus(value: string): value is OperationStatus {
  return operationStatuses.some((candidate) => candidate === value);
}

function toOperation(row: OperationRow): OperationRecord {
  if (
    !isUuid(row.operation_id) ||
    !isUuid(row.establishment_id) ||
    !isUuid(row.correlation_id) ||
    !isOperationKind(row.kind) ||
    !isMutationFamily(row.mutation_family) ||
    !isOperationStatus(row.status) ||
    !/^[1-9][0-9]*$/u.test(row.version) ||
    !(row.created_at instanceof Date) ||
    !Number.isFinite(row.created_at.getTime()) ||
    !(row.updated_at instanceof Date) ||
    !Number.isFinite(row.updated_at.getTime())
  ) {
    throw new OperationStorageError();
  }
  return {
    correlationId: row.correlation_id,
    createdAt: new Date(row.created_at),
    establishmentId: row.establishment_id,
    id: row.operation_id,
    kind: row.kind,
    mutationFamily: row.mutation_family,
    status: row.status,
    updatedAt: new Date(row.updated_at),
    version: row.version,
  };
}

export async function getOperation(
  client: TenantClient,
  operationId: string,
): Promise<OperationRecord | null> {
  if (!isUuid(operationId)) throw new OperationInputError();
  try {
    const { rows } = await client.query<OperationRow>(
      "select * from renave.get_operation_summary($1)",
      [operationId.toLowerCase()],
    );
    return rows[0] ? toOperation(rows[0]) : null;
  } catch (error) {
    if (error instanceof OperationStorageError) throw error;
    throw new OperationStorageError();
  }
}

async function createOrReplayUsing(
  client: TenantClient,
  input: CreateOperationInput | CreateHeldLocalOperationInput,
  functionName: "create_held_local_operation" | "create_operation_with_outbox",
): Promise<CreateOperationResult> {
  const operation = normalizeInput(input);
  let created: CreateOperationRow | undefined;
  const heldLocal = functionName === "create_held_local_operation";
  if (
    heldLocal &&
    (typeof operation.subject !== "string" ||
      operation.subject.trim() !== operation.subject ||
      operation.subject.length < 1 ||
      operation.subject.length > 255 ||
      !isUuid(operation.operatorProfileId) ||
      !/^[1-9][0-9]*$/u.test(operation.operatorProfileVersion ?? "") ||
      !isUuid(operation.establishmentProfileId) ||
      !/^[1-9][0-9]*$/u.test(operation.establishmentProfileVersion ?? ""))
  ) {
    throw new OperationInputError();
  }
  try {
    const { rows } = await client.query<CreateOperationRow>(
      `select operation_id, replayed
         from renave.${functionName}(
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23
           ${heldLocal ? ", $24, $25, $26, $27, $28" : ""}
         )`,
      [
        operation.operationId,
        operation.establishmentId,
        operation.kind,
        operation.mutationFamily,
        operation.idempotencyKeyDigest,
        operation.vehicleKeyDigest,
        operation.requestSha256,
        operation.requestCiphertext.byteLength,
        operation.requestSchemaVersion,
        operation.requestKeyId,
        operation.requestNonce,
        operation.requestAuthTag,
        operation.requestCiphertext,
        operation.actorSubjectHash,
        operation.correlationId,
        operation.reconciliationProjectionKind,
        operation.reconciliationProjectionSchemaVersion,
        operation.reconciliationProjectionGeneration,
        operation.reconciliationProjectionByteLength,
        operation.reconciliationProjectionKeyId,
        operation.reconciliationProjectionNonce,
        operation.reconciliationProjectionAuthTag,
        operation.reconciliationProjectionCiphertext,
        ...(heldLocal
          ? [
              operation.subject,
              operation.operatorProfileId,
              operation.operatorProfileVersion,
              operation.establishmentProfileId,
              operation.establishmentProfileVersion,
            ]
          : []),
      ],
    );
    created = rows[0];
  } catch (error) {
    mapCreateError(error);
  }

  if (
    !created ||
    !isUuid(created.operation_id) ||
    typeof created.replayed !== "boolean"
  ) {
    throw new OperationStorageError();
  }
  const record = await getOperation(client, created.operation_id);
  if (!record) throw new OperationStorageError();
  return { operation: record, replayed: created.replayed };
}

export function createOrReplayOperation(
  client: TenantClient,
  input: CreateOperationInput,
): Promise<CreateOperationResult> {
  return createOrReplayUsing(client, input, "create_operation_with_outbox");
}

/**
 * Persiste uma operação local retida. Não cria outbox e não habilita envio;
 * uma futura liberação exigirá um contrato de banco separado.
 */
export function createOrReplayHeldLocalOperation(
  client: TenantClient,
  input: CreateHeldLocalOperationInput,
): Promise<CreateOperationResult> {
  return createOrReplayUsing(client, input, "create_held_local_operation");
}

export class OperationPromotionDeniedError extends Error {
  override name = "OperationPromotionDeniedError";
  constructor() {
    super("A operação local não está autorizada para promoção.");
  }
}

export interface PromoteHeldLocalOperationResult {
  operationId: string;
  operationStatus: "PENDING_SEND";
  outboxId: string;
  promotedAt: Date;
  replayed: boolean;
}

export interface PromoteHeldLocalOperationInput {
  artifactDigest: Buffer;
  authorizationBindingDigest: Buffer;
  changedByDigest: Buffer;
  credentialLinkVersion: string;
  decisionId: string;
  environment: "homologation" | "production";
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  evidenceManifestDigest: Buffer;
  executorWorkloadDigest: Buffer;
  expiresAt: Date;
  issuerKeyId: string;
  issuedAt: Date;
  jurisdictionGeneration: string;
  jurisdictionUf: string;
  logicalDatabaseId: string;
  notBefore: Date;
  operationId: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  policyVersion: string;
  scopeGeneration: string;
  serviceNature: "establishment" | "ite" | "manufacturer";
}

interface PromotionRow {
  operation_id: string;
  operation_status: string;
  outbox_id: string;
  promoted_at: Date;
  replayed: boolean;
}

const OPERATION_PROMOTION_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPERATION_PROMOTION_POLICY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const OPERATION_PROMOTION_UF =
  /^(?:A[CLMP]|BA|CE|DF|ES|GO|MA|M[GS]|P[ABREI]|R[JNSOR]|S[CEP]|TO)$/u;

function positivePgBigint(value: string): boolean {
  try {
    return (
      /^[1-9][0-9]*$/u.test(value) &&
      BigInt(value) <= 9_223_372_036_854_775_807n
    );
  } catch {
    return false;
  }
}

function validPromotionTime(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export async function promoteHeldLocalOperation(
  client: TenantClient,
  input: PromoteHeldLocalOperationInput,
): Promise<PromoteHeldLocalOperationResult> {
  if (
    !input ||
    !isUuid(input.operationId) ||
    !isUuid(input.logicalDatabaseId) ||
    !isUuid(input.decisionId) ||
    !isUuid(input.operatorProfileId) ||
    !isUuid(input.establishmentProfileId) ||
    !["homologation", "production"].includes(input.environment) ||
    !["establishment", "ite", "manufacturer"].includes(input.serviceNature) ||
    !OPERATION_PROMOTION_UF.test(input.jurisdictionUf) ||
    !OPERATION_PROMOTION_KEY_ID.test(input.issuerKeyId) ||
    !OPERATION_PROMOTION_POLICY.test(input.policyVersion) ||
    !positivePgBigint(input.jurisdictionGeneration) ||
    !positivePgBigint(input.scopeGeneration) ||
    !positivePgBigint(input.credentialLinkVersion) ||
    !positivePgBigint(input.operatorProfileVersion) ||
    !positivePgBigint(input.establishmentProfileVersion) ||
    !validPromotionTime(input.issuedAt) ||
    !validPromotionTime(input.notBefore) ||
    !validPromotionTime(input.expiresAt) ||
    input.issuedAt.getTime() > input.notBefore.getTime() ||
    input.notBefore.getTime() >= input.expiresAt.getTime() ||
    input.expiresAt.getTime() - input.issuedAt.getTime() > 86_400_000
  ) {
    throw new OperationInputError();
  }
  const authorizationBindingDigest = copyBuffer(
    input.authorizationBindingDigest,
    32,
  );
  const executorWorkloadDigest = copyBuffer(input.executorWorkloadDigest, 32);
  const artifactDigest = copyBuffer(input.artifactDigest, 32);
  const evidenceManifestDigest = copyBuffer(input.evidenceManifestDigest, 32);
  const changedByDigest = copyBuffer(input.changedByDigest, 32);
  let row: PromotionRow | undefined;
  try {
    const result = await client.query<PromotionRow>(
      `select operation_id,outbox_id,promoted_at,replayed
         ,operation_status
         from renave_promotion.promote_held_local_operation(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23)`,
      [
        input.operationId.toLowerCase(),
        input.environment,
        input.logicalDatabaseId.toLowerCase(),
        input.decisionId.toLowerCase(),
        input.issuedAt,
        input.notBefore,
        input.expiresAt,
        input.issuerKeyId,
        input.policyVersion,
        authorizationBindingDigest,
        executorWorkloadDigest,
        artifactDigest,
        evidenceManifestDigest,
        changedByDigest,
        input.serviceNature,
        input.jurisdictionUf,
        input.jurisdictionGeneration,
        input.scopeGeneration,
        input.credentialLinkVersion,
        input.operatorProfileId.toLowerCase(),
        input.operatorProfileVersion,
        input.establishmentProfileId.toLowerCase(),
        input.establishmentProfileVersion,
      ],
    );
    row = result.rows[0];
  } catch (error) {
    if (
      databaseCode(error) === "55000" &&
      databaseMessage(error) === "operation promotion: indisponível"
    ) {
      throw new OperationPromotionDeniedError();
    }
    throw new OperationStorageError();
  } finally {
    authorizationBindingDigest.fill(0);
    executorWorkloadDigest.fill(0);
    artifactDigest.fill(0);
    evidenceManifestDigest.fill(0);
    changedByDigest.fill(0);
  }
  if (
    !row ||
    !isUuid(row.operation_id) ||
    !isUuid(row.outbox_id) ||
    row.operation_status !== "PENDING_SEND" ||
    typeof row.replayed !== "boolean" ||
    !(row.promoted_at instanceof Date) ||
    !Number.isFinite(row.promoted_at.getTime())
  ) {
    throw new OperationStorageError();
  }
  return {
    operationId: row.operation_id,
    operationStatus: "PENDING_SEND",
    outboxId: row.outbox_id,
    promotedAt: new Date(row.promoted_at),
    replayed: row.replayed,
  };
}
