import type { TenantClient } from "./tenant-context.js";

export type AuditOutcome =
  | "attempted"
  | "succeeded"
  | "rejected"
  | "outcome_unknown"
  | "reconciled"
  | "manual_review";

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
