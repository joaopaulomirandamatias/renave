import type {
  IdentityPurgeResult,
  PostgresIdentitySessionStore,
} from "./session-store.js";

export interface IdentityPurgeBacklogResult extends IdentityPurgeResult {
  backlogMayRemain: boolean;
  batches: number;
}

export interface IdentityPurgeBacklogOptions {
  batchSize?: number;
  maxBatches?: number;
  maxDurationMs?: number;
  now?: () => number;
}

/** Drena lotes cheios sem permitir que uma execução monopolize o banco. */
export async function purgeExpiredIdentityBacklog(
  store: Pick<PostgresIdentitySessionStore, "purgeExpiredRecords">,
  options: IdentityPurgeBacklogOptions = {},
): Promise<IdentityPurgeBacklogResult> {
  const batchSize = options.batchSize ?? 1_000;
  const maxBatches = options.maxBatches ?? 100;
  const maxDurationMs = options.maxDurationMs ?? 10_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000) {
    throw new Error("maxBatches deve ser um inteiro entre 1 e 10000.");
  }
  if (
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 300_000
  ) {
    throw new Error("maxDurationMs deve ser um inteiro entre 1 e 300000.");
  }

  const deadline = now() + maxDurationMs;
  let loginAttemptsDeleted = 0;
  let sessionsDeleted = 0;
  let batches = 0;
  let backlogMayRemain = false;
  do {
    const result = await store.purgeExpiredRecords(batchSize);
    loginAttemptsDeleted += result.loginAttemptsDeleted;
    sessionsDeleted += result.sessionsDeleted;
    batches += 1;
    backlogMayRemain =
      result.loginAttemptsDeleted === batchSize ||
      result.sessionsDeleted === batchSize;
  } while (backlogMayRemain && batches < maxBatches && now() < deadline);

  return {
    loginAttemptsDeleted,
    sessionsDeleted,
    batches,
    backlogMayRemain,
  };
}
