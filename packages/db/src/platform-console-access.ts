import type { Pool } from "pg";

interface PlatformAccessRow {
  authorized: unknown;
}

export class PlatformAccessContractError extends Error {
  readonly code = "PLATFORM_ACCESS_CONTRACT_REJECTED";
  override name = "PlatformAccessContractError";

  constructor() {
    super("A capability global não satisfez o contrato esperado");
  }
}

/**
 * Consulta somente a decisão booleana da função SECURITY DEFINER. Nenhum dado
 * do grant atravessa esta fronteira e a leitura da fila continua reautorizando.
 */
export async function authorizePlatformConsoleAccess(
  pool: Pool,
  actorDigest: Buffer,
): Promise<boolean> {
  if (!Buffer.isBuffer(actorDigest) || actorDigest.byteLength !== 32) {
    throw new PlatformAccessContractError();
  }

  const { rows } = await pool.query<PlatformAccessRow>(
    `select renave_platform.is_platform_operator_authorized($1) as authorized`,
    [actorDigest],
  );
  if (rows.length !== 1 || typeof rows[0]?.authorized !== "boolean") {
    throw new PlatformAccessContractError();
  }
  return rows[0].authorized;
}
