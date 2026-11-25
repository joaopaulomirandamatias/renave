import type { TenantClient } from "./tenant-context.js";
import { isValidNormalizedCnpj } from "./cnpj.js";
import type { OperationKind, OperationMutationFamily } from "./operations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256_BYTES = 32;

export const reconciliationManualReviewReasons = [
  "RENAVE_RECONCILIATION_AMBIGUOUS",
  "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
  "RENAVE_RECONCILIATION_UNRECOVERABLE",
] as const;
export type ReconciliationManualReviewReason =
  (typeof reconciliationManualReviewReasons)[number];

export type ReconciliationRemoteState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface OperationReconciliationFence {
  leaseOwner: string;
  leaseToken: string;
  operationVersion: string;
  outboxId: string;
}

export interface OperationReconciliationClaim {
  attemptCount: number;
  leaseExpiresAt: Date;
  leaseToken: string;
  operationId: string;
  operationVersion: string;
  outboxId: string;
}

export interface OperationReconciliationBegin {
  attemptCount: number;
  correlationId: string;
  establishmentCnpj: string;
  establishmentId: string;
  kind: OperationKind;
  leaseExpiresAt: Date;
  mutationFamily: OperationMutationFamily;
  operationId: string;
  operationVersion: string;
  outboxId: string;
  projectionAuthTag: Buffer;
  projectionByteLength: number;
  projectionCiphertext: Buffer;
  projectionGeneration: string;
  projectionKeyId: string;
  projectionKind: "STOCK_ENTRY_RECONCILIATION";
  projectionNonce: Buffer;
  projectionSchemaVersion: 1;
  requestSchemaVersion: number;
  sentAt: Date;
  sourceRequestSha256: Buffer;
}

export interface OperationReconciliationCompletion {
  completedAt: Date;
  operationId: string;
  operationVersion: string;
  reconcileOutboxId: string;
}

export interface OperationReconciliationProjectionPreflight {
  establishmentId: string;
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  operationId: string;
  projectionAuthTag: Buffer;
  projectionByteLength: number;
  projectionCiphertext: Buffer;
  projectionGeneration: string;
  projectionKeyId: string;
  projectionKind: "STOCK_ENTRY_RECONCILIATION";
  projectionNonce: Buffer;
  projectionSchemaVersion: 1;
  requestSchemaVersion: number;
  sourceRequestSha256: Buffer;
}

export class OperationReconciliationInputError extends Error {
  override get name(): string {
    return "OperationReconciliationInputError";
  }

  constructor() {
    super("Os parâmetros da reconciliação são inválidos.");
  }
}

export class OperationReconciliationStorageError extends Error {
  override get name(): string {
    return "OperationReconciliationStorageError";
  }

  constructor() {
    super("A reconciliação não pôde ser persistida.");
  }
}

interface ClaimRow {
  attempt_count: number;
  lease_expires_at: Date;
  lease_token: string;
  operation_id: string;
  operation_version: string;
  outbox_id: string;
}

interface BeginRow {
  attempt_count: number;
  correlation_id: string;
  establishment_cnpj: string;
  establishment_id: string;
  kind: string;
  lease_expires_at: Date;
  mutation_family: string;
  operation_id: string;
  operation_version: string;
  outbox_id: string;
  projection_auth_tag: Buffer;
  projection_ciphertext: Buffer;
  projection_generation: string;
  projection_key_id: string;
  projection_kind: string;
  projection_nonce: Buffer;
  projection_schema_version: number;
  projection_size: number;
  request_schema_version: number;
  sent_at: Date;
  source_request_sha256: Buffer;
}

interface CompletionRow {
  completed_at: Date;
  operation_id: string;
  operation_version: string;
  reconcile_outbox_id: string;
}

interface ProjectionPreflightRow {
  establishment_id: string;
  kind: string;
  mutation_family: string;
  operation_id: string;
  projection_auth_tag: Buffer;
  projection_ciphertext: Buffer;
  projection_generation: string;
  projection_key_id: string;
  projection_kind: string;
  projection_nonce: Buffer;
  projection_schema_version: number;
  projection_size: number;
  request_schema_version: number;
  source_request_sha256: Buffer;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveVersion(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyBytes(value: unknown, length?: number): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    (length === undefined
      ? value.byteLength < 1 || value.byteLength > 4_096
      : value.byteLength !== length)
  ) {
    throw new OperationReconciliationStorageError();
  }
  return Buffer.from(value);
}

function normalizeFence(input: OperationReconciliationFence) {
  let leaseOwner: unknown;
  let leaseToken: unknown;
  let operationVersion: unknown;
  let outboxId: unknown;
  try {
    leaseOwner = input?.leaseOwner;
    leaseToken = input?.leaseToken;
    operationVersion = input?.operationVersion;
    outboxId = input?.outboxId;
  } catch {
    throw new OperationReconciliationInputError();
  }
  if (
    !isUuid(outboxId) ||
    !isUuid(leaseOwner) ||
    !isUuid(leaseToken) ||
    !isPositiveVersion(operationVersion)
  ) {
    throw new OperationReconciliationInputError();
  }
  return {
    leaseOwner: leaseOwner.toLowerCase(),
    leaseToken: leaseToken.toLowerCase(),
    operationVersion,
    outboxId: outboxId.toLowerCase(),
  };
}

function toClaim(row: ClaimRow): OperationReconciliationClaim {
  if (
    !isUuid(row.outbox_id) ||
    !isUuid(row.operation_id) ||
    !isUuid(row.lease_token) ||
    !isPositiveVersion(row.operation_version) ||
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    !validDate(row.lease_expires_at)
  ) {
    throw new OperationReconciliationStorageError();
  }
  return {
    attemptCount: row.attempt_count,
    leaseExpiresAt: new Date(row.lease_expires_at),
    leaseToken: row.lease_token,
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    outboxId: row.outbox_id,
  };
}

function toBegin(row: BeginRow): OperationReconciliationBegin {
  if (
    !isUuid(row.outbox_id) ||
    !isUuid(row.operation_id) ||
    !isPositiveVersion(row.operation_version) ||
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    !validDate(row.lease_expires_at) ||
    !isUuid(row.establishment_id) ||
    !isUuid(row.correlation_id) ||
    !isValidNormalizedCnpj(row.establishment_cnpj) ||
    row.kind !== "USED_STOCK_ENTRY" ||
    row.mutation_family !== "STOCK_ENTRY" ||
    !Number.isSafeInteger(row.request_schema_version) ||
    row.request_schema_version < 1 ||
    !validDate(row.sent_at) ||
    row.projection_kind !== "STOCK_ENTRY_RECONCILIATION" ||
    row.projection_schema_version !== 1 ||
    !isPositiveVersion(row.projection_generation) ||
    !Number.isSafeInteger(row.projection_size) ||
    row.projection_size < 1 ||
    row.projection_size > 4_096 ||
    typeof row.projection_key_id !== "string" ||
    !KEY_ID_PATTERN.test(row.projection_key_id) ||
    !Buffer.isBuffer(row.projection_ciphertext) ||
    row.projection_ciphertext.byteLength !== row.projection_size
  ) {
    throw new OperationReconciliationStorageError();
  }
  return {
    attemptCount: row.attempt_count,
    correlationId: row.correlation_id,
    establishmentCnpj: row.establishment_cnpj,
    establishmentId: row.establishment_id,
    kind: row.kind,
    mutationFamily: row.mutation_family,
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    outboxId: row.outbox_id,
    projectionAuthTag: copyBytes(row.projection_auth_tag, 16),
    projectionByteLength: row.projection_size,
    projectionCiphertext: copyBytes(row.projection_ciphertext),
    projectionGeneration: row.projection_generation,
    projectionKeyId: row.projection_key_id,
    projectionKind: row.projection_kind,
    projectionNonce: copyBytes(row.projection_nonce, 12),
    projectionSchemaVersion: row.projection_schema_version,
    requestSchemaVersion: row.request_schema_version,
    leaseExpiresAt: new Date(row.lease_expires_at),
    sentAt: new Date(row.sent_at),
    sourceRequestSha256: copyBytes(row.source_request_sha256, SHA256_BYTES),
  };
}

function toCompletion(
  row: CompletionRow | undefined,
): OperationReconciliationCompletion | null {
  if (!row) return null;
  if (
    !isUuid(row.operation_id) ||
    !isUuid(row.reconcile_outbox_id) ||
    !isPositiveVersion(row.operation_version) ||
    !validDate(row.completed_at)
  ) {
    throw new OperationReconciliationStorageError();
  }
  return {
    completedAt: new Date(row.completed_at),
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    reconcileOutboxId: row.reconcile_outbox_id,
  };
}

export async function claimOperationReconciliations(
  client: TenantClient,
  leaseOwner: string,
  limit: number,
): Promise<OperationReconciliationClaim[]> {
  if (
    !isUuid(leaseOwner) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new OperationReconciliationInputError();
  }
  try {
    const { rows } = await client.query<ClaimRow>(
      "select * from renave.claim_operation_reconciliation_leases($1,$2)",
      [leaseOwner.toLowerCase(), limit],
    );
    return rows.map(toClaim);
  } catch (error) {
    if (error instanceof OperationReconciliationStorageError) throw error;
    throw new OperationReconciliationStorageError();
  }
}

export async function listPendingOperationReconciliationProjectionKeyIds(
  client: TenantClient,
): Promise<readonly string[]> {
  try {
    const { rows } = await client.query<{ projection_key_id: string }>(
      "select * from renave.list_pending_operation_reconciliation_projection_key_ids()",
    );
    const keyIds = rows.map(({ projection_key_id }) => projection_key_id);
    if (
      keyIds.some(
        (keyId) => typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId),
      ) ||
      new Set(keyIds).size !== keyIds.length
    ) {
      throw new OperationReconciliationStorageError();
    }
    return keyIds;
  } catch (error) {
    if (error instanceof OperationReconciliationStorageError) throw error;
    throw new OperationReconciliationStorageError();
  }
}

export async function preflightPendingOperationReconciliationProjectionSamples(
  client: TenantClient,
): Promise<readonly OperationReconciliationProjectionPreflight[]> {
  try {
    const { rows } = await client.query<ProjectionPreflightRow>(
      "select * from renave.preflight_pending_operation_reconciliation_projection_samples()",
    );
    return rows.map((row) => {
      const ciphertext = copyBytes(row.projection_ciphertext);
      if (
        !isUuid(row.operation_id) ||
        !isUuid(row.establishment_id) ||
        row.kind !== "USED_STOCK_ENTRY" ||
        row.mutation_family !== "STOCK_ENTRY" ||
        !Number.isSafeInteger(row.request_schema_version) ||
        row.request_schema_version < 1 ||
        row.projection_kind !== "STOCK_ENTRY_RECONCILIATION" ||
        row.projection_schema_version !== 1 ||
        !isPositiveVersion(row.projection_generation) ||
        !Number.isSafeInteger(row.projection_size) ||
        row.projection_size !== ciphertext.byteLength ||
        typeof row.projection_key_id !== "string" ||
        !KEY_ID_PATTERN.test(row.projection_key_id)
      ) {
        ciphertext.fill(0);
        throw new OperationReconciliationStorageError();
      }
      return {
        establishmentId: row.establishment_id,
        kind: row.kind,
        mutationFamily: row.mutation_family,
        operationId: row.operation_id,
        projectionAuthTag: copyBytes(row.projection_auth_tag, 16),
        projectionByteLength: row.projection_size,
        projectionCiphertext: ciphertext,
        projectionGeneration: row.projection_generation,
        projectionKeyId: row.projection_key_id,
        projectionKind: row.projection_kind,
        projectionNonce: copyBytes(row.projection_nonce, 12),
        projectionSchemaVersion: row.projection_schema_version,
        requestSchemaVersion: row.request_schema_version,
        sourceRequestSha256: copyBytes(row.source_request_sha256, SHA256_BYTES),
      };
    });
  } catch (error) {
    if (
      error instanceof OperationReconciliationInputError ||
      error instanceof OperationReconciliationStorageError
    ) {
      throw error;
    }
    throw new OperationReconciliationStorageError();
  }
}

export async function beginOperationReconciliation(
  client: TenantClient,
  input: OperationReconciliationFence,
): Promise<OperationReconciliationBegin | null> {
  const fence = normalizeFence(input);
  try {
    const { rows } = await client.query<BeginRow>(
      "select * from renave.begin_operation_reconciliation($1,$2,$3,$4)",
      [
        fence.outboxId,
        fence.leaseOwner,
        fence.leaseToken,
        fence.operationVersion,
      ],
    );
    return rows[0] ? toBegin(rows[0]) : null;
  } catch (error) {
    if (error instanceof OperationReconciliationStorageError) throw error;
    throw new OperationReconciliationStorageError();
  }
}

async function booleanFenceCall(
  client: TenantClient,
  sql: string,
  values: unknown[],
): Promise<boolean> {
  try {
    const { rows } = await client.query<{ value: boolean }>(sql, values);
    if (rows.length !== 1 || typeof rows[0]?.value !== "boolean") {
      throw new OperationReconciliationStorageError();
    }
    return rows[0].value;
  } catch (error) {
    if (error instanceof OperationReconciliationStorageError) throw error;
    throw new OperationReconciliationStorageError();
  }
}

export async function renewOperationReconciliationLease(
  client: TenantClient,
  input: OperationReconciliationFence,
): Promise<boolean> {
  const fence = normalizeFence(input);
  return booleanFenceCall(
    client,
    "select renave.renew_operation_reconciliation_lease($1,$2,$3,$4) as value",
    [
      fence.outboxId,
      fence.leaseOwner,
      fence.leaseToken,
      fence.operationVersion,
    ],
  );
}

export async function releaseOperationReconciliationLease(
  client: TenantClient,
  input: OperationReconciliationFence & { retryAt: Date },
): Promise<boolean> {
  const fence = normalizeFence(input);
  let retryAt: unknown;
  try {
    retryAt = input.retryAt;
  } catch {
    throw new OperationReconciliationInputError();
  }
  if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) {
    throw new OperationReconciliationInputError();
  }
  return booleanFenceCall(
    client,
    `select renave.release_operation_reconciliation_lease(
       $1,$2,$3,$4,
       greatest(0, least(86400, ceil(extract(epoch from
         $5::timestamptz - pg_catalog.clock_timestamp())))::integer)
     ) as value`,
    [
      fence.outboxId,
      fence.leaseOwner,
      fence.leaseToken,
      fence.operationVersion,
      new Date(retryAt),
    ],
  );
}

async function completionCall(
  client: TenantClient,
  sql: string,
  values: unknown[],
): Promise<OperationReconciliationCompletion | null> {
  try {
    const { rows } = await client.query<CompletionRow>(sql, values);
    return toCompletion(rows[0]);
  } catch (error) {
    if (error instanceof OperationReconciliationStorageError) throw error;
    throw new OperationReconciliationStorageError();
  }
}

export async function completeOperationReconciliationConfirmed(
  client: TenantClient,
  input: OperationReconciliationFence & {
    remoteRecordId: number;
    remoteState: ReconciliationRemoteState;
  },
): Promise<OperationReconciliationCompletion | null> {
  const fence = normalizeFence(input);
  let remoteRecordId: unknown;
  let remoteState: unknown;
  try {
    remoteRecordId = input.remoteRecordId;
    remoteState = input.remoteState;
  } catch {
    throw new OperationReconciliationInputError();
  }
  if (
    !Number.isSafeInteger(remoteRecordId) ||
    (remoteRecordId as number) < 1 ||
    !["SOLICITADO", "TRANSFERIDO", "CONFIRMADO", "FINALIZADO"].includes(
      remoteState as string,
    )
  ) {
    throw new OperationReconciliationInputError();
  }
  return completionCall(
    client,
    "select * from renave.complete_operation_reconciliation_confirmed($1,$2,$3,$4,$5,$6)",
    [
      fence.outboxId,
      fence.leaseOwner,
      fence.leaseToken,
      fence.operationVersion,
      remoteRecordId,
      remoteState,
    ],
  );
}

export async function completeOperationReconciliationManualReview(
  client: TenantClient,
  input: OperationReconciliationFence & {
    reason: ReconciliationManualReviewReason;
  },
): Promise<OperationReconciliationCompletion | null> {
  const fence = normalizeFence(input);
  let reason: unknown;
  try {
    reason = input.reason;
  } catch {
    throw new OperationReconciliationInputError();
  }
  if (
    !reconciliationManualReviewReasons.includes(
      reason as ReconciliationManualReviewReason,
    )
  ) {
    throw new OperationReconciliationInputError();
  }
  return completionCall(
    client,
    "select * from renave.complete_operation_reconciliation_manual_review($1,$2,$3,$4,$5)",
    [
      fence.outboxId,
      fence.leaseOwner,
      fence.leaseToken,
      fence.operationVersion,
      reason,
    ],
  );
}
