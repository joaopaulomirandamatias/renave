import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { MAINTENANCE_APP_ROLE } from "../../src/config.js";
import {
  getEvidenceMonitorStatus,
  scanStaleProtectedEvidence,
} from "../../src/evidence-maintenance.js";
import { createEstablishment } from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const ACTION = "renave.vehicle.eligibility.read";
const TIMESTAMP_EVIDENCE_ID = "66666666-6666-4666-8666-666666666666";
const MONITORED_EVIDENCE_ID = "77777777-7777-4777-8777-777777777777";

let adminPool: Pool;
let appPool: Pool;
let maintenancePoolA: Pool;
let maintenancePoolB: Pool;
let migratorPool: Pool;
let tenant: Tenant;
let establishmentId: string;

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 3 });
  maintenancePoolA = createPool(urls.maintenance, { max: 1 });
  maintenancePoolB = createPool(urls.maintenance, { max: 1 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenant = await provisionTenant(migratorPool, {
    displayName: "Evidence Operations",
    slug: "evidence-operations",
  });
  establishmentId = await withTenant(
    appPool,
    tenant.id,
    async (client) =>
      (
        await createEstablishment(client, {
          cnpj: "11222333000181",
          tradeName: "Loja Monitorada",
        })
      ).id,
  );
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    maintenancePoolA?.end(),
    maintenancePoolB?.end(),
    migratorPool?.end(),
  ]);
});

async function insertPending(id: string): Promise<void> {
  await withTenant(appPool, tenant.id, (client) =>
    client.query(
      `insert into renave.protected_evidence (
         id, tenant_id, establishment_id, action,
         request_key_id, request_nonce, request_auth_tag, request_ciphertext
       ) values ($1, $2, $3, $4, 'key-1', $5, $6, $7)`,
      [
        id,
        tenant.id,
        establishmentId,
        ACTION,
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        Buffer.from([3]),
      ],
    ),
  );
}

describe("monitor operacional de protected_evidence", () => {
  it("impede timestamps fornecidos pelo runtime e usa o relógio do banco", async () => {
    await expect(
      withTenant(appPool, tenant.id, (client) =>
        client.query(
          `insert into renave.protected_evidence (
             id, tenant_id, establishment_id, action,
             request_key_id, request_nonce, request_auth_tag,
             request_ciphertext, created_at
           ) values ($1, $2, $3, $4, 'key-1', $5, $6, $7, '2099-01-01')`,
          [
            "88888888-8888-4888-8888-888888888888",
            tenant.id,
            establishmentId,
            ACTION,
            Buffer.alloc(12, 1),
            Buffer.alloc(16, 2),
            Buffer.from([3]),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const before = Date.now();
    await insertPending(TIMESTAMP_EVIDENCE_ID);
    const after = Date.now();
    const { rows } = await adminPool.query<{
      created_at: Date;
      finalized_at: Date | null;
      status: string;
      updated_at: Date;
    }>(
      `select status, created_at, finalized_at, updated_at
         from renave.protected_evidence where id = $1`,
      [TIMESTAMP_EVIDENCE_ID],
    );
    expect(rows[0]).toMatchObject({ status: "pending", finalized_at: null });
    expect(rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.created_at.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(rows[0]!.updated_at.getTime()).toBe(rows[0]!.created_at.getTime());
  });

  it("cria incidente único sob scanners concorrentes e resolve finalização tardia", async () => {
    await insertPending(MONITORED_EVIDENCE_ID);
    await adminPool.query(
      `update renave_operations.evidence_state
          set created_at = pg_catalog.clock_timestamp() - interval '1 hour'
        where evidence_id = $1`,
      [MONITORED_EVIDENCE_ID],
    );

    await Promise.all([
      scanStaleProtectedEvidence(maintenancePoolA, 1000),
      scanStaleProtectedEvidence(maintenancePoolB, 1000),
    ]);
    const incident = await adminPool.query<{
      count: string;
      status: string;
    }>(
      `select pg_catalog.count(*)::text as count, pg_catalog.min(status) as status
         from renave_operations.evidence_incident
        where evidence_id = $1`,
      [MONITORED_EVIDENCE_ID],
    );
    expect(incident.rows[0]).toEqual({ count: "1", status: "open" });

    const heartbeat = await getEvidenceMonitorStatus(maintenancePoolA, 60);
    expect(heartbeat.lastSuccessAt).toBeInstanceOf(Date);
    expect(heartbeat.heartbeatStale).toBe(false);
    expect(heartbeat.openIncidentCount).toBe(1);
    expect(heartbeat.secondsSinceLastSuccess).toBeGreaterThanOrEqual(0);

    await withTenant(appPool, tenant.id, (client) =>
      client.query(
        `update renave.protected_evidence
            set status = 'completed', response_key_id = 'key-1',
                response_nonce = $2, response_auth_tag = $3,
                response_ciphertext = $4
          where id = $1 and status = 'pending'`,
        [
          MONITORED_EVIDENCE_ID,
          Buffer.alloc(12, 4),
          Buffer.alloc(16, 5),
          Buffer.from([6]),
        ],
      ),
    );
    const resolved = await adminPool.query<{
      evidence_status: string;
      incident_status: string;
      resolved_at: Date | null;
    }>(
      `select state.status as evidence_status,
              incident.status as incident_status,
              incident.resolved_at
         from renave_operations.evidence_state state
         join renave_operations.evidence_incident incident
           on incident.evidence_id = state.evidence_id
        where state.evidence_id = $1`,
      [MONITORED_EVIDENCE_ID],
    );
    expect(resolved.rows[0]).toMatchObject({
      evidence_status: "completed",
      incident_status: "resolved",
    });
    expect(resolved.rows[0]?.resolved_at).toBeInstanceOf(Date);

    const resolvedHeartbeat = await getEvidenceMonitorStatus(
      maintenancePoolA,
      60,
    );
    expect(resolvedHeartbeat.openIncidentCount).toBe(0);
  });

  it("limita manutenção a EXECUTE, sem acesso a prova ou projeções", async () => {
    await expect(
      maintenancePoolA.query("select id from renave.protected_evidence"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenancePoolA.query(
        "select evidence_id from renave_operations.evidence_state",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query(
        "select * from renave_operations.scan_stale_protected_evidence(1)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenancePoolA.query(
        "select * from renave_operations.evidence_monitor_heartbeat",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query(
        "select * from renave_operations.evidence_monitor_status(60)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenancePoolA.query(
        "select * from renave_operations.scan_stale_protected_evidence(0)",
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const { rows } = await adminPool.query<{
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolinherit
         from pg_roles where rolname = $1`,
      [MAINTENANCE_APP_ROLE],
    );
    expect(rows[0]).toEqual({
      rolbypassrls: false,
      rolinherit: false,
      rolsuper: false,
    });
  });
});
