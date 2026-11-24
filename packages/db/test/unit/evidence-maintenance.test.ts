import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  evidenceMonitorNeedsAttention,
  EvidenceMonitorInputError,
  getEvidenceMonitorStatus,
  scanStaleProtectedEvidence,
} from "../../src/evidence-maintenance.js";

describe("scanStaleProtectedEvidence", () => {
  it.each([0, 1001, 1.5, Number.NaN])(
    "recusa batch inválido %s antes de abrir conexão",
    async (batchSize) => {
      await expect(
        scanStaleProtectedEvidence({} as Pool, batchSize),
      ).rejects.toBeInstanceOf(EvidenceMonitorInputError);
    },
  );

  it.each([0, 86_401, 1.5, Number.NaN])(
    "recusa limiar de silêncio inválido %s antes de abrir conexão",
    async (maxSilenceSeconds) => {
      await expect(
        getEvidenceMonitorStatus({} as Pool, maxSilenceSeconds),
      ).rejects.toBeInstanceOf(EvidenceMonitorInputError);
    },
  );

  it("mapeia o heartbeat agregado sem expor identificadores", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          heartbeat_stale: false,
          last_backlog_may_remain: false,
          last_incidents_created: 0,
          last_oldest_pending_age_seconds: "12",
          last_scanned_count: 3,
          last_success_at: new Date("2026-11-23T12:00:00.000Z"),
          open_incident_count: "0",
          seconds_since_last_success: "4",
        },
      ],
    });

    const status = await getEvidenceMonitorStatus(
      { query } as unknown as Pool,
      60,
    );

    expect(status).toEqual({
      heartbeatStale: false,
      lastBacklogMayRemain: false,
      lastIncidentsCreated: 0,
      lastOldestPendingAgeSeconds: 12,
      lastScannedCount: 3,
      lastSuccessAt: new Date("2026-11-23T12:00:00.000Z"),
      openIncidentCount: 0,
      secondsSinceLastSuccess: 4,
    });
    expect(evidenceMonitorNeedsAttention(status)).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("evidence_monitor_status"),
      [60],
    );
  });

  it("pede atenção para heartbeat vencido, backlog ou incidente aberto", () => {
    const base = {
      heartbeatStale: false,
      lastBacklogMayRemain: false,
      lastIncidentsCreated: 0,
      lastOldestPendingAgeSeconds: 0,
      lastScannedCount: 0,
      lastSuccessAt: new Date(),
      openIncidentCount: 0,
      secondsSinceLastSuccess: 1,
    };

    expect(
      evidenceMonitorNeedsAttention({ ...base, heartbeatStale: true }),
    ).toBe(true);
    expect(
      evidenceMonitorNeedsAttention({ ...base, lastBacklogMayRemain: true }),
    ).toBe(true);
    expect(
      evidenceMonitorNeedsAttention({ ...base, openIncidentCount: 1 }),
    ).toBe(true);
  });
});
