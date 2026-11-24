import { isIP } from "node:net";

import type { Pool } from "pg";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const PRIORITY_BY_STATUS = Object.freeze({
  pending: 0,
  confirmed: 1,
  not_started: 2,
  rejected: 3,
  deactivated: 4,
  enabled: 5,
} as const);

export type PlatformCredentialLinkStatus = keyof typeof PRIORITY_BY_STATUS;

export interface PlatformQueueCursor {
  establishmentId: string;
  priority: number;
  tenantId: string;
  updatedAt: Date;
}

export interface PlatformQueueEntry {
  establishmentId: string;
  linkStatus: PlatformCredentialLinkStatus;
  tenantDisplayName: string;
  tenantId: string;
  tradeName: string;
  updatedAt: Date;
}

export type PlatformQueueResult =
  | { authorized: false }
  | {
      authorized: true;
      entries: readonly PlatformQueueEntry[];
      nextCursor?: PlatformQueueCursor;
      truncated: boolean;
    };

export interface ListPlatformQueueInput {
  actorDigest: Buffer;
  actorIp: string;
  after?: PlatformQueueCursor;
  limit: number;
  reasonTicketDigest: Buffer;
  traceDigest: Buffer;
}

interface PlatformQueueRow {
  authorized: boolean;
  cursor_priority: number | null;
  establishment_id: string | null;
  link_status: string | null;
  link_updated_at: Date | string | null;
  tenant_display_name: string | null;
  tenant_id: string | null;
  trade_name: string | null;
  truncated: boolean;
}

export class PlatformQueueContractError extends Error {
  readonly code = "PLATFORM_QUEUE_CONTRACT_REJECTED";
  override name = "PlatformQueueContractError";

  constructor() {
    super("A fila global não satisfez o contrato esperado");
  }
}

function validDigest(value: Buffer): boolean {
  return Buffer.isBuffer(value) && value.byteLength === 32;
}

function validCursor(value: PlatformQueueCursor): boolean {
  return (
    UUID_PATTERN.test(value.tenantId) &&
    UUID_PATTERN.test(value.establishmentId) &&
    Number.isInteger(value.priority) &&
    value.priority >= 0 &&
    value.priority <= 5 &&
    value.updatedAt instanceof Date &&
    Number.isFinite(value.updatedAt.getTime())
  );
}

function emptyRow(row: PlatformQueueRow): boolean {
  return (
    row.cursor_priority === null &&
    row.establishment_id === null &&
    row.link_status === null &&
    row.link_updated_at === null &&
    row.tenant_display_name === null &&
    row.tenant_id === null &&
    row.trade_name === null
  );
}

function date(value: Date | string): Date {
  const parsed = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(parsed.getTime()))
    throw new PlatformQueueContractError();
  return parsed;
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Adaptador mínimo da função SECURITY DEFINER. Toda decisão continua no banco;
 * o mapper recusa sentinelas misturados ou linhas parciais para nunca devolver
 * uma página ambígua ao operador global.
 */
export async function listPlatformCredentialLinkQueue(
  pool: Pool,
  input: ListPlatformQueueInput,
): Promise<PlatformQueueResult> {
  if (
    !validDigest(input.actorDigest) ||
    !validDigest(input.reasonTicketDigest) ||
    !validDigest(input.traceDigest) ||
    isIP(input.actorIp) === 0 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined && !validCursor(input.after))
  ) {
    throw new PlatformQueueContractError();
  }

  const after = input.after;
  const { rows } = await pool.query<PlatformQueueRow>(
    `select authorized, tenant_id, tenant_display_name, establishment_id,
            trade_name, link_status, link_updated_at, cursor_priority, truncated
       from renave_platform.list_credential_link_queue(
         $1,$2,$3,$4,$5,$6,$7,$8,$9
       )`,
    [
      input.actorDigest,
      input.reasonTicketDigest,
      input.actorIp,
      input.traceDigest,
      after?.priority ?? null,
      after?.updatedAt ?? null,
      after?.tenantId ?? null,
      after?.establishmentId ?? null,
      input.limit,
    ],
  );

  if (
    rows.some(
      (row) =>
        typeof row.authorized !== "boolean" ||
        typeof row.truncated !== "boolean",
    )
  ) {
    throw new PlatformQueueContractError();
  }
  if (rows.length === 1 && emptyRow(rows[0]!)) {
    if (rows[0]!.truncated) throw new PlatformQueueContractError();
    return rows[0]!.authorized
      ? { authorized: true, entries: [], truncated: false }
      : { authorized: false };
  }
  if (
    rows.length === 0 ||
    rows.length > input.limit ||
    rows.some((row) => !row.authorized || emptyRow(row))
  ) {
    throw new PlatformQueueContractError();
  }
  const truncated = rows[0]!.truncated;
  if (rows.some((row) => row.truncated !== truncated)) {
    throw new PlatformQueueContractError();
  }

  const entries = rows.map((row): PlatformQueueEntry => {
    const status = row.link_status as PlatformCredentialLinkStatus;
    if (
      row.tenant_id === null ||
      !UUID_PATTERN.test(row.tenant_id) ||
      row.establishment_id === null ||
      !UUID_PATTERN.test(row.establishment_id) ||
      row.tenant_display_name === null ||
      !validName(row.tenant_display_name) ||
      row.trade_name === null ||
      !validName(row.trade_name) ||
      row.link_updated_at === null ||
      row.cursor_priority !== PRIORITY_BY_STATUS[status]
    ) {
      throw new PlatformQueueContractError();
    }
    return {
      tenantId: row.tenant_id,
      tenantDisplayName: row.tenant_display_name,
      establishmentId: row.establishment_id,
      tradeName: row.trade_name,
      linkStatus: status,
      updatedAt: date(row.link_updated_at),
    };
  });
  const lastRow = rows.at(-1)!;
  const lastEntry = entries.at(-1)!;
  return {
    authorized: true,
    entries,
    truncated,
    ...(truncated
      ? {
          nextCursor: {
            establishmentId: lastEntry.establishmentId,
            priority: lastRow.cursor_priority!,
            tenantId: lastEntry.tenantId,
            updatedAt: lastEntry.updatedAt,
          },
        }
      : {}),
  };
}
