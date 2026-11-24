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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RenaveProfileInputError extends Error {
  override name = "RenaveProfileInputError";
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
 * atravessam esta fronteira; a resolução será introduzida com a operação.
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
