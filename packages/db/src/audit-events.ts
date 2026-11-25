import type { TenantClient } from "./tenant-context.js";

export const AUDIT_OUTCOMES = [
  "attempted",
  "succeeded",
  "rejected",
  "outcome_unknown",
  "reconciled",
  "manual_review",
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditEvent {
  action: string;
  actorIp: string;
  actorSubject: string;
  certificateThumbprintSha256: string | null;
  chainPosition: string;
  cnpjConfirmed: string | null;
  cnpjSent: string | null;
  establishmentId: string;
  eventHash: string;
  id: string;
  integratorCnpjConfirmed: string | null;
  occurredAt: Date;
  outcome: AuditOutcome;
  payloadReference: string | null;
  previousHash: string;
  requestSha256: string | null;
  responseSha256: string | null;
  sequence: string;
  tenantId: string;
  traceId: string | null;
}

export interface AppendAuditEventInput {
  action: string;
  actorIp: string;
  actorSubject: string;
  certificateThumbprintSha256?: string;
  cnpjConfirmed?: string;
  cnpjSent?: string;
  establishmentId: string;
  integratorCnpjConfirmed?: string;
  outcome: AuditOutcome;
  payloadReference?: string;
  requestSha256?: string;
  responseSha256?: string;
  traceId?: string;
}

interface AuditEventRow {
  action: string;
  actor_ip: string;
  actor_subject: string;
  certificate_thumbprint_sha256: string | null;
  chain_position: string;
  cnpj_confirmed: string | null;
  cnpj_sent: string | null;
  establishment_id: string;
  event_hash: string;
  id: string;
  integrator_cnpj_confirmed: string | null;
  occurred_at: Date;
  outcome: AuditOutcome;
  payload_reference: string | null;
  previous_hash: string;
  request_sha256: string | null;
  response_sha256: string | null;
  sequence: string;
  tenant_id: string;
  trace_id: string | null;
}

const COLUMNS = `sequence, chain_position, id, tenant_id, establishment_id, occurred_at,
  actor_subject, actor_ip::text as actor_ip, action, outcome, cnpj_sent,
  cnpj_confirmed, integrator_cnpj_confirmed, request_sha256, response_sha256,
  certificate_thumbprint_sha256, payload_reference, trace_id, previous_hash,
  event_hash`;

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    action: row.action,
    actorIp: row.actor_ip,
    actorSubject: row.actor_subject,
    certificateThumbprintSha256: row.certificate_thumbprint_sha256,
    chainPosition: row.chain_position,
    cnpjConfirmed: row.cnpj_confirmed,
    cnpjSent: row.cnpj_sent,
    establishmentId: row.establishment_id,
    eventHash: row.event_hash,
    id: row.id,
    integratorCnpjConfirmed: row.integrator_cnpj_confirmed,
    occurredAt: row.occurred_at,
    outcome: row.outcome,
    payloadReference: row.payload_reference,
    previousHash: row.previous_hash,
    requestSha256: row.request_sha256,
    responseSha256: row.response_sha256,
    sequence: row.sequence,
    tenantId: row.tenant_id,
    traceId: row.trace_id,
  };
}

export async function appendAuditEvent(
  client: TenantClient,
  input: AppendAuditEventInput,
): Promise<AuditEvent> {
  const { rows } = await client.query<AuditEventRow>(
    `insert into renave.audit_event (
       tenant_id, establishment_id, actor_subject, actor_ip, action, outcome,
       cnpj_sent, cnpj_confirmed, integrator_cnpj_confirmed, request_sha256,
       response_sha256, certificate_thumbprint_sha256, payload_reference, trace_id
     ) values (
       renave.current_tenant_id(), $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13
     ) returning ${COLUMNS}`,
    [
      input.establishmentId,
      input.actorSubject,
      input.actorIp,
      input.action,
      input.outcome,
      input.cnpjSent ?? null,
      input.cnpjConfirmed ?? null,
      input.integratorCnpjConfirmed ?? null,
      input.requestSha256 ?? null,
      input.responseSha256 ?? null,
      input.certificateThumbprintSha256 ?? null,
      input.payloadReference ?? null,
      input.traceId ?? null,
    ],
  );
  return toAuditEvent(rows[0]!);
}

export async function listAuditEvents(
  client: TenantClient,
): Promise<AuditEvent[]> {
  const { rows } = await client.query<AuditEventRow>(
    `select ${COLUMNS} from renave.audit_event order by chain_position`,
  );
  return rows.map(toAuditEvent);
}

export async function verifyAuditChain(client: TenantClient): Promise<boolean> {
  const { rows } = await client.query<{ valid: boolean }>(
    "select renave.verify_current_tenant_audit_chain() as valid",
  );
  return rows[0]?.valid === true;
}

const AUDIT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{2,99}$/u;
const AUDIT_OUTCOME_SET = new Set<string>(AUDIT_OUTCOMES);
const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 50;

export interface TenantAuditEventItem {
  action: string;
  entityType: string;
  establishmentId: string;
  eventHashPrefix: string;
  occurredAt: string;
  outcome: AuditOutcome;
  sequence: number;
  traceId: string | null;
}

export interface ListTenantAuditEventsInput {
  action?: string;
  allowedEstablishmentIds?: readonly string[];
  beforeSequence?: number;
  establishmentId?: string;
  limit?: number;
  outcome?: AuditOutcome;
}

export interface TenantAuditEventsPage {
  hasMore: boolean;
  items: readonly TenantAuditEventItem[];
  nextBeforeSequence?: number;
}

export class TenantAuditQueryInputError extends Error {
  readonly code = "TENANT_AUDIT_QUERY_INVALID";

  constructor() {
    super("Parâmetros inválidos para consulta da trilha de auditoria");
    this.name = "TenantAuditQueryInputError";
  }
}

interface TenantAuditEventSummaryRow {
  action: string;
  establishment_id: string;
  event_hash_prefix: string;
  occurred_at: Date | string;
  outcome: AuditOutcome;
  sequence: string | number;
  trace_id: string | null;
}

function deriveAuditEntityType(action: string): string {
  const dotIndex = action.indexOf(".");
  return dotIndex > 0 ? action.slice(0, dotIndex) : action;
}

function normalizeAuditUuid(value: unknown): string {
  if (typeof value !== "string" || !AUDIT_UUID_PATTERN.test(value)) {
    throw new TenantAuditQueryInputError();
  }
  return value.toLowerCase();
}

export async function listTenantAuditEvents(
  client: TenantClient,
  input: ListTenantAuditEventsInput = {},
): Promise<TenantAuditEventsPage> {
  const limit = input.limit ?? DEFAULT_AUDIT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
    throw new TenantAuditQueryInputError();
  }

  let beforeSequence: number | undefined;
  if (input.beforeSequence !== undefined) {
    if (
      !Number.isSafeInteger(input.beforeSequence) ||
      input.beforeSequence <= 0
    ) {
      throw new TenantAuditQueryInputError();
    }
    beforeSequence = input.beforeSequence;
  }

  let establishmentId: string | undefined;
  if (input.establishmentId !== undefined) {
    establishmentId = normalizeAuditUuid(input.establishmentId);
  }

  let allowedEstablishmentIds: string[] | undefined;
  if (input.allowedEstablishmentIds !== undefined) {
    if (!Array.isArray(input.allowedEstablishmentIds)) {
      throw new TenantAuditQueryInputError();
    }
    allowedEstablishmentIds = [
      ...new Set(input.allowedEstablishmentIds.map(normalizeAuditUuid)),
    ];
    if (allowedEstablishmentIds.length === 0) {
      return { hasMore: false, items: [] };
    }
    if (
      establishmentId !== undefined &&
      !allowedEstablishmentIds.includes(establishmentId)
    ) {
      return { hasMore: false, items: [] };
    }
  }

  let action: string | undefined;
  if (input.action !== undefined) {
    if (
      typeof input.action !== "string" ||
      !AUDIT_ACTION_PATTERN.test(input.action)
    ) {
      throw new TenantAuditQueryInputError();
    }
    action = input.action;
  }

  let outcome: AuditOutcome | undefined;
  if (input.outcome !== undefined) {
    if (
      typeof input.outcome !== "string" ||
      !AUDIT_OUTCOME_SET.has(input.outcome)
    ) {
      throw new TenantAuditQueryInputError();
    }
    outcome = input.outcome;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const pushParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (beforeSequence !== undefined) {
    conditions.push(`sequence < ${pushParam(beforeSequence)}`);
  }
  if (establishmentId !== undefined) {
    conditions.push(`establishment_id = ${pushParam(establishmentId)}`);
  } else if (allowedEstablishmentIds !== undefined) {
    conditions.push(
      `establishment_id = any(${pushParam(allowedEstablishmentIds)}::uuid[])`,
    );
  }
  if (action !== undefined) {
    conditions.push(`action = ${pushParam(action)}`);
  }
  if (outcome !== undefined) {
    conditions.push(`outcome = ${pushParam(outcome)}`);
  }

  const limitParam = pushParam(limit + 1);
  const whereClause =
    conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  const { rows } = await client.query<TenantAuditEventSummaryRow>(
    `select
       sequence,
       action,
       outcome,
       establishment_id,
       occurred_at,
       trace_id,
       pg_catalog.left(event_hash, 12) as event_hash_prefix
     from renave.audit_event
     ${whereClause}
     order by sequence desc
     limit ${limitParam}`,
    params,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items: TenantAuditEventItem[] = pageRows.map((row) => {
    const sequence = Number(row.sequence);
    const occurredAt =
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString();
    return {
      action: row.action,
      entityType: deriveAuditEntityType(row.action),
      establishmentId: row.establishment_id,
      eventHashPrefix: row.event_hash_prefix.slice(0, 12),
      occurredAt,
      outcome: row.outcome,
      sequence,
      traceId: row.trace_id,
    };
  });

  const last = items[items.length - 1];
  return {
    hasMore,
    items,
    ...(hasMore && last !== undefined
      ? { nextBeforeSequence: last.sequence }
      : {}),
  };
}
