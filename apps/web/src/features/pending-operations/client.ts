const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const POSITIVE_BIGINT_PATTERN = /^[1-9]\d{0,18}$/u;

export type PendingOperationKind = "USED_STOCK_ENTRY";
export type PendingOperationStatus = "PENDING_RECONCILIATION" | "MANUAL_REVIEW";
export type OperationTimelineStatus =
  | "HELD_LOCAL"
  | "PENDING_SEND"
  | "SENT"
  | "REJECTED"
  | "PENDING_RECONCILIATION"
  | "CONFIRMED"
  | "MANUAL_REVIEW";
export type OperationDetailStatus = Exclude<
  OperationTimelineStatus,
  "HELD_LOCAL"
>;
export type OperationRemoteState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface PendingOperationSummary {
  correlationId: string;
  createdAt: string;
  kind: PendingOperationKind;
  operationId: string;
  reasonCode: string | null;
  sentAt: string | null;
  status: PendingOperationStatus;
  updatedAt: string;
}

export interface PendingOperationsPage {
  items: readonly PendingOperationSummary[];
  truncated: boolean;
}

export interface PendingOperationDetailRecord {
  correlationId: string;
  createdAt: string;
  finalizedAt: string | null;
  kind: PendingOperationKind;
  operationId: string;
  reasonCode: string | null;
  remoteRecordId: number | null;
  remoteState: OperationRemoteState | null;
  sentAt: string | null;
  status: OperationDetailStatus;
  updatedAt: string;
  version: string;
}

export interface PendingOperationTimelineItem {
  changedAt: string;
  previousStatus: OperationTimelineStatus | null;
  reasonCode: string | null;
  status: OperationTimelineStatus;
  version: string;
}

export interface PendingOperationDetail {
  operation: PendingOperationDetailRecord;
  timeline: readonly PendingOperationTimelineItem[];
}

export interface PendingOperationsClient {
  loadDetail(input: {
    establishmentId: string;
    operationId: string;
    signal?: AbortSignal;
    tenantId: string;
  }): Promise<PendingOperationDetail>;
  loadPage(input: {
    establishmentId: string;
    signal?: AbortSignal;
    tenantId: string;
  }): Promise<PendingOperationsPage>;
}

export class PendingOperationsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("Consulta de pendências não concluída");
    this.name = "PendingOperationsClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function dateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

const kinds = new Set<PendingOperationKind>(["USED_STOCK_ENTRY"]);
const pendingStatuses = new Set<PendingOperationStatus>([
  "PENDING_RECONCILIATION",
  "MANUAL_REVIEW",
]);
const timelineStatuses = new Set<OperationTimelineStatus>([
  "HELD_LOCAL",
  "PENDING_SEND",
  "SENT",
  "REJECTED",
  "PENDING_RECONCILIATION",
  "CONFIRMED",
  "MANUAL_REVIEW",
]);
const detailStatuses = new Set<OperationDetailStatus>([
  "PENDING_SEND",
  "SENT",
  "REJECTED",
  "PENDING_RECONCILIATION",
  "CONFIRMED",
  "MANUAL_REVIEW",
]);
const remoteStates = new Set<OperationRemoteState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);

function parseSummary(value: unknown): PendingOperationSummary {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "operationId",
      "kind",
      "status",
      "reasonCode",
      "correlationId",
      "sentAt",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    typeof value.correlationId !== "string" ||
    !UUID_PATTERN.test(value.correlationId) ||
    typeof value.kind !== "string" ||
    !kinds.has(value.kind as PendingOperationKind) ||
    typeof value.status !== "string" ||
    !pendingStatuses.has(value.status as PendingOperationStatus) ||
    (value.reasonCode !== null && !reasonCode(value.reasonCode)) ||
    (value.sentAt !== null && !dateTime(value.sentAt)) ||
    !dateTime(value.createdAt) ||
    !dateTime(value.updatedAt)
  ) {
    throw new Error("Operação pendente inválida");
  }
  return {
    correlationId: value.correlationId,
    createdAt: value.createdAt,
    kind: value.kind as PendingOperationKind,
    operationId: value.operationId,
    reasonCode: value.reasonCode as string | null,
    sentAt: value.sentAt as string | null,
    status: value.status as PendingOperationStatus,
    updatedAt: value.updatedAt,
  };
}

function parsePage(value: unknown): PendingOperationsPage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["items", "truncated"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("Fila de pendências inválida");
  }
  const seen = new Set<string>();
  const items = value.items.map((candidate) => {
    const item = parseSummary(candidate);
    if (seen.has(item.operationId)) {
      throw new Error("Operação duplicada na fila de pendências");
    }
    seen.add(item.operationId);
    return item;
  });
  return { items, truncated: value.truncated };
}

function parseDetailOperation(value: unknown): PendingOperationDetailRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "operationId",
      "kind",
      "status",
      "reasonCode",
      "correlationId",
      "sentAt",
      "createdAt",
      "updatedAt",
      "version",
      "remoteRecordId",
      "remoteState",
      "finalizedAt",
    ])
  ) {
    throw new Error("Detalhe da operação inválido");
  }
  if (
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    typeof value.correlationId !== "string" ||
    !UUID_PATTERN.test(value.correlationId) ||
    value.kind !== "USED_STOCK_ENTRY" ||
    typeof value.status !== "string" ||
    !detailStatuses.has(value.status as OperationDetailStatus) ||
    (value.reasonCode !== null && !reasonCode(value.reasonCode)) ||
    (value.sentAt !== null && !dateTime(value.sentAt)) ||
    !dateTime(value.createdAt) ||
    !dateTime(value.updatedAt) ||
    typeof value.version !== "string" ||
    !POSITIVE_BIGINT_PATTERN.test(value.version) ||
    (value.remoteRecordId !== null &&
      (!Number.isSafeInteger(value.remoteRecordId) ||
        (value.remoteRecordId as number) < 1)) ||
    (value.remoteState !== null &&
      (typeof value.remoteState !== "string" ||
        !remoteStates.has(value.remoteState as OperationRemoteState))) ||
    (value.finalizedAt !== null && !dateTime(value.finalizedAt))
  ) {
    throw new Error("Detalhe da operação inválido");
  }
  return {
    correlationId: value.correlationId,
    createdAt: value.createdAt,
    finalizedAt: value.finalizedAt as string | null,
    kind: "USED_STOCK_ENTRY",
    operationId: value.operationId,
    reasonCode: value.reasonCode as string | null,
    remoteRecordId: value.remoteRecordId as number | null,
    remoteState: value.remoteState as OperationRemoteState | null,
    sentAt: value.sentAt as string | null,
    status: value.status as OperationDetailStatus,
    updatedAt: value.updatedAt,
    version: value.version,
  };
}

function parseTimelineItem(value: unknown): PendingOperationTimelineItem {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "previousStatus",
      "status",
      "reasonCode",
      "changedAt",
    ]) ||
    typeof value.version !== "string" ||
    !POSITIVE_BIGINT_PATTERN.test(value.version) ||
    (value.previousStatus !== null &&
      (typeof value.previousStatus !== "string" ||
        !timelineStatuses.has(
          value.previousStatus as OperationTimelineStatus,
        ))) ||
    typeof value.status !== "string" ||
    !timelineStatuses.has(value.status as OperationTimelineStatus) ||
    (value.reasonCode !== null && !reasonCode(value.reasonCode)) ||
    !dateTime(value.changedAt)
  ) {
    throw new Error("Evento inválido na linha do tempo");
  }
  return {
    changedAt: value.changedAt,
    previousStatus: value.previousStatus as OperationTimelineStatus | null,
    reasonCode: value.reasonCode as string | null,
    status: value.status as OperationTimelineStatus,
    version: value.version,
  };
}

function parseDetail(value: unknown): PendingOperationDetail {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["operation", "timeline"]) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > 100
  ) {
    throw new Error("Resposta do detalhe inválida");
  }
  const operation = parseDetailOperation(value.operation);
  const timeline = value.timeline.map(parseTimelineItem);
  if (
    timeline.some(
      (item, index) =>
        index > 0 &&
        comparePositiveBigints(
          item.version,
          timeline[index - 1]?.version ?? "0",
        ) <= 0,
    )
  ) {
    throw new Error("Linha do tempo fora de ordem");
  }
  return { operation, timeline };
}

function comparePositiveBigints(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

async function request(
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new PendingOperationsClientError(0, "NETWORK_ERROR");
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new PendingOperationsClientError(
      response.status,
      isRecord(value) && typeof value.code === "string"
        ? value.code
        : undefined,
    );
  }
  return value;
}

export const browserPendingOperationsClient: PendingOperationsClient = {
  async loadDetail({ establishmentId, operationId, signal, tenantId }) {
    if (!UUID_PATTERN.test(operationId)) {
      throw new PendingOperationsClientError(404, "TENANT_RESOURCE_NOT_FOUND");
    }
    const value = await request(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/operations/${operationId}`,
      signal,
    );
    try {
      return parseDetail(value);
    } catch {
      throw new PendingOperationsClientError(0, "INVALID_RESPONSE");
    }
  },
  async loadPage({ establishmentId, signal, tenantId }) {
    const value = await request(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/pending-operations?limit=50`,
      signal,
    );
    try {
      return parsePage(value);
    } catch {
      throw new PendingOperationsClientError(0, "INVALID_RESPONSE");
    }
  },
};
