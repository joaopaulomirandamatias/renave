import { createHash } from "node:crypto";

import type { TenantClient } from "./tenant-context.js";

export const credentialLinkStatuses = [
  "pending",
  "confirmed",
  "enabled",
  "deactivated",
  "rejected",
] as const;

export const credentialLinkSources = [
  "manual",
  "serpro_preflight",
  "system",
] as const;

export type CredentialLinkStatus = (typeof credentialLinkStatuses)[number];
export type CredentialLinkSource = (typeof credentialLinkSources)[number];

export interface CredentialLink {
  establishmentId: string;
  status: CredentialLinkStatus;
  tenantId: string;
  updatedAt: Date;
  version: string;
}

export interface CredentialLinkHistoryEntry {
  changedAt: Date;
  changedBySubjectHash: string;
  establishmentId: string;
  id: string;
  previousStatus: CredentialLinkStatus | null;
  reason: string | null;
  source: CredentialLinkSource;
  status: CredentialLinkStatus;
  tenantId: string;
  version: string;
}

export interface TransitionCredentialLinkInput {
  changedBySubject: string;
  establishmentId: string;
  reason?: string;
  source: CredentialLinkSource;
  status: CredentialLinkStatus;
}

interface CredentialLinkRow {
  establishment_id: string;
  status: CredentialLinkStatus;
  tenant_id: string;
  updated_at: Date;
  version: string;
}

interface CredentialLinkHistoryRow {
  changed_at: Date;
  changed_by_subject_hash: Buffer;
  establishment_id: string;
  id: string;
  previous_status: CredentialLinkStatus | null;
  reason: string | null;
  source: CredentialLinkSource;
  status: CredentialLinkStatus;
  tenant_id: string;
  version: string;
}

const LINK_COLUMNS = "tenant_id, establishment_id, status, version, updated_at";

function subjectHash(subject: string): Buffer {
  if (
    subject.trim() !== subject ||
    subject.length === 0 ||
    subject.length > 255
  ) {
    throw new Error("Subject do ator do vínculo é inválido.");
  }
  return createHash("sha256").update(subject, "utf8").digest();
}

function toLink(row: CredentialLinkRow): CredentialLink {
  return {
    establishmentId: row.establishment_id,
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export async function getCredentialLink(
  client: TenantClient,
  establishmentId: string,
): Promise<CredentialLink | null> {
  const { rows } = await client.query<CredentialLinkRow>(
    `select ${LINK_COLUMNS}
       from renave.credential_link
      where establishment_id = $1`,
    [establishmentId],
  );
  return rows[0] ? toLink(rows[0]) : null;
}

export async function transitionCredentialLink(
  client: TenantClient,
  input: TransitionCredentialLinkInput,
): Promise<CredentialLink> {
  const actorHash = subjectHash(input.changedBySubject);
  const { rows } = await client.query<CredentialLinkRow>(
    `select tenant_id, establishment_id, status, version, updated_at
       from renave.transition_credential_link($1, $2, $3, $4, $5)`,
    [
      input.establishmentId,
      input.status,
      input.source,
      actorHash,
      input.reason ?? null,
    ],
  );
  if (!rows[0]) throw new Error("Transição de vínculo não retornou estado.");
  return toLink(rows[0]);
}

async function preflightTransition(
  client: TenantClient,
  functionName:
    | "confirm_credential_link_from_preflight"
    | "reject_credential_link_from_preflight",
  establishmentId: string,
  changedBySubject: string,
): Promise<CredentialLink> {
  const { rows } = await client.query<CredentialLinkRow>(
    `select ${LINK_COLUMNS}
       from renave.${functionName}($1, $2)`,
    [establishmentId, subjectHash(changedBySubject)],
  );
  if (!rows[0]) throw new Error("Transição de preflight não retornou estado.");
  return toLink(rows[0]);
}

export function confirmCredentialLinkFromPreflight(
  client: TenantClient,
  establishmentId: string,
  changedBySubject: string,
): Promise<CredentialLink> {
  return preflightTransition(
    client,
    "confirm_credential_link_from_preflight",
    establishmentId,
    changedBySubject,
  );
}

export function rejectCredentialLinkFromPreflight(
  client: TenantClient,
  establishmentId: string,
  changedBySubject: string,
): Promise<CredentialLink> {
  return preflightTransition(
    client,
    "reject_credential_link_from_preflight",
    establishmentId,
    changedBySubject,
  );
}

export async function listCredentialLinkHistory(
  client: TenantClient,
  establishmentId: string,
): Promise<CredentialLinkHistoryEntry[]> {
  const { rows } = await client.query<CredentialLinkHistoryRow>(
    `select id, tenant_id, establishment_id, status, version,
            previous_status, source, reason, changed_by_subject_hash, changed_at
       from renave.credential_link_history
      where establishment_id = $1
      order by version`,
    [establishmentId],
  );
  return rows.map((row) => ({
    changedAt: row.changed_at,
    changedBySubjectHash: row.changed_by_subject_hash.toString("hex"),
    establishmentId: row.establishment_id,
    id: row.id,
    previousStatus: row.previous_status,
    reason: row.reason,
    source: row.source,
    status: row.status,
    tenantId: row.tenant_id,
    version: row.version,
  }));
}
