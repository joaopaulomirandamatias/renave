import type { Pool } from "pg";

export interface PlatformConsoleRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class PlatformConsoleRateLimitContractError extends Error {
  readonly code = "PLATFORM_CONSOLE_RATE_LIMIT_CONTRACT_REJECTED";
  override name = "PlatformConsoleRateLimitContractError";

  constructor() {
    super("O limitador do console global não satisfez o contrato esperado");
  }
}

export async function acquirePlatformConsolePermit(
  pool: Pool,
  actorDigest: Buffer,
): Promise<PlatformConsoleRateLimitDecision> {
  if (!Buffer.isBuffer(actorDigest) || actorDigest.byteLength !== 32) {
    throw new PlatformConsoleRateLimitContractError();
  }
  const result = await pool.query<{
    allowed: boolean;
    retry_after_seconds: number;
  }>(
    `select allowed,retry_after_seconds
       from renave_runtime.acquire_platform_console_permit($1)`,
    [actorDigest],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    typeof row?.allowed !== "boolean" ||
    !Number.isInteger(row.retry_after_seconds) ||
    row.retry_after_seconds < 0 ||
    row.retry_after_seconds > 60 ||
    (row.allowed && row.retry_after_seconds !== 0) ||
    (!row.allowed && row.retry_after_seconds < 1)
  ) {
    throw new PlatformConsoleRateLimitContractError();
  }
  return {
    allowed: row.allowed,
    retryAfterSeconds: row.retry_after_seconds,
  };
}
