import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  getPendingOperationDetail,
  listPendingOperations,
  OperationPendingReaderInputError,
} from "../../src/operation-pending-reader.js";
import {
  beginOperationReconciliation,
  claimOperationReconciliations,
  completeOperationReconciliationManualReview,
} from "../../src/operation-reconciliation.js";
import {
  createOrReplayOperation,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { bindHistoricalOperationForDispatch } from "../helpers/operation-authorization.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let workerPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA1: Establishment;
let establishmentA2: Establishment;
let establishmentB1: Establishment;
let manualA1: string;
let pendingA1First: string;
let pendingA1Second: string;
let pendingA2: string;
let pendingB1: string;
let confirmedA1: string;

function digest(value: string): Buffer {
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
  return {
    ...operationProjectionFields(`pending-reader:${label}`),
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 0x41),
    requestCiphertext: Buffer.from(`ciphertext:${label}`),
    requestKeyId: "pending-reader-key-v1",
    requestNonce: Buffer.alloc(12, 0x42),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}`),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

async function createOperation(
  tenant: Tenant,
  establishment: Establishment,
  label: string,
): Promise<string> {
  const created = await withTenant(migratorPool, tenant.id, (client) =>
    createOrReplayOperation(client, operationInput(label, establishment.id)),
  );
  await withTenant(migratorPool, tenant.id, (client) =>
    bindHistoricalOperationForDispatch(client, {
      establishmentId: establishment.id,
      label: `pending-reader:${label}`,
      operationId: created.operation.id,
    }),
  );
  return created.operation.id;
}

async function dispatch(
  tenant: Tenant,
  operationId: string,
): Promise<{
  operationVersion: string;
  outboxId: string;
  owner: string;
  token: string;
}> {
  const owner = randomUUID();
  return withTenant(migratorPool, tenant.id, async (client) => {
    const claimed = await client.query<{
      lease_token: string;
      operation_id: string;
      outbox_id: string;
    }>("select * from renave.claim_operation_send_leases($1,50)", [owner]);
    const lease = claimed.rows.find(
      (item) => item.operation_id === operationId,
    );
    if (!lease) throw new Error("send lease ausente");
    const begun = await client.query<{ operation_version: string }>(
      "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
      [lease.outbox_id, owner, lease.lease_token],
    );
    return {
      operationVersion: begun.rows[0]!.operation_version,
      outboxId: lease.outbox_id,
      owner,
      token: lease.lease_token,
    };
  });
}

async function createPending(
  tenant: Tenant,
  establishment: Establishment,
  label: string,
): Promise<string> {
  const operationId = await createOperation(tenant, establishment, label);
  const lease = await dispatch(tenant, operationId);
  await withTenant(migratorPool, tenant.id, async (client) => {
    const result = await client.query<{ reconcile_outbox_id: string }>(
      "select * from renave.complete_operation_send_outcome_unknown($1,$2,$3,$4)",
      [lease.outboxId, lease.owner, lease.token, lease.operationVersion],
    );
    await client.query(
      `update renave.operation_outbox
          set available_at=pg_catalog.clock_timestamp()-interval '1 ms'
        where id=$1`,
      [result.rows[0]!.reconcile_outbox_id],
    );
  });
  return operationId;
}

async function createManualReview(
  tenant: Tenant,
  establishment: Establishment,
  label: string,
): Promise<string> {
  const operationId = await createPending(tenant, establishment, label);
  const owner = randomUUID();
  const claims = await withTenant(workerPool, tenant.id, (client) =>
    claimOperationReconciliations(client, owner, 50),
  );
  const lease = claims.find((item) => item.operationId === operationId);
  if (!lease) throw new Error("reconciliation lease ausente");
  const fence = {
    leaseOwner: owner,
    leaseToken: lease.leaseToken,
    operationVersion: lease.operationVersion,
    outboxId: lease.outboxId,
  };
  await withTenant(workerPool, tenant.id, (client) =>
    beginOperationReconciliation(client, fence),
  );
  await withTenant(workerPool, tenant.id, (client) =>
    completeOperationReconciliationManualReview(client, {
      ...fence,
      reason: "RENAVE_RECONCILIATION_AMBIGUOUS",
    }),
  );
  return operationId;
}

async function createConfirmed(
  tenant: Tenant,
  establishment: Establishment,
  label: string,
): Promise<string> {
  const operationId = await createOperation(tenant, establishment, label);
  const lease = await dispatch(tenant, operationId);
  await withTenant(migratorPool, tenant.id, (client) =>
    client.query(
      "select * from renave.complete_operation_send_confirmed($1,$2,$3,$4,$5,$6)",
      [
        lease.outboxId,
        lease.owner,
        lease.token,
        lease.operationVersion,
        770001,
        "CONFIRMADO",
      ],
    ),
  );
  return operationId;
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 2 });
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  workerPool = createPool(urls.operationWorker, { max: 4 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Pending Reader A",
    slug: "pending-reader-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Pending Reader B",
    slug: "pending-reader-b",
  });
  establishmentA1 = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(1), tradeName: "A1" }),
  );
  establishmentA2 = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(2), tradeName: "A2" }),
  );
  establishmentB1 = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(1), tradeName: "B1" }),
  );

  manualA1 = await createManualReview(tenantA, establishmentA1, "manual-a1");
  pendingA1First = await createPending(
    tenantA,
    establishmentA1,
    "pending-a1-first",
  );
  pendingA1Second = await createPending(
    tenantA,
    establishmentA1,
    "pending-a1-second",
  );
  pendingA2 = await createPending(tenantA, establishmentA2, "pending-a2");
  pendingB1 = await createPending(tenantB, establishmentB1, "pending-b1");
  confirmedA1 = await createConfirmed(tenantA, establishmentA1, "confirmed-a1");
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    migratorPool?.end(),
    workerPool?.end(),
  ]);
});

describe("operation pending reader integration", () => {
  it("lista somente pendências do estabelecimento, ordena e limita", async () => {
    const page = await withTenant(appPool, tenantA.id, (client) =>
      listPendingOperations(client, {
        establishmentId: establishmentA1.id,
        limit: 2,
      }),
    );
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.items.map(({ operationId }) => operationId)).toEqual([
      pendingA1First,
      pendingA1Second,
    ]);
    expect(
      page.items.every((item) => item.status === "PENDING_RECONCILIATION"),
    ).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(
      /tenant|establishment|cipher|digest|hash|nonce|authTag|lease|outbox|cpf|cnpj/iu,
    );

    const all = await withTenant(appPool, tenantA.id, (client) =>
      listPendingOperations(client, {
        establishmentId: establishmentA1.id,
        limit: 50,
      }),
    );
    expect(all).toMatchObject({ truncated: false });
    expect(all.items.map(({ operationId }) => operationId)).toEqual([
      pendingA1First,
      pendingA1Second,
      manualA1,
    ]);
    expect(all.items.at(-1)).toMatchObject({
      operationId: manualA1,
      reasonCode: "RENAVE_RECONCILIATION_AMBIGUOUS",
      status: "MANUAL_REVIEW",
    });
    expect(all.items.map(({ operationId }) => operationId)).not.toContain(
      confirmedA1,
    );
  });

  it("isola a mesma conexão por tenant e por estabelecimento", async () => {
    const [a2, b1, a1Again] = await Promise.all([
      withTenant(appPool, tenantA.id, (client) =>
        listPendingOperations(client, {
          establishmentId: establishmentA2.id,
          limit: 50,
        }),
      ),
      withTenant(appPool, tenantB.id, (client) =>
        listPendingOperations(client, {
          establishmentId: establishmentB1.id,
          limit: 50,
        }),
      ),
      withTenant(appPool, tenantA.id, (client) =>
        listPendingOperations(client, {
          establishmentId: establishmentA1.id,
          limit: 50,
        }),
      ),
    ]);
    expect(a2.items.map(({ operationId }) => operationId)).toEqual([pendingA2]);
    expect(b1.items.map(({ operationId }) => operationId)).toEqual([pendingB1]);
    expect(a1Again.items.map(({ operationId }) => operationId)).toEqual([
      pendingA1First,
      pendingA1Second,
      manualA1,
    ]);

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        getPendingOperationDetail(client, {
          establishmentId: establishmentA2.id,
          operationId: manualA1,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getPendingOperationDetail(client, {
          establishmentId: establishmentB1.id,
          operationId: manualA1,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("devolve detalhe e timeline sanitizados, inclusive após resolução", async () => {
    const detail = await withTenant(appPool, tenantA.id, (client) =>
      getPendingOperationDetail(client, {
        establishmentId: establishmentA1.id,
        operationId: manualA1,
      }),
    );
    expect(detail?.operation).toMatchObject({
      finalizedAt: null,
      operationId: manualA1,
      reasonCode: "RENAVE_RECONCILIATION_AMBIGUOUS",
      remoteRecordId: null,
      remoteState: null,
      status: "MANUAL_REVIEW",
      version: "4",
    });
    expect(detail?.timeline.map(({ status }) => status)).toEqual([
      "PENDING_SEND",
      "SENT",
      "PENDING_RECONCILIATION",
      "MANUAL_REVIEW",
    ]);
    expect(JSON.stringify(detail)).not.toMatch(
      /tenant|establishment|cipher|digest|hash|nonce|authTag|lease|outbox|cpf|cnpj/iu,
    );

    const resolved = await withTenant(appPool, tenantA.id, (client) =>
      getPendingOperationDetail(client, {
        establishmentId: establishmentA1.id,
        operationId: confirmedA1,
      }),
    );
    expect(resolved?.operation).toMatchObject({
      finalizedAt: expect.any(Date),
      operationId: confirmedA1,
      remoteRecordId: 770001,
      remoteState: "CONFIRMADO",
      status: "CONFIRMED",
    });
  });

  it("falha fechado sem tenant, com input inválido ou SELECT direto", async () => {
    await expect(
      appPool.query(
        "select * from renave_operation_reader.list_pending_operations($1,10)",
        [establishmentA1.id],
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        listPendingOperations(client, {
          establishmentId: establishmentA1.id,
          limit: 51,
        }),
      ),
    ).rejects.toBeInstanceOf(OperationPendingReaderInputError);
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query("select id from renave.operation limit 1"),
      ),
    ).rejects.toThrow();
  });

  it("contrato runtime fecha diante de ACL extra", async () => {
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
    try {
      await adminPool.query(
        `grant execute on function
           renave_operation_reader.list_pending_operations(uuid,integer)
         to renave_identity_app`,
      );
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave_operation_reader.list_pending_operations(uuid,integer)
         from renave_identity_app`,
      );
    }
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });
});
