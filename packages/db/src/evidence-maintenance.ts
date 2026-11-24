import type { Pool } from "pg";

export interface EvidenceMonitorResult {
  backlogMayRemain: boolean;
  incidentsCreated: number;
  oldestPendingAgeSeconds: number;
  scannedCount: number;
}

export interface EvidenceMonitorStatus {
  heartbeatStale: boolean;
  lastBacklogMayRemain: boolean;
  lastIncidentsCreated: number;
  lastOldestPendingAgeSeconds: number;
  lastScannedCount: number;
  lastSuccessAt: Date | null;
  openIncidentCount: number;
  secondsSinceLastSuccess: number | null;
}

interface EvidenceMonitorRow {
  backlog_may_remain: boolean;
  incidents_created: number;
  oldest_pending_age_seconds: string;
  scanned_count: number;
}

interface EvidenceMonitorStatusRow {
  heartbeat_stale: boolean;
  last_backlog_may_remain: boolean;
  last_incidents_created: number;
  last_oldest_pending_age_seconds: string;
  last_scanned_count: number;
  last_success_at: Date | null;
  open_incident_count: string;
  seconds_since_last_success: string | null;
}

export class EvidenceMonitorInputError extends Error {
  override name = "EvidenceMonitorInputError";
}

function assertIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new EvidenceMonitorInputError(
      `${name} deve ser um inteiro entre ${minimum} e ${maximum}.`,
    );
  }
}

/**
 * Executa um único lote. O agendador externo decide frequência e máximo de
 * lotes; esta função nunca marca evidência como falha nem remove prova.
 */
export async function scanStaleProtectedEvidence(
  pool: Pool,
  batchSize = 100,
): Promise<EvidenceMonitorResult> {
  assertIntegerInRange(batchSize, "batchSize", 1, 1000);
  const { rows } = await pool.query<EvidenceMonitorRow>(
    `select scanned_count, incidents_created, backlog_may_remain,
            oldest_pending_age_seconds
       from renave_operations.scan_stale_protected_evidence($1)`,
    [batchSize],
  );
  const row = rows[0];
  if (!row) throw new Error("Monitor de evidência não retornou resultado.");
  return {
    backlogMayRemain: row.backlog_may_remain,
    incidentsCreated: row.incidents_created,
    oldestPendingAgeSeconds: Number(row.oldest_pending_age_seconds),
    scannedCount: row.scanned_count,
  };
}

/**
 * Lê somente o heartbeat agregado. O limiar deve ser maior que o intervalo do
 * agendador (recomendação operacional: pelo menos duas execuções esperadas).
 */
export async function getEvidenceMonitorStatus(
  pool: Pool,
  maxSilenceSeconds = 900,
): Promise<EvidenceMonitorStatus> {
  assertIntegerInRange(maxSilenceSeconds, "maxSilenceSeconds", 1, 86_400);
  const { rows } = await pool.query<EvidenceMonitorStatusRow>(
    `select last_success_at, seconds_since_last_success, heartbeat_stale,
            open_incident_count, last_scanned_count, last_incidents_created,
            last_backlog_may_remain, last_oldest_pending_age_seconds
       from renave_operations.evidence_monitor_status($1)`,
    [maxSilenceSeconds],
  );
  const row = rows[0];
  if (!row) throw new Error("Monitor de evidência não retornou heartbeat.");
  return {
    heartbeatStale: row.heartbeat_stale,
    lastBacklogMayRemain: row.last_backlog_may_remain,
    lastIncidentsCreated: row.last_incidents_created,
    lastOldestPendingAgeSeconds: Number(row.last_oldest_pending_age_seconds),
    lastScannedCount: row.last_scanned_count,
    lastSuccessAt: row.last_success_at,
    openIncidentCount: Number(row.open_incident_count),
    secondsSinceLastSuccess:
      row.seconds_since_last_success === null
        ? null
        : Number(row.seconds_since_last_success),
  };
}

export function evidenceMonitorNeedsAttention(
  status: EvidenceMonitorStatus,
): boolean {
  return (
    status.heartbeatStale ||
    status.lastBacklogMayRemain ||
    status.openIncidentCount > 0
  );
}
