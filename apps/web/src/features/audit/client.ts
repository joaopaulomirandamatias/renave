const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const HASH_PREFIX_PATTERN = /^[0-9a-f]{12}$/iu;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export const TENANT_AUDIT_OUTCOMES = [
  "attempted",
  "succeeded",
  "rejected",
  "outcome_unknown",
  "reconciled",
  "manual_review",
] as const;

export type TenantAuditOutcome = (typeof TENANT_AUDIT_OUTCOMES)[number];

const OUTCOME_SET = new Set<string>(TENANT_AUDIT_OUTCOMES);

export interface TenantAuditEventItem {
  action: string;
  entityType: string;
  establishmentId: string;
  eventHashPrefix: string;
  occurredAt: string;
  outcome: TenantAuditOutcome;
  sequence: number;
  traceId: string | null;
}

export interface TenantAuditEventsPage {
  hasMore: boolean;
  items: readonly TenantAuditEventItem[];
  nextBeforeSequence?: number;
}

export type TenantAuditEventsResult =
  { status: "denied" } | { page: TenantAuditEventsPage; status: "ready" };

export interface LoadTenantAuditEventsInput {
  beforeSequence?: number;
  establishmentId?: string;
  limit?: number;
  outcome?: TenantAuditOutcome;
  signal?: AbortSignal;
  tenantId: string;
}

export interface TenantAuditClient {
  loadEvents(
    input: LoadTenantAuditEventsInput,
  ): Promise<TenantAuditEventsResult>;
}

export class TenantAuditClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("Consulta da trilha de auditoria não concluída");
    this.name = "TenantAuditClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !CONTROL_CHARS.test(value)
  );
}

function validDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseTenantAuditEventsPage(
  value: unknown,
): TenantAuditEventsPage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["hasMore", "items"], ["nextBeforeSequence"]) ||
    typeof value.hasMore !== "boolean" ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Resposta da trilha de auditoria inválida");
  }

  const seenSequences = new Set<number>();
  const items: TenantAuditEventItem[] = value.items.map((raw) => {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "action",
        "entityType",
        "establishmentId",
        "eventHashPrefix",
        "occurredAt",
        "outcome",
        "sequence",
        "traceId",
      ]) ||
      !validText(raw.action, 120) ||
      !validText(raw.entityType, 64) ||
      typeof raw.establishmentId !== "string" ||
      !UUID_PATTERN.test(raw.establishmentId) ||
      typeof raw.eventHashPrefix !== "string" ||
      !HASH_PREFIX_PATTERN.test(raw.eventHashPrefix) ||
      !validDateTime(raw.occurredAt) ||
      typeof raw.outcome !== "string" ||
      !OUTCOME_SET.has(raw.outcome) ||
      typeof raw.sequence !== "number" ||
      !Number.isSafeInteger(raw.sequence) ||
      raw.sequence <= 0 ||
      seenSequences.has(raw.sequence) ||
      (raw.traceId !== null && !validText(raw.traceId, 128))
    ) {
      throw new Error("Evento de auditoria inválido");
    }

    seenSequences.add(raw.sequence);
    return {
      action: raw.action,
      entityType: raw.entityType,
      establishmentId: raw.establishmentId.toLowerCase(),
      eventHashPrefix: raw.eventHashPrefix.toLowerCase(),
      occurredAt: raw.occurredAt,
      outcome: raw.outcome as TenantAuditOutcome,
      sequence: raw.sequence,
      traceId: raw.traceId,
    };
  });

  if (value.hasMore) {
    if (
      typeof value.nextBeforeSequence !== "number" ||
      !Number.isSafeInteger(value.nextBeforeSequence) ||
      value.nextBeforeSequence <= 0
    ) {
      throw new Error("Cursor de paginação de auditoria inválido");
    }
    return {
      hasMore: true,
      items,
      nextBeforeSequence: value.nextBeforeSequence,
    };
  }

  if (value.nextBeforeSequence !== undefined) {
    throw new Error("Cursor inesperado quando não há mais eventos");
  }

  return {
    hasMore: false,
    items,
  };
}

export function createTenantAuditClient(
  fetchImpl: typeof fetch = fetch,
): TenantAuditClient {
  return {
    async loadEvents(input) {
      if (!UUID_PATTERN.test(input.tenantId)) {
        return { status: "denied" };
      }

      const params = new URLSearchParams();
      if (input.establishmentId !== undefined) {
        if (!UUID_PATTERN.test(input.establishmentId)) {
          throw new TenantAuditClientError(400, "INVALID_AUDIT_QUERY");
        }
        params.set("establishmentId", input.establishmentId.toLowerCase());
      }
      if (input.outcome !== undefined) {
        if (!OUTCOME_SET.has(input.outcome)) {
          throw new TenantAuditClientError(400, "INVALID_AUDIT_QUERY");
        }
        params.set("outcome", input.outcome);
      }
      if (input.beforeSequence !== undefined) {
        if (
          !Number.isSafeInteger(input.beforeSequence) ||
          input.beforeSequence <= 0
        ) {
          throw new TenantAuditClientError(400, "INVALID_AUDIT_QUERY");
        }
        params.set("beforeSequence", String(input.beforeSequence));
      }
      if (input.limit !== undefined) {
        if (
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 50
        ) {
          throw new TenantAuditClientError(400, "INVALID_AUDIT_QUERY");
        }
        params.set("limit", String(input.limit));
      }

      const query = params.toString();
      const url = `/api/tenants/${encodeURIComponent(input.tenantId.toLowerCase())}/audit-events${query ? `?${query}` : ""}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "error",
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        throw new TenantAuditClientError(0, "NETWORK_ERROR");
      }

      if (response.status === 403 || response.status === 404) {
        return { status: "denied" };
      }

      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new TenantAuditClientError(
          response.status,
          isRecord(payload) && typeof payload.code === "string"
            ? payload.code
            : undefined,
        );
      }

      try {
        return {
          page: parseTenantAuditEventsPage(payload),
          status: "ready",
        };
      } catch {
        throw new TenantAuditClientError(0, "INVALID_RESPONSE");
      }
    },
  };
}

export const browserTenantAuditClient = createTenantAuditClient();
