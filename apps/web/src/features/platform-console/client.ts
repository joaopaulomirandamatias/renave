export const PLATFORM_CONSOLE_PATH = "/platform/renave-link-queue";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
export const PLATFORM_REASON_TICKET_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u;

export type PlatformRenaveLinkStatus =
  | "not_started"
  | "pending"
  | "confirmed"
  | "enabled"
  | "deactivated"
  | "rejected";

export interface PlatformQueueItem {
  establishment: {
    id: string;
    tradeName: string;
  };
  renaveLink: {
    status: PlatformRenaveLinkStatus;
    updatedAt: string;
  };
  tenant: {
    displayName: string;
    id: string;
  };
}

export interface PlatformQueuePage {
  items: readonly PlatformQueueItem[];
  nextCursor?: string;
  truncated: boolean;
}

export interface PlatformConsoleClient {
  loadQueue(input: {
    cursor?: string;
    reasonTicket: string;
    signal?: AbortSignal;
  }): Promise<PlatformQueuePage>;
}

export class PlatformConsoleClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("Consulta global não concluída");
    this.name = "PlatformConsoleClientError";
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
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function safeDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

const statuses = new Set<PlatformRenaveLinkStatus>([
  "not_started",
  "pending",
  "confirmed",
  "enabled",
  "deactivated",
  "rejected",
]);

function parseItem(value: unknown): PlatformQueueItem {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["tenant", "establishment", "renaveLink"]) ||
    !isRecord(value.tenant) ||
    !exactKeys(value.tenant, ["id", "displayName"]) ||
    typeof value.tenant.id !== "string" ||
    !UUID_PATTERN.test(value.tenant.id) ||
    !safeDisplayName(value.tenant.displayName) ||
    !isRecord(value.establishment) ||
    !exactKeys(value.establishment, ["id", "tradeName"]) ||
    typeof value.establishment.id !== "string" ||
    !UUID_PATTERN.test(value.establishment.id) ||
    !safeDisplayName(value.establishment.tradeName) ||
    !isRecord(value.renaveLink) ||
    !exactKeys(value.renaveLink, ["status", "updatedAt"]) ||
    typeof value.renaveLink.status !== "string" ||
    !statuses.has(value.renaveLink.status as PlatformRenaveLinkStatus) ||
    typeof value.renaveLink.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(
      value.renaveLink.updatedAt,
    ) ||
    !Number.isFinite(Date.parse(value.renaveLink.updatedAt))
  ) {
    throw new Error("Item inválido na fila global");
  }
  return {
    establishment: {
      id: value.establishment.id.toLowerCase(),
      tradeName: value.establishment.tradeName,
    },
    renaveLink: {
      status: value.renaveLink.status as PlatformRenaveLinkStatus,
      updatedAt: value.renaveLink.updatedAt,
    },
    tenant: {
      displayName: value.tenant.displayName,
      id: value.tenant.id.toLowerCase(),
    },
  };
}

function parsePage(value: unknown): PlatformQueuePage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["items", "truncated"], ["nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    typeof value.truncated !== "boolean" ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.length > 512 ||
        !CURSOR_PATTERN.test(value.nextCursor))) ||
    (value.truncated && typeof value.nextCursor !== "string") ||
    (!value.truncated && value.nextCursor !== undefined)
  ) {
    throw new Error("Resposta da fila global inválida");
  }
  const seen = new Set<string>();
  const items = value.items.map((candidate) => {
    const item = parseItem(candidate);
    const key = `${item.tenant.id}:${item.establishment.id}`;
    if (seen.has(key)) throw new Error("Item duplicado na fila global");
    seen.add(key);
    return item;
  });
  return {
    items,
    truncated: value.truncated,
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
  };
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isInteger(value) && value > 0 && value <= 3600
    ? value
    : undefined;
}

export const browserPlatformConsoleClient: PlatformConsoleClient = {
  async loadQueue({ cursor, reasonTicket, signal }) {
    if (!PLATFORM_REASON_TICKET_PATTERN.test(reasonTicket)) {
      throw new PlatformConsoleClientError(400, "INVALID_PLATFORM_REQUEST");
    }
    const parameters = new URLSearchParams({ limit: "50" });
    if (cursor) parameters.set("cursor", cursor);
    let response: Response;
    try {
      response = await fetch(
        `/api/platform/renave-link-queue?${parameters.toString()}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "x-renave-reason-ticket": reasonTicket,
          },
          redirect: "error",
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new PlatformConsoleClientError(0, "NETWORK_ERROR");
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new PlatformConsoleClientError(
        response.status,
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : undefined,
        retryAfterSeconds(response),
      );
    }
    try {
      return parsePage(value);
    } catch {
      throw new PlatformConsoleClientError(0, "INVALID_RESPONSE");
    }
  },
};
