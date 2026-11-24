import type { QueryResult, QueryResultRow } from "pg";
import { PROFILE_PROVISIONER_ROLE, PROFILE_READER_ROLE } from "./config.js";

interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface ProfileEnvelopeInput {
  schemaVersion: number;
  keyId: string;
  nonce: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
  aadSha256: Uint8Array;
}

export interface KeyedDigestInput {
  digest: Uint8Array;
  keyId: string;
}

export interface StageOperatorRenaveProfileInput {
  tenantId: string;
  subject: string;
  profileId: string;
  hmacKeyId: string;
  identityHmac: Uint8Array;
  envelope: ProfileEnvelopeInput;
  assertion: KeyedDigestInput;
  changedBy: KeyedDigestInput;
}

export interface StageEstablishmentRenaveProfileInput {
  tenantId: string;
  establishmentId: string;
  profileId: string;
  hmacKeyId: string;
  emailHmac: Uint8Array;
  envelope: ProfileEnvelopeInput;
  assertion: KeyedDigestInput;
  changedBy: KeyedDigestInput;
}

export interface SuspendOperatorRenaveProfileInput {
  tenantId: string;
  subject: string;
  expectedVersion: number;
  reason: KeyedDigestInput;
  request: KeyedDigestInput;
  changedBy: KeyedDigestInput;
}

export interface SuspendEstablishmentRenaveProfileInput {
  tenantId: string;
  establishmentId: string;
  expectedVersion: number;
  reason: KeyedDigestInput;
  request: KeyedDigestInput;
  changedBy: KeyedDigestInput;
}

export type AdminRenaveProfileStatus = "pending" | "verified" | "suspended";

export interface RenaveProfileAdministrationResult {
  profileId: string;
  status: "pending" | "suspended";
  version: number;
  replayed: boolean;
}

export interface AdminRenaveProfileStatusResult {
  profileId: string;
  status: AdminRenaveProfileStatus;
  version: number;
  updatedAt: Date;
}

interface AdministrationRow {
  profile_id: string;
  profile_status: string;
  profile_version: string;
  replayed: boolean;
}

interface StatusRow {
  profile_id: string;
  profile_status: string;
  profile_version: string;
  updated_at: Date;
}

export class RenaveProfileAdministrationContractError extends Error {
  override name = "RenaveProfileAdministrationContractError";
}

function toBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function wipeBuffers(values: Buffer[]): void {
  for (const value of values) value.fill(0);
}

function mapMutationRow(
  row: AdministrationRow | undefined,
  expectedStatus: "pending" | "suspended",
): RenaveProfileAdministrationResult {
  if (!row || row.profile_status !== expectedStatus) {
    throw new RenaveProfileAdministrationContractError(
      "Resposta inválida da rotina de administração RENAVE.",
    );
  }
  const version = Number(row.profile_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RenaveProfileAdministrationContractError(
      "Versão inválida retornada pela rotina de administração RENAVE.",
    );
  }
  return {
    profileId: row.profile_id,
    status: expectedStatus,
    version,
    replayed: row.replayed,
  };
}

function mapStatusRow(
  row: StatusRow | undefined,
): AdminRenaveProfileStatusResult | null {
  if (!row) return null;
  if (
    !(["pending", "verified", "suspended"] as const).includes(
      row.profile_status as AdminRenaveProfileStatus,
    )
  ) {
    throw new RenaveProfileAdministrationContractError(
      "Status inválido retornado pela rotina de administração RENAVE.",
    );
  }
  const version = Number(row.profile_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RenaveProfileAdministrationContractError(
      "Versão inválida retornada pela rotina de administração RENAVE.",
    );
  }
  return {
    profileId: row.profile_id,
    status: row.profile_status as AdminRenaveProfileStatus,
    version,
    updatedAt: row.updated_at,
  };
}

async function assertProfileSession(
  database: Queryable,
  expectedRole: typeof PROFILE_PROVISIONER_ROLE | typeof PROFILE_READER_ROLE,
): Promise<void> {
  const result = await database.query<{
    current_role: string;
    session_role: string;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolsuper: boolean;
  }>(
    `select current_user as current_role, session_user as session_role,
            role.rolbypassrls,role.rolcreatedb,role.rolcreaterole,
            role.rolinherit,role.rolreplication,role.rolsuper
       from pg_catalog.pg_roles role
      where role.rolname=session_user`,
  );
  const row = result.rows[0];
  if (
    row?.current_role !== expectedRole ||
    row.session_role !== expectedRole ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolinherit ||
    row.rolreplication
  ) {
    throw new RenaveProfileAdministrationContractError(
      `Conexão deve usar exclusivamente o papel ${expectedRole}.`,
    );
  }
}

export async function assertProfileProvisionerSession(
  database: Queryable,
): Promise<void> {
  await assertProfileSession(database, PROFILE_PROVISIONER_ROLE);
}

export async function assertProfileReaderSession(
  database: Queryable,
): Promise<void> {
  await assertProfileSession(database, PROFILE_READER_ROLE);
}

export async function stageOperatorRenaveProfile(
  database: Queryable,
  input: StageOperatorRenaveProfileInput,
): Promise<RenaveProfileAdministrationResult> {
  const sensitive = [
    input.identityHmac,
    input.envelope.nonce,
    input.envelope.authTag,
    input.envelope.ciphertext,
    input.envelope.aadSha256,
    input.assertion.digest,
    input.changedBy.digest,
  ].map(toBuffer);
  try {
    const result = await database.query<AdministrationRow>(
      `select * from renave_admin.stage_operator_pending(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )`,
      [
        input.tenantId,
        input.subject,
        input.profileId,
        input.hmacKeyId,
        sensitive[0],
        input.envelope.schemaVersion,
        input.envelope.keyId,
        sensitive[1],
        sensitive[2],
        sensitive[3],
        sensitive[4],
        sensitive[5],
        input.assertion.keyId,
        sensitive[6],
        input.changedBy.keyId,
      ],
    );
    return mapMutationRow(result.rows[0], "pending");
  } finally {
    wipeBuffers(sensitive);
  }
}

export async function stageEstablishmentRenaveProfile(
  database: Queryable,
  input: StageEstablishmentRenaveProfileInput,
): Promise<RenaveProfileAdministrationResult> {
  const sensitive = [
    input.emailHmac,
    input.envelope.nonce,
    input.envelope.authTag,
    input.envelope.ciphertext,
    input.envelope.aadSha256,
    input.assertion.digest,
    input.changedBy.digest,
  ].map(toBuffer);
  try {
    const result = await database.query<AdministrationRow>(
      `select * from renave_admin.stage_establishment_pending(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )`,
      [
        input.tenantId,
        input.establishmentId,
        input.profileId,
        input.hmacKeyId,
        sensitive[0],
        input.envelope.schemaVersion,
        input.envelope.keyId,
        sensitive[1],
        sensitive[2],
        sensitive[3],
        sensitive[4],
        sensitive[5],
        input.assertion.keyId,
        sensitive[6],
        input.changedBy.keyId,
      ],
    );
    return mapMutationRow(result.rows[0], "pending");
  } finally {
    wipeBuffers(sensitive);
  }
}

export async function suspendOperatorRenaveProfile(
  database: Queryable,
  input: SuspendOperatorRenaveProfileInput,
): Promise<RenaveProfileAdministrationResult> {
  const sensitive = [
    input.reason.digest,
    input.request.digest,
    input.changedBy.digest,
  ].map(toBuffer);
  try {
    const result = await database.query<AdministrationRow>(
      `select * from renave_admin.suspend_operator($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.tenantId,
        input.subject,
        input.expectedVersion,
        sensitive[0],
        input.reason.keyId,
        sensitive[1],
        input.request.keyId,
        sensitive[2],
        input.changedBy.keyId,
      ],
    );
    return mapMutationRow(result.rows[0], "suspended");
  } finally {
    wipeBuffers(sensitive);
  }
}

export async function suspendEstablishmentRenaveProfile(
  database: Queryable,
  input: SuspendEstablishmentRenaveProfileInput,
): Promise<RenaveProfileAdministrationResult> {
  const sensitive = [
    input.reason.digest,
    input.request.digest,
    input.changedBy.digest,
  ].map(toBuffer);
  try {
    const result = await database.query<AdministrationRow>(
      `select * from renave_admin.suspend_establishment($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.tenantId,
        input.establishmentId,
        input.expectedVersion,
        sensitive[0],
        input.reason.keyId,
        sensitive[1],
        input.request.keyId,
        sensitive[2],
        input.changedBy.keyId,
      ],
    );
    return mapMutationRow(result.rows[0], "suspended");
  } finally {
    wipeBuffers(sensitive);
  }
}

export async function getAdminOperatorRenaveProfileStatus(
  database: Queryable,
  tenantId: string,
  subject: string,
): Promise<AdminRenaveProfileStatusResult | null> {
  const result = await database.query<StatusRow>(
    "select * from renave_admin.get_operator_status($1,$2)",
    [tenantId, subject],
  );
  return mapStatusRow(result.rows[0]);
}

export async function getAdminEstablishmentRenaveProfileStatus(
  database: Queryable,
  tenantId: string,
  establishmentId: string,
): Promise<AdminRenaveProfileStatusResult | null> {
  const result = await database.query<StatusRow>(
    "select * from renave_admin.get_establishment_status($1,$2)",
    [tenantId, establishmentId],
  );
  return mapStatusRow(result.rows[0]);
}
