import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import { transitionCredentialLink } from "../../src/credential-links.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayHeldLocalOperation,
  getOperation,
  OperationActiveConflictError,
  OperationCredentialLinkNotEnabledError,
  OperationIdempotencyConflictError,
  OperationStorageError,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let racePool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let enabledA: Establishment;
let confirmedA: Establishment;
let deactivatedA: Establishment;
let absentA: Establishment;
let raceA: Establishment;
let enabledB: Establishment;

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function cnpj(index: number): string {
  const base = `73920518${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

function operationInput(
  label: string,
  establishmentId: string,
): CreateOperationInput {
  const plaintext = Buffer.from(`{"label":${JSON.stringify(label)}}`, "utf8");
  const ciphertext = Buffer.from(`encrypted:${label}`, "utf8");
  return {
    ...operationProjectionFields(`held:${label}`),
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 3),
    requestCiphertext: ciphertext,
    requestKeyId: "held-local-key-v1",
    requestNonce: Buffer.alloc(12, 4),
    requestSchemaVersion: 1,
    requestSha256: digest(plaintext),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

async function establishLink(
  tenantId: string,
  establishmentId: string,
  target: "confirmed" | "deactivated" | "enabled",
): Promise<void> {
  await withTenant(appPool, tenantId, async (client) => {
    const common = {
      changedBySubject: "oidc|held-local-tests",
      establishmentId,
      source: "manual" as const,
    };
    await transitionCredentialLink(client, { ...common, status: "pending" });
    await transitionCredentialLink(client, { ...common, status: "confirmed" });
    if (target === "confirmed") return;
    await transitionCredentialLink(client, { ...common, status: "enabled" });
    if (target === "deactivated") {
      await transitionCredentialLink(client, {
        ...common,
        status: "deactivated",
      });
    }
  });
}

async function createTestEstablishment(
  tenantId: string,
  index: number,
  name: string,
): Promise<Establishment> {
  return withTenant(appPool, tenantId, (client) =>
    createEstablishment(client, { cnpj: cnpj(index), tradeName: name }),
  );
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 16 });
  racePool = createPool(urls.app, {
    application_name: "held-local-operation-race",
    max: 1,
  });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Held Local A",
    slug: "held-local-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Held Local B",
    slug: "held-local-b",
  });
  [enabledA, confirmedA, deactivatedA, absentA, raceA] = await Promise.all([
    createTestEstablishment(tenantA.id, 1, "Enabled A"),
    createTestEstablishment(tenantA.id, 2, "Confirmed A"),
    createTestEstablishment(tenantA.id, 3, "Deactivated A"),
    createTestEstablishment(tenantA.id, 4, "Absent A"),
    createTestEstablishment(tenantA.id, 5, "Race A"),
  ]);
  enabledB = await createTestEstablishment(tenantB.id, 1, "Enabled B");
  await Promise.all([
    establishLink(tenantA.id, enabledA.id, "enabled"),
    establishLink(tenantA.id, confirmedA.id, "confirmed"),
    establishLink(tenantA.id, deactivatedA.id, "deactivated"),
    establishLink(tenantA.id, raceA.id, "enabled"),
    establishLink(tenantB.id, enabledB.id, "enabled"),
  ]);
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    racePool?.end(),
    migratorPool?.end(),
  ]);
});

describe("held local operation integration", () => {
  it("cria uma única operação HELD_LOCAL em replay concorrente e zero outbox", async () => {
    const input = operationInput("concurrent-replay", enabledA.id);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withTenant(appPool, tenantA.id, (client) =>
          createOrReplayHeldLocalOperation(client, input),
        ),
      ),
    );

    expect(new Set(results.map(({ operation }) => operation.id)).size).toBe(1);
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(11);
    expect(results[0]?.operation).toMatchObject({
      establishmentId: enabledA.id,
      status: "HELD_LOCAL",
      version: "1",
    });

    const stored = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const operation = await client.query<{ count: number }>(
          `select count(*)::int as count from renave.operation
            where idempotency_key_digest = $1`,
          [input.idempotencyKeyDigest],
        );
        const outbox = await client.query<{
          ready_count: number;
          total_count: number;
        }>(
          `select count(*)::int as total_count,
                  count(*) filter (where delivery_status = 'READY')::int
                    as ready_count
             from renave.operation_outbox
            where operation_id = $1`,
          [results[0]!.operation.id],
        );
        const transition = await client.query<{
          reason_code: string;
          status: string;
        }>(
          `select status, reason_code from renave.operation_transition
            where operation_id = $1`,
          [results[0]!.operation.id],
        );
        return {
          operationCount: operation.rows[0]?.count,
          outbox: outbox.rows[0],
          transition: transition.rows[0],
        };
      },
    );
    expect(stored).toEqual({
      operationCount: 1,
      outbox: { ready_count: 0, total_count: 0 },
      transition: {
        reason_code: "HELD_LOCAL_CREATED",
        status: "HELD_LOCAL",
      },
    });
  });

  it.each([
    ["confirmed", () => confirmedA],
    ["deactivated", () => deactivatedA],
    ["absent", () => absentA],
  ] as const)(
    "recusa vínculo %s sem persistir operação",
    async (label, getEstablishment) => {
      const input = operationInput(`link-${label}`, getEstablishment().id);
      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          createOrReplayHeldLocalOperation(client, input),
        ),
      ).rejects.toBeInstanceOf(OperationCredentialLinkNotEnabledError);

      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          getOperation(client, input.operationId),
        ),
      ).resolves.toBeNull();
    },
  );

  it("preserva conflitos de idempotência e de veículo ativo", async () => {
    const original = operationInput("conflicts", enabledA.id);
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, original),
    );

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayHeldLocalOperation(client, {
          ...original,
          requestSha256: digest("different-request"),
        }),
      ),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayHeldLocalOperation(client, {
          ...operationInput("conflicts-second", enabledA.id),
          vehicleKeyDigest: original.vehicleKeyDigest,
        }),
      ),
    ).rejects.toBeInstanceOf(OperationActiveConflictError);
  });

  it("mantém HELD_LOCAL terminal e não permite promoção direta a PENDING_SEND", async () => {
    const input = operationInput("terminal-held", enabledA.id);
    const created = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, input),
    );

    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          `update renave.operation
              set status = 'PENDING_SEND',
                  version = version + 1,
                  updated_at = pg_catalog.clock_timestamp()
            where id = $1`,
          [created.operation.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });

    const persisted = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const operation = await client.query<{
          status: string;
          version: string;
        }>("select status, version from renave.operation where id = $1", [
          created.operation.id,
        ]);
        const outbox = await client.query<{ count: number }>(
          `select count(*)::int as count from renave.operation_outbox
            where operation_id = $1`,
          [created.operation.id],
        );
        return { operation: operation.rows[0], outbox: outbox.rows[0] };
      },
    );
    expect(persisted).toEqual({
      operation: { status: "HELD_LOCAL", version: "1" },
      outbox: { count: 0 },
    });
  });

  it("isola por tenant e recusa estabelecimento estrangeiro", async () => {
    const input = operationInput("tenant-isolation", enabledA.id);
    const created = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, input),
    );

    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getOperation(client, created.operation.id),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        createOrReplayHeldLocalOperation(
          client,
          operationInput("foreign-establishment", enabledA.id),
        ),
      ),
    ).rejects.toBeInstanceOf(OperationStorageError);

    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        createOrReplayHeldLocalOperation(
          client,
          operationInput("tenant-b-enabled", enabledB.id),
        ),
      ),
    ).resolves.toMatchObject({ operation: { status: "HELD_LOCAL" } });
  });

  it("serializa desativação concorrente e falha fechado após o lock", async () => {
    const deactivator = await appPool.connect();
    await deactivator.query("begin");
    await deactivator.query("select set_config('renave.tenant_id', $1, true)", [
      tenantA.id,
    ]);
    await transitionCredentialLink(deactivator as PoolClient, {
      changedBySubject: "oidc|held-local-race",
      establishmentId: raceA.id,
      source: "manual",
      status: "deactivated",
    });

    const input = operationInput("deactivation-race", raceA.id);
    const creation = withTenant(racePool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, input),
    );
    let observedWaitingLock = false;
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const waiting = await adminPool.query<{ waiting: boolean }>(
          `select exists (
             select 1 from pg_catalog.pg_stat_activity
              where application_name = 'held-local-operation-race'
                and wait_event_type = 'Lock'
           ) as waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          observedWaitingLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWaitingLock).toBe(true);
      await deactivator.query("commit");
      await expect(creation).rejects.toBeInstanceOf(
        OperationCredentialLinkNotEnabledError,
      );
    } finally {
      if (!observedWaitingLock) await deactivator.query("rollback");
      deactivator.release();
    }

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getOperation(client, input.operationId),
      ),
    ).resolves.toBeNull();
  });

  it("concede somente ao app a função sanitizada e mantém runtime pronto", async () => {
    const { rows } = await adminPool.query<{
      app_executes: boolean;
      identity_executes: boolean;
      legacy_app_executes: boolean;
      legacy_migrator_executes: boolean;
      maintenance_executes: boolean;
      public_executes: boolean;
      worker_executes: boolean;
    }>(
      `select
         has_function_privilege(
           'renave_app',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as app_executes,
         has_function_privilege(
           'renave_app',
           'renave.create_operation_with_outbox(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as legacy_app_executes,
         has_function_privilege(
           'renave_migrator',
           'renave.create_operation_with_outbox(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as legacy_migrator_executes,
         has_function_privilege(
           'renave_identity_app',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as identity_executes,
         has_function_privilege(
           'renave_maintenance_app',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as maintenance_executes,
         has_function_privilege(
           'renave_operation_worker',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as worker_executes,
         has_function_privilege(
           'public',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
           'execute'
         ) as public_executes`,
    );
    expect(rows[0]).toEqual({
      app_executes: true,
      identity_executes: false,
      legacy_app_executes: false,
      legacy_migrator_executes: true,
      maintenance_executes: false,
      public_executes: false,
      worker_executes: false,
    });

    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });
});
