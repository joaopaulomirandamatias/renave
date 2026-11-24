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

function normalizeInput(input: CreateOperationInput): NormalizedOperationInput {
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
      message === "operation: jurisdição regulatória não verificada")
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
  input: CreateOperationInput,
  functionName: "create_held_local_operation" | "create_operation_with_outbox",
): Promise<CreateOperationResult> {
  const operation = normalizeInput(input);
  let created: CreateOperationRow | undefined;
  try {
    const { rows } = await client.query<CreateOperationRow>(
      `select operation_id, replayed
         from renave.${functionName}(
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23
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
  input: CreateOperationInput,
): Promise<CreateOperationResult> {
  return createOrReplayUsing(client, input, "create_held_local_operation");
}
