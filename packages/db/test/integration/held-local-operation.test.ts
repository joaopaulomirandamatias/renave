import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import { transitionCredentialLink } from "../../src/credential-links.js";
import {
  transitionCredentialServiceScope,
  transitionEstablishmentRegulatoryJurisdiction,
} from "../../src/credential-service-scopes.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayHeldLocalOperation,
  createOrReplayHeldLocalStockExitOperation,
  probeHeldLocalStockExitReplay,
  recordHeldLocalStockExitReplay,
  getOperation,
  OperationActiveConflictError,
  OperationCredentialLinkNotEnabledError,
  OperationIdempotencyConflictError,
  OperationStorageError,
  type CreateHeldLocalOperationInput,
  type CreateHeldLocalStockExitOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";
import {
  type OperationAuthorizationSnapshot,
  seedVerifiedOperationPrincipals,
} from "../helpers/operation-authorization.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let racePool: Pool;
let migratorPool: Pool;
let scopeProvisionerPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let enabledA: Establishment;
let confirmedA: Establishment;
let deactivatedA: Establishment;
let absentA: Establishment;
let raceA: Establishment;
let enabledB: Establishment;
const authorizationByEstablishment = new Map<
  string,
  OperationAuthorizationSnapshot
>();

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function stockExitInput(
  label: string,
  establishmentId: string,
  remoteStockId: number,
): CreateHeldLocalStockExitOperationInput {
  return {
    ...operationInput(label, establishmentId),
    ...operationProjectionFields(
      `held-exit:${label}`,
      "STOCK_EXIT_RECONCILIATION",
    ),
    kind: "USED_STOCK_EXIT",
    mutationFamily: "STOCK_EXIT",
    reconciliationProjectionKind: "STOCK_EXIT_RECONCILIATION",
    remoteStockId,
  };
}

function cnpj(index: number): string {
  const base = `73920518${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

function operationInput(
  label: string,
  establishmentId: string,
): CreateHeldLocalOperationInput {
  const authorization = authorizationByEstablishment.get(establishmentId);
  if (!authorization)
    throw new Error("missing operation authorization fixture");
  const plaintext = Buffer.from(`{"label":${JSON.stringify(label)}}`, "utf8");
  const ciphertext = Buffer.from(`encrypted:${label}`, "utf8");
  return {
    ...operationProjectionFields(`held:${label}`),
    ...authorization,
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

async function authorizeService(
  tenantId: string,
  establishmentId: string,
  expiresAt = new Date(Date.now() + 3_600_000),
): Promise<void> {
  const validFrom = new Date(Date.now() - 60_000);
  const common = {
    changedByDigest: digest(`scope-actor:${establishmentId}`),
    decisionTicketDigest: digest(`scope-ticket:${establishmentId}`),
    establishmentId,
    evidenceDigest: digest(`scope-evidence:${establishmentId}`),
    expiresAt,
    jurisdictionUf: "PA" as const,
    validFrom,
  };
  await withTenant(scopeProvisionerPool, tenantId, async (client) => {
    await transitionEstablishmentRegulatoryJurisdiction(client, {
      ...common,
      status: "verified",
    });
    await transitionCredentialServiceScope(client, {
      ...common,
      serviceNature: "establishment",
      status: "enabled",
    });
  });
}

async function waitForDatabaseTime(target: Date): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { rows } = await adminPool.query<{ reached: boolean }>(
      "select pg_catalog.clock_timestamp() >= $1::timestamptz reached",
      [target],
    );
    if (rows[0]!.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("database clock did not reach creation expiry");
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 16 });
  racePool = createPool(urls.app, {
    application_name: "held-local-operation-race",
    max: 1,
  });
  migratorPool = createPool(urls.migrator, { max: 2 });
  scopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 4,
  });
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
  const principalFixtures: readonly (readonly [
    string,
    Establishment,
    string,
  ])[] = [
    [tenantA.id, enabledA, "enabled-a"],
    [tenantA.id, confirmedA, "confirmed-a"],
    [tenantA.id, deactivatedA, "deactivated-a"],
    [tenantA.id, absentA, "absent-a"],
    [tenantA.id, raceA, "race-a"],
    [tenantB.id, enabledB, "enabled-b"],
  ];
  await Promise.all(
    principalFixtures.map(async ([tenantId, establishment, label]) => {
      const snapshot = await withTenant(migratorPool, tenantId, (client) =>
        seedVerifiedOperationPrincipals(client, {
          establishmentId: establishment.id,
          label,
        }),
      );
      authorizationByEstablishment.set(establishment.id, snapshot);
    }),
  );
  await Promise.all([
    establishLink(tenantA.id, enabledA.id, "enabled"),
    establishLink(tenantA.id, confirmedA.id, "confirmed"),
    establishLink(tenantA.id, deactivatedA.id, "deactivated"),
    establishLink(tenantA.id, raceA.id, "enabled"),
    establishLink(tenantB.id, enabledB.id, "enabled"),
  ]);
  await Promise.all([
    authorizeService(tenantA.id, enabledA.id),
    authorizeService(tenantA.id, raceA.id),
    authorizeService(tenantB.id, enabledB.id),
  ]);
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    racePool?.end(),
    migratorPool?.end(),
    scopeProvisionerPool?.end(),
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

  it("persiste saída cifrada vinculada ao stockId, sem outbox e com replay estrito", async () => {
    const input = stockExitInput("stock-exit", enabledA.id, 770001);
    const created = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalStockExitOperation(client, input),
    );
    const retry = {
      ...stockExitInput("stock-exit", enabledA.id, 770001),
      requestAuthTag: Buffer.alloc(16, 71),
      requestCiphertext: Buffer.from("new-encryption-for-the-same-request"),
      requestKeyId: "held-local-key-v2",
      requestNonce: Buffer.alloc(12, 72),
      reconciliationProjectionAuthTag: Buffer.alloc(16, 73),
      reconciliationProjectionCiphertext: Buffer.from(
        "new-encrypted-projection",
      ),
      reconciliationProjectionKeyId: "projection-key-v2",
      reconciliationProjectionNonce: Buffer.alloc(12, 74),
      reconciliationProjectionByteLength: Buffer.byteLength(
        "new-encrypted-projection",
      ),
    } satisfies CreateHeldLocalStockExitOperationInput;
    const replay = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalStockExitOperation(client, retry),
    );
    expect(created).toMatchObject({
      replayed: false,
      operation: {
        kind: "USED_STOCK_EXIT",
        mutationFamily: "STOCK_EXIT",
        status: "HELD_LOCAL",
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      operation: { id: created.operation.id },
    });
    const replayDigest = Buffer.alloc(32, 0x7a);
    await withTenant(appPool, tenantA.id, async (client) => {
      await recordHeldLocalStockExitReplay(client, {
        idempotencyKeyDigest: input.idempotencyKeyDigest,
        operationId: created.operation.id,
        replayDigest,
      });
      await expect(
        probeHeldLocalStockExitReplay(client, {
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          replayDigest,
        }),
      ).resolves.toMatchObject({
        operationId: created.operation.id,
        state: "match",
      });
      await expect(
        probeHeldLocalStockExitReplay(client, {
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          replayDigest: Buffer.alloc(32, 0x7b),
        }),
      ).resolves.toEqual({ state: "conflict" });
    });
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        probeHeldLocalStockExitReplay(client, {
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          replayDigest,
        }),
      ),
    ).resolves.toEqual({ state: "missing" });
    replayDigest.fill(0);
    expect(retry.operationId).not.toBe(input.operationId);
    expect(retry.correlationId).not.toBe(input.correlationId);

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayHeldLocalStockExitOperation(client, {
          ...input,
          remoteStockId: 770002,
        }),
      ),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);

    const stored = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const operation = await client.query<{
          kept_original_ciphertext: boolean;
          projection_kind: string;
          remote_stock_id: string;
          request_is_encrypted: boolean;
          status: string;
        }>(
          `select remote_stock_id::text,reconciliation_projection_kind
              as projection_kind,status,
              request_ciphertext=$2::bytea as request_is_encrypted,
              request_ciphertext<>$3::bytea as kept_original_ciphertext
             from renave_stock_exit.operation where id=$1`,
          [
            created.operation.id,
            input.requestCiphertext,
            retry.requestCiphertext,
          ],
        );
        const transitions = await client.query<{ count: number }>(
          `select count(*)::int count
             from renave_stock_exit.operation_transition
            where operation_id=$1`,
          [created.operation.id],
        );
        const outbox = await client.query<{ count: number }>(
          `select count(*)::int count from renave.operation_outbox
            where operation_id=$1`,
          [created.operation.id],
        );
        return {
          operation: operation.rows[0],
          outbox: outbox.rows[0]?.count,
          transitions: transitions.rows[0]?.count,
        };
      },
    );
    expect(stored).toEqual({
      operation: {
        kept_original_ciphertext: true,
        projection_kind: "STOCK_EXIT_RECONCILIATION",
        remote_stock_id: "770001",
        request_is_encrypted: true,
        status: "HELD_LOCAL",
      },
      outbox: 0,
      transitions: 1,
    });
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getOperation(client, created.operation.id),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query("select * from renave_stock_exit.operation"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("serializa replays concorrentes de saída com nova cifragem", async () => {
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      ...stockExitInput("stock-exit-concurrent", enabledA.id, 770003),
      requestAuthTag: Buffer.alloc(16, index + 1),
      requestCiphertext: Buffer.from(`retry-ciphertext-${index}`),
      requestNonce: Buffer.alloc(12, index + 1),
      reconciliationProjectionAuthTag: Buffer.alloc(16, index + 20),
      reconciliationProjectionCiphertext: Buffer.from(
        `retry-projection-${index}`,
      ),
      reconciliationProjectionNonce: Buffer.alloc(12, index + 20),
      reconciliationProjectionByteLength: Buffer.byteLength(
        `retry-projection-${index}`,
      ),
    })) satisfies CreateHeldLocalStockExitOperationInput[];
    const results = await Promise.all(
      attempts.map((attempt) =>
        withTenant(appPool, tenantA.id, (client) =>
          createOrReplayHeldLocalStockExitOperation(client, attempt),
        ),
      ),
    );
    expect(new Set(results.map((item) => item.operation.id)).size).toBe(1);
    expect(results.filter((item) => !item.replayed)).toHaveLength(1);
    expect(results.filter((item) => item.replayed)).toHaveLength(11);
  });

  it("orienta o resumo da criação ao schema mesmo com UUID igual", async () => {
    const entryInput = operationInput("shared-operation-id-entry", enabledA.id);
    const entry = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, entryInput),
    );
    const exitInput = {
      ...stockExitInput("shared-operation-id-exit", enabledA.id, 770006),
      operationId: entry.operation.id,
    };
    const exit = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalStockExitOperation(client, exitInput),
    );
    expect(exit.operation).toMatchObject({
      id: entry.operation.id,
      kind: "USED_STOCK_EXIT",
      mutationFamily: "STOCK_EXIT",
    });
    expect(entry.operation).toMatchObject({
      id: exit.operation.id,
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
    });
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getOperation(client, entry.operation.id),
      ),
    ).rejects.toBeInstanceOf(OperationStorageError);

    const summaries = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const entrySummary = await client.query<{
          kind: string;
          status: string;
        }>("select kind,status from renave.operation where id=$1", [
          entry.operation.id,
        ]);
        const exitSummary = await client.query<{
          kind: string;
          status: string;
        }>("select kind,status from renave_stock_exit.operation where id=$1", [
          entry.operation.id,
        ]);
        return [entrySummary.rows[0], exitSummary.rows[0]];
      },
    );
    expect(summaries).toEqual([
      { kind: "USED_STOCK_ENTRY", status: "HELD_LOCAL" },
      { kind: "USED_STOCK_EXIT", status: "HELD_LOCAL" },
    ]);
  });

  it("mantém conflitos semânticos de saída para stockId, veículo e perfil", async () => {
    const input = stockExitInput("stock-exit-conflict", enabledA.id, 770004);
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalStockExitOperation(client, input),
    );
    for (const changed of [
      { ...input, remoteStockId: 770005 },
      { ...input, vehicleKeyDigest: digest("other-stock-exit-vehicle") },
      { ...input, operatorProfileId: randomUUID() },
    ]) {
      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          createOrReplayHeldLocalStockExitOperation(client, changed),
        ),
      ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
    }

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayHeldLocalStockExitOperation(
          client,
          stockExitInput("stock-exit-same-remote", enabledA.id, 770004),
        ),
      ),
    ).rejects.toBeInstanceOf(OperationActiveConflictError);
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

  it("mantém promoção direta fora do runtime da API", async () => {
    const input = operationInput("terminal-held", enabledA.id);
    const created = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayHeldLocalOperation(client, input),
    );

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `update renave.operation
              set status = 'PENDING_SEND',
                  version = version + 1,
                  updated_at = pg_catalog.clock_timestamp()
            where id = $1`,
          [created.operation.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

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
    ).rejects.toBeInstanceOf(OperationCredentialLinkNotEnabledError);

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

  it("revalida expiração após cada fence e row lock de criação sem efeito parcial", async () => {
    const waits = [250025, 700069, 700070, 170017, "scope-row"] as const;
    for (const [index, wait] of waits.entries()) {
      const establishment = await createTestEstablishment(
        tenantA.id,
        20 + index,
        `Expiry fence ${wait}`,
      );
      const snapshot = await withTenant(migratorPool, tenantA.id, (client) =>
        seedVerifiedOperationPrincipals(client, {
          establishmentId: establishment.id,
          label: `expiry-${wait}`,
        }),
      );
      authorizationByEstablishment.set(establishment.id, snapshot);
      await establishLink(tenantA.id, establishment.id, "enabled");
      const expiresAt = new Date(Date.now() + 1_500);
      await authorizeService(tenantA.id, establishment.id, expiresAt);
      const input = operationInput(`expiry-${wait}`, establishment.id);

      const blocker = await migratorPool.connect();
      let blockerOpen = false;
      let creation:
        ReturnType<typeof createOrReplayHeldLocalOperation> | undefined;
      try {
        await blocker.query("begin");
        blockerOpen = true;
        await blocker.query("select set_config('renave.tenant_id',$1,true)", [
          tenantA.id,
        ]);
        if (wait === "scope-row") {
          await blocker.query(
            `select 1 from renave.credential_service_scope
              where tenant_id=$1 and establishment_id=$2
                and service_nature='establishment' and jurisdiction_uf='PA'
              for update`,
            [tenantA.id, establishment.id],
          );
        } else {
          const key =
            wait === 250025
              ? `${tenantA.id}:${input.idempotencyKeyDigest.toString("hex")}`
              : wait === 700070
                ? `${tenantA.id}:${establishment.id}:establishment:PA`
                : `${tenantA.id}:${establishment.id}`;
          await blocker.query(
            "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,$2))",
            [key, wait],
          );
        }
        creation = withTenant(appPool, tenantA.id, (client) =>
          createOrReplayHeldLocalOperation(client, input),
        );
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const { rows } = await adminPool.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_catalog.pg_stat_activity
              where wait_event_type='Lock'
                and query like '%create_held_local_operation%') blocked`,
          );
          if (rows[0]!.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        await waitForDatabaseTime(expiresAt);
        await blocker.query("commit");
        blockerOpen = false;
        await expect(creation).rejects.toBeInstanceOf(
          OperationCredentialLinkNotEnabledError,
        );
        const { rows } = await withTenant(migratorPool, tenantA.id, (client) =>
          client.query<{
            binding: number;
            evidence: number;
            operations: number;
            outbox: number;
            transitions: number;
          }>(
            `select
                (select count(*)::int from renave.operation
                  where establishment_id=$1) operations,
                (select count(*)::int from renave.operation_authorization_binding binding
                  join renave.operation operation on operation.id=binding.operation_id
                  where operation.establishment_id=$1) binding,
                (select count(*)::int from renave.operation_outbox outbox
                  join renave.operation operation on operation.id=outbox.operation_id
                  where operation.establishment_id=$1) outbox,
                (select count(*)::int from renave.operation_transition transition
                  join renave.operation operation on operation.id=transition.operation_id
                  where operation.establishment_id=$1) transitions,
                (select count(*)::int from renave.protected_evidence
                  where establishment_id=$1) evidence`,
            [establishment.id],
          ),
        );
        expect(rows[0]).toEqual({
          binding: 0,
          evidence: 0,
          operations: 0,
          outbox: 0,
          transitions: 0,
        });
      } finally {
        if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
        if (creation) await creation.catch(() => undefined);
        blocker.release();
      }
    }
  });

  it("concede somente ao app a função sanitizada e mantém runtime pronto", async () => {
    const { rows } = await adminPool.query<{
      app_executes: boolean;
      identity_executes: boolean;
      legacy_app_executes: boolean;
      legacy_migrator_executes: boolean;
      maintenance_executes: boolean;
      public_executes: boolean;
      stock_exit_app_executes: boolean;
      stock_exit_promoter_executes: boolean;
      stock_exit_promoter_usage: boolean;
      stock_exit_worker_executes: boolean;
      stock_exit_worker_usage: boolean;
      worker_executes: boolean;
    }>(
      `select
         has_function_privilege(
           'renave_app',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)',
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
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)',
           'execute'
         ) as identity_executes,
         has_function_privilege(
           'renave_maintenance_app',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)',
           'execute'
         ) as maintenance_executes,
         has_function_privilege(
           'renave_operation_worker',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)',
           'execute'
         ) as worker_executes,
         has_function_privilege(
           'public',
           'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)',
           'execute'
         ) as public_executes,
         has_function_privilege(
           'renave_app',
           'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
           'execute'
         ) as stock_exit_app_executes,
         has_function_privilege(
           'renave_operation_worker',
           'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
           'execute'
         ) as stock_exit_worker_executes,
         has_schema_privilege(
           'renave_operation_worker','renave_stock_exit','usage'
         ) as stock_exit_worker_usage,
         has_function_privilege(
           'renave_operation_promoter',
           'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
           'execute'
         ) as stock_exit_promoter_executes,
         has_schema_privilege(
           'renave_operation_promoter','renave_stock_exit','usage'
         ) as stock_exit_promoter_usage`,
    );
    expect(rows[0]).toEqual({
      app_executes: true,
      identity_executes: false,
      legacy_app_executes: false,
      legacy_migrator_executes: true,
      maintenance_executes: false,
      public_executes: false,
      stock_exit_app_executes: true,
      stock_exit_promoter_executes: false,
      stock_exit_promoter_usage: false,
      stock_exit_worker_executes: false,
      stock_exit_worker_usage: false,
      worker_executes: false,
    });

    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });

  it("fecha o runtime se privilégios da saída sofrerem drift", async () => {
    try {
      await adminPool.query(
        "grant usage on schema renave_stock_exit to renave_operation_worker",
      );
      await expect(
        appPool.query<{ ready: boolean }>(
          "select renave_runtime.api_contract_ready() as ready",
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await adminPool.query(
        "revoke usage on schema renave_stock_exit from renave_operation_worker",
      );
    }
    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });

    try {
      await adminPool.query(
        `create function renave_stock_exit.unexpected_contract_drift()
         returns boolean language sql as 'select true'`,
      );
      await expect(
        appPool.query<{ ready: boolean }>(
          "select renave_runtime.api_contract_ready() as ready",
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await adminPool.query(
        "drop function if exists renave_stock_exit.unexpected_contract_drift()",
      );
    }
    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });

    try {
      await adminPool.query(
        `grant execute on function
           renave_stock_exit_barriers.probe_replay(bytea,bytea)
         to renave_identity_app`,
      );
      await expect(
        appPool.query<{ ready: boolean }>(
          "select renave_runtime.api_contract_ready() as ready",
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave_stock_exit_barriers.probe_replay(bytea,bytea)
         from renave_identity_app`,
      );
    }
    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });

    try {
      await adminPool.query(
        `create trigger unexpected_replay_trigger
         before truncate on renave_stock_exit_barriers.replay_registry
         for each statement execute function renave_stock_exit.reject_change()`,
      );
      await expect(
        appPool.query<{ ready: boolean }>(
          "select renave_runtime.api_contract_ready() as ready",
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await adminPool.query(
        `drop trigger if exists unexpected_replay_trigger
         on renave_stock_exit_barriers.replay_registry`,
      );
    }
    await expect(
      appPool.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });
});
