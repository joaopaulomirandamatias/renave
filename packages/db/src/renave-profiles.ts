import type { TenantClient } from "./tenant-context.js";

export const renaveProfileStatuses = [
  "pending",
  "verified",
  "suspended",
] as const;

export type RenaveProfileStatusValue = (typeof renaveProfileStatuses)[number];

interface ProfileStatusRow {
  profile_status: RenaveProfileStatusValue;
}

interface VerifiedPrincipalRow {
  active_tenant_id: string;
  establishment_email_hmac: Buffer;
  establishment_envelope_aad_sha256: Buffer;
  establishment_envelope_auth_tag: Buffer;
  establishment_envelope_ciphertext: Buffer;
  establishment_envelope_key_id: string;
  establishment_envelope_nonce: Buffer;
  establishment_envelope_schema_version: number;
  establishment_hmac_key_id: string;
  establishment_profile_id: string;
  operator_envelope_aad_sha256: Buffer;
  operator_envelope_auth_tag: Buffer;
  operator_envelope_ciphertext: Buffer;
  operator_envelope_key_id: string;
  operator_envelope_nonce: Buffer;
  operator_envelope_schema_version: number;
  operator_hmac_key_id: string;
  operator_identity_hmac: Buffer;
  operator_profile_id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RenaveProfileInputError extends Error {
  override name = "RenaveProfileInputError";
}

export class RenavePrincipalResolutionUnavailableError extends Error {
  override name = "RenavePrincipalResolutionUnavailableError";

  constructor() {
    super("Os perfis RENAVE verificados não estão disponíveis.");
  }
}

export class RenavePrincipalResolutionStorageError extends Error {
  override name = "RenavePrincipalResolutionStorageError";

  constructor() {
    super("Não foi possível resolver os perfis RENAVE verificados.");
  }
}

export interface ResolvedRenavePrincipalEnvelope {
  aadSha256: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  envelopeSchemaVersion: 1;
  hmac: {
    digest: Buffer;
    hmacKeyId: string;
  };
  keyId: string;
  nonce: Buffer;
}

export interface ResolvedVerifiedRenavePrincipals {
  establishment: {
    binding: {
      establishmentId: string;
      profileId: string;
      purpose: "establishment-email";
      tenantId: string;
    };
    envelope: ResolvedRenavePrincipalEnvelope;
  };
  operator: {
    binding: {
      profileId: string;
      purpose: "operator-cpf";
      subject: string;
      tenantId: string;
    };
    envelope: ResolvedRenavePrincipalEnvelope;
  };
}

function assertSubject(subject: unknown): asserts subject is string {
  if (
    typeof subject !== "string" ||
    subject.trim() !== subject ||
    subject.length === 0 ||
    subject.length > 255
  ) {
    throw new RenaveProfileInputError("Subject OIDC inválido.");
  }
}

function assertEstablishmentId(
  establishmentId: unknown,
): asserts establishmentId is string {
  if (
    typeof establishmentId !== "string" ||
    !UUID_PATTERN.test(establishmentId)
  ) {
    throw new RenaveProfileInputError("Estabelecimento inválido.");
  }
}

/**
 * Retorna somente metadados de prontidão. CPF, HMAC, origem e envelope nunca
 * atravessam esta fronteira de status.
 */
export async function getOperatorIdentityProfileStatus(
  client: TenantClient,
  subject: string,
): Promise<RenaveProfileStatusValue | null> {
  assertSubject(subject);
  const { rows } = await client.query<ProfileStatusRow>(
    `select profile_status
       from renave.get_operator_identity_profile_status($1)`,
    [subject],
  );
  return rows[0]?.profile_status ?? null;
}

/** Retorna somente o estado sanitizado do contato RENAVE da loja. */
export async function getEstablishmentRenaveProfileStatus(
  client: TenantClient,
  establishmentId: string,
): Promise<RenaveProfileStatusValue | null> {
  assertEstablishmentId(establishmentId);
  const { rows } = await client.query<ProfileStatusRow>(
    `select profile_status
       from renave.get_establishment_renave_profile_status($1)`,
    [establishmentId],
  );
  return rows[0]?.profile_status ?? null;
}

function isBuffer(value: unknown, size: number): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === size;
}

function isBucket(value: unknown, size: 128 | 512): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === size;
}

function isKeyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
  );
}

function mapEnvelope(
  row: VerifiedPrincipalRow,
  prefix: "establishment" | "operator",
): ResolvedRenavePrincipalEnvelope {
  const schemaVersion = row[`${prefix}_envelope_schema_version`];
  const keyId = row[`${prefix}_envelope_key_id`];
  const nonce = row[`${prefix}_envelope_nonce`];
  const authTag = row[`${prefix}_envelope_auth_tag`];
  const ciphertext = row[`${prefix}_envelope_ciphertext`];
  const aadSha256 = row[`${prefix}_envelope_aad_sha256`];
  const hmacKeyId = row[`${prefix}_hmac_key_id`];
  const digest =
    prefix === "operator"
      ? row.operator_identity_hmac
      : row.establishment_email_hmac;
  const expectedCiphertextSize = prefix === "operator" ? 128 : 512;

  if (
    schemaVersion !== 1 ||
    !isKeyId(keyId) ||
    !isBuffer(nonce, 12) ||
    !isBuffer(authTag, 16) ||
    !isBucket(ciphertext, expectedCiphertextSize) ||
    !isBuffer(aadSha256, 32) ||
    !isKeyId(hmacKeyId) ||
    !isBuffer(digest, 32)
  ) {
    throw new RenavePrincipalResolutionStorageError();
  }

  return {
    aadSha256: Buffer.from(aadSha256),
    authTag: Buffer.from(authTag),
    ciphertext: Buffer.from(ciphertext),
    envelopeSchemaVersion: 1,
    hmac: {
      digest: Buffer.from(digest),
      hmacKeyId,
    },
    keyId,
    nonce: Buffer.from(nonce),
  };
}

/**
 * Resolve somente envelopes verificados sob os locks da transação ativa.
 * O chamador deve decriptar e criar HELD_LOCAL antes do COMMIT.
 */
export async function resolveVerifiedRenavePrincipals(
  client: TenantClient,
  input: {
    establishmentId: string;
    idempotencyKeyDigest: Buffer;
    subject: string;
  },
): Promise<ResolvedVerifiedRenavePrincipals> {
  assertSubject(input.subject);
  assertEstablishmentId(input.establishmentId);
  if (
    !Buffer.isBuffer(input.idempotencyKeyDigest) ||
    input.idempotencyKeyDigest.byteLength !== 32
  ) {
    throw new RenaveProfileInputError("Digest de idempotência inválido.");
  }
  const idempotencyKeyDigest = Buffer.from(input.idempotencyKeyDigest);

  let row: VerifiedPrincipalRow | undefined;
  try {
    const result = await client.query<VerifiedPrincipalRow>(
      `select *
         from renave.resolve_verified_renave_principals($1, $2, $3)`,
      [input.subject, input.establishmentId, idempotencyKeyDigest],
    );
    row = result.rows[0];
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (
      candidate.code === "42501" &&
      candidate.message === "renave principals: indisponíveis"
    ) {
      throw new RenavePrincipalResolutionUnavailableError();
    }
    throw new RenavePrincipalResolutionStorageError();
  } finally {
    idempotencyKeyDigest.fill(0);
  }

  if (
    !row ||
    !UUID_PATTERN.test(row.active_tenant_id) ||
    !UUID_PATTERN.test(row.operator_profile_id) ||
    !UUID_PATTERN.test(row.establishment_profile_id)
  ) {
    throw new RenavePrincipalResolutionStorageError();
  }

  const tenantId = row.active_tenant_id.toLowerCase();
  return {
    establishment: {
      binding: {
        establishmentId: input.establishmentId.toLowerCase(),
        profileId: row.establishment_profile_id.toLowerCase(),
        purpose: "establishment-email",
        tenantId,
      },
      envelope: mapEnvelope(row, "establishment"),
    },
    operator: {
      binding: {
        profileId: row.operator_profile_id.toLowerCase(),
        purpose: "operator-cpf",
        subject: input.subject,
        tenantId,
      },
      envelope: mapEnvelope(row, "operator"),
    },
  };
}
