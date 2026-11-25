import type { TenantClient } from "./tenant-context.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/u;

export const pendingOperationStatuses = [
  "PENDING_RECONCILIATION",
  "MANUAL_REVIEW",
] as const;

export type PendingOperationStatus = (typeof pendingOperationStatuses)[number];

export const readableOperationStatuses = [
  "PENDING_SEND",
  "SENT",
  "REJECTED",
  "PENDING_RECONCILIATION",
  "CONFIRMED",
  "MANUAL_REVIEW",
] as const;

export type ReadableOperationStatus =
  (typeof readableOperationStatuses)[number];

export const readableRemoteStates = [
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
] as const;

export type ReadableRemoteState = (typeof readableRemoteStates)[number];

export interface PendingOperationSummary {
  correlationId: string;
  createdAt: Date;
  kind: "USED_STOCK_ENTRY";
  operationId: string;
  reasonCode: string | null;
  sentAt: Date | null;
  status: PendingOperationStatus;
  updatedAt: Date;
}

export interface PendingOperationDetailSummary {
  correlationId: string;
  createdAt: Date;
  finalizedAt: Date | null;
  kind: "USED_STOCK_ENTRY";
  operationId: string;
  reasonCode: string | null;
  remoteRecordId: number | null;
  remoteState: ReadableRemoteState | null;
  sentAt: Date | null;
  status: ReadableOperationStatus;
  updatedAt: Date;
  version: string;
}

export interface PendingOperationTimelineEntry {
  changedAt: Date;
  previousStatus: ReadableOperationStatus | null;
  reasonCode: string | null;
  status: ReadableOperationStatus;
  version: string;
}

export interface PendingOperationDetail {
  operation: PendingOperationDetailSummary;
  timeline: PendingOperationTimelineEntry[];
}

export interface PendingOperationPage {
  items: PendingOperationSummary[];
  truncated: boolean;
}

export class OperationPendingReaderInputError extends Error {
  override name = "OperationPendingReaderInputError";

  constructor() {
    super("A leitura de operações pendentes contém dados inválidos.");
  }
}

export class OperationPendingReaderStorageError extends Error {
  override name = "OperationPendingReaderStorageError";

  constructor() {
    super("As operações pendentes não puderam ser consultadas.");
  }
}

interface PendingOperationRow {
  correlation_id: string;
  created_at: Date;
  kind: string;
  operation_id: string;
  reason_code: string | null;
  sent_at: Date | null;
  status: string;
  updated_at: Date;
}

interface PendingOperationDetailRow extends PendingOperationRow {
  finalized_at: Date | null;
  remote_record_id: string | null;
  remote_state: string | null;
  version: string;
}

interface PendingOperationTimelineRow {
  changed_at: Date;
  previous_status: string | null;
  reason_code: string | null;
  status: string;
  version: string;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isReasonCode(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && REASON_CODE_PATTERN.test(value))
  );
}

function isPendingStatus(value: string): value is PendingOperationStatus {
  return pendingOperationStatuses.some((candidate) => candidate === value);
}

function isReadableStatus(value: string): value is ReadableOperationStatus {
  return readableOperationStatuses.some((candidate) => candidate === value);
}

function isRemoteState(value: string): value is ReadableRemoteState {
  return readableRemoteStates.some((candidate) => candidate === value);
}

function nullableDate(value: unknown): value is Date | null {
  return value === null || isDate(value);
}

function toSummary(row: PendingOperationRow): PendingOperationSummary {
  if (
    !isUuid(row.operation_id) ||
    row.kind !== "USED_STOCK_ENTRY" ||
    !isPendingStatus(row.status) ||
    !isReasonCode(row.reason_code) ||
    !isUuid(row.correlation_id) ||
    !nullableDate(row.sent_at) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at) ||
    row.updated_at.getTime() < row.created_at.getTime()
  ) {
    throw new OperationPendingReaderStorageError();
  }
  return {
    correlationId: row.correlation_id.toLowerCase(),
    createdAt: new Date(row.created_at),
    kind: "USED_STOCK_ENTRY",
    operationId: row.operation_id.toLowerCase(),
    reasonCode: row.reason_code,
    sentAt: row.sent_at === null ? null : new Date(row.sent_at),
    status: row.status,
    updatedAt: new Date(row.updated_at),
  };
}

function toDetailSummary(
  row: PendingOperationDetailRow,
): PendingOperationDetailSummary {
  if (
    !isUuid(row.operation_id) ||
    row.kind !== "USED_STOCK_ENTRY" ||
    !isReadableStatus(row.status) ||
    !isReasonCode(row.reason_code) ||
    !isUuid(row.correlation_id) ||
    !nullableDate(row.sent_at) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at) ||
    row.updated_at.getTime() < row.created_at.getTime() ||
    !nullableDate(row.finalized_at) ||
    !POSITIVE_BIGINT_PATTERN.test(row.version) ||
    !(
      row.remote_record_id === null ||
      (POSITIVE_BIGINT_PATTERN.test(row.remote_record_id) &&
        Number.isSafeInteger(Number(row.remote_record_id)))
    ) ||
    !(
      row.remote_state === null ||
      (typeof row.remote_state === "string" && isRemoteState(row.remote_state))
    )
  ) {
    throw new OperationPendingReaderStorageError();
  }
  return {
    correlationId: row.correlation_id.toLowerCase(),
    createdAt: new Date(row.created_at),
    finalizedAt: row.finalized_at === null ? null : new Date(row.finalized_at),
    kind: "USED_STOCK_ENTRY",
    operationId: row.operation_id.toLowerCase(),
    reasonCode: row.reason_code,
    remoteRecordId:
      row.remote_record_id === null ? null : Number(row.remote_record_id),
    remoteState: row.remote_state,
    sentAt: row.sent_at === null ? null : new Date(row.sent_at),
    status: row.status,
    updatedAt: new Date(row.updated_at),
    version: row.version,
  };
}

function toTimelineEntry(
  row: PendingOperationTimelineRow,
): PendingOperationTimelineEntry {
  if (
    !POSITIVE_BIGINT_PATTERN.test(row.version) ||
    !(
      row.previous_status === null ||
      (typeof row.previous_status === "string" &&
        isReadableStatus(row.previous_status))
    ) ||
    !isReadableStatus(row.status) ||
    !isReasonCode(row.reason_code) ||
    !isDate(row.changed_at)
  ) {
    throw new OperationPendingReaderStorageError();
  }
  return {
    changedAt: new Date(row.changed_at),
    previousStatus: row.previous_status,
    reasonCode: row.reason_code,
    status: row.status,
    version: row.version,
  };
}

function validateScope(establishmentId: string): string {
  if (!isUuid(establishmentId)) throw new OperationPendingReaderInputError();
  return establishmentId.toLowerCase();
}

export async function listPendingOperations(
  client: TenantClient,
  input: { establishmentId: string; limit: number },
): Promise<PendingOperationPage> {
  const establishmentId = validateScope(input.establishmentId);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50
  ) {
    throw new OperationPendingReaderInputError();
  }
  try {
    const { rows } = await client.query<PendingOperationRow>(
      "select * from renave_operation_reader.list_pending_operations($1,$2)",
      [establishmentId, input.limit],
    );
    if (rows.length > input.limit + 1) {
      throw new OperationPendingReaderStorageError();
    }
    const truncated = rows.length > input.limit;
    return {
      items: rows.slice(0, input.limit).map(toSummary),
      truncated,
    };
  } catch (error) {
    if (error instanceof OperationPendingReaderStorageError) throw error;
    throw new OperationPendingReaderStorageError();
  }
}

export async function getPendingOperationDetail(
  client: TenantClient,
  input: { establishmentId: string; operationId: string },
): Promise<PendingOperationDetail | null> {
  const establishmentId = validateScope(input.establishmentId);
  if (!isUuid(input.operationId)) {
    throw new OperationPendingReaderInputError();
  }
  const operationId = input.operationId.toLowerCase();
  try {
    const detail = await client.query<PendingOperationDetailRow>(
      "select * from renave_operation_reader.get_operation_detail($1,$2)",
      [establishmentId, operationId],
    );
    if (detail.rows.length > 1) {
      throw new OperationPendingReaderStorageError();
    }
    const row = detail.rows[0];
    if (!row) return null;
    const timeline = await client.query<PendingOperationTimelineRow>(
      "select * from renave_operation_reader.list_operation_timeline($1,$2)",
      [establishmentId, operationId],
    );
    const operation = toDetailSummary(row);
    const entries = timeline.rows.map(toTimelineEntry);
    const last = entries.at(-1);
    if (
      !last ||
      last.version !== operation.version ||
      last.status !== operation.status ||
      entries.some(
        (entry, index) =>
          entry.version !== String(index + 1) ||
          entry.previousStatus !== (entries[index - 1]?.status ?? null),
      )
    ) {
      throw new OperationPendingReaderStorageError();
    }
    return {
      operation,
      timeline: entries,
    };
  } catch (error) {
    if (error instanceof OperationPendingReaderStorageError) throw error;
    throw new OperationPendingReaderStorageError();
  }
}
