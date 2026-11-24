import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayOperation,
  getOperation,
  OperationActiveConflictError,
  OperationIdentifierConflictError,
  OperationIdempotencyConflictError,
  OperationStorageError,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");
let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;
let establishmentB: Establishment;

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function operationInput(label: string): CreateOperationInput {
  const plaintext = Buffer.from(`{"label":${JSON.stringify(label)}}`, "utf8");
  const ciphertext = Buffer.from(`encrypted:${label}`);
  return {
    ...operationProjectionFields(`repository:${label}`),
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId: establishmentA.id,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 3),
    requestCiphertext: ciphertext,
    requestKeyId: "repository-key-v1",
    requestNonce: Buffer.alloc(12, 4),
    requestSchemaVersion: 1,
    requestSha256: digest(plaintext),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Operation Repository A",
    slug: "operation-repository-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Operation Repository B",
    slug: "operation-repository-b",
  });
  establishmentA = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Repository A",
    }),
  );
  establishmentB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "12.ABC.345/01DE-35",
      tradeName: "Repository B",
    }),
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end()]);
});

describe("operation repository integration", () => {
  it("cria, faz replay e lê somente o resumo sanitizado", async () => {
    const input = operationInput("replay");
    const first = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, input),
    );
    const replay = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, input),
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.operation).toEqual(first.operation);
    expect(first.operation).toMatchObject({
      correlationId: input.correlationId,
      establishmentId: establishmentA.id,
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      status: "PENDING_SEND",
      version: "1",
    });
    expect(JSON.stringify(first)).not.toMatch(/cipher|digest|hash|nonce|tag/iu);

    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getOperation(client, first.operation.id),
      ),
    ).resolves.toBeNull();
  });

  it("converte conflito de idempotência em erro fechado", async () => {
    const original = operationInput("idempotency-conflict");
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );
    const changedCiphertext = Buffer.from(original.requestCiphertext);
    changedCiphertext[0] = changedCiphertext[0]! ^ 1;
    const changed = {
      ...original,
      requestCiphertext: changedCiphertext,
      requestSha256: digest("plaintext-alterado"),
    };

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayOperation(client, changed),
      ),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
  });

  it("replay após rotação preserva o primeiro envelope cifrado", async () => {
    const original = operationInput("replay-key-rotation");
    const first = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );
    const rotatedCiphertext = Buffer.from(original.requestCiphertext);
    for (let index = 0; index < rotatedCiphertext.length; index += 1) {
      rotatedCiphertext[index] = rotatedCiphertext[index]! ^ 0xff;
    }
    const rotated = {
      ...original,
      reconciliationProjectionAuthTag: Buffer.alloc(16, 7),
      reconciliationProjectionCiphertext: Buffer.from(
        original.reconciliationProjectionCiphertext.map((byte) => byte ^ 0xaa),
      ),
      reconciliationProjectionKeyId: "projection-key-v2",
      reconciliationProjectionNonce: Buffer.alloc(12, 6),
      requestAuthTag: Buffer.alloc(16, 9),
      requestCiphertext: rotatedCiphertext,
      requestKeyId: "repository-key-v2",
      requestNonce: Buffer.alloc(12, 8),
    };

    const replay = await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, rotated),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);

    const stored = await withTenant(migratorPool, tenantA.id, async (client) =>
      client.query<{
        request_auth_tag: Buffer;
        request_ciphertext: Buffer;
        request_key_id: string;
        request_nonce: Buffer;
        request_sha256: Buffer;
        projection_auth_tag: Buffer;
        projection_ciphertext: Buffer;
        projection_key_id: string;
        projection_nonce: Buffer;
      }>(
        `select operation.request_auth_tag, operation.request_ciphertext,
                operation.request_key_id, operation.request_nonce,
                operation.request_sha256, projection.projection_auth_tag,
                projection.projection_ciphertext, projection.projection_key_id,
                projection.projection_nonce
           from renave.operation operation
           join renave.operation_reconciliation_projection projection
             on projection.tenant_id = operation.tenant_id
            and projection.operation_id = operation.id
          where operation.id = $1`,
        [first.operation.id],
      ),
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({
      request_key_id: original.requestKeyId,
    });
    expect(stored.rows[0]!.request_nonce.equals(original.requestNonce)).toBe(
      true,
    );
    expect(
      stored.rows[0]!.request_auth_tag.equals(original.requestAuthTag),
    ).toBe(true);
    expect(
      stored.rows[0]!.request_ciphertext.equals(original.requestCiphertext),
    ).toBe(true);
    expect(stored.rows[0]!.request_sha256.equals(original.requestSha256)).toBe(
      true,
    );
    expect(stored.rows[0]!.request_ciphertext.equals(rotatedCiphertext)).toBe(
      false,
    );
    expect(stored.rows[0]!.projection_key_id).toBe(
      original.reconciliationProjectionKeyId,
    );
    expect(
      stored.rows[0]!.projection_nonce.equals(
        original.reconciliationProjectionNonce,
      ),
    ).toBe(true);
    expect(
      stored.rows[0]!.projection_auth_tag.equals(
        original.reconciliationProjectionAuthTag,
      ),
    ).toBe(true);
    expect(
      stored.rows[0]!.projection_ciphertext.equals(
        original.reconciliationProjectionCiphertext,
      ),
    ).toBe(true);
  });

  it("converte operação ativa do mesmo veículo em erro fechado", async () => {
    const original = operationInput("active-conflict");
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );
    const second = {
      ...operationInput("active-conflict-second"),
      vehicleKeyDigest: original.vehicleKeyDigest,
    };

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayOperation(client, second),
      ),
    ).rejects.toBeInstanceOf(OperationActiveConflictError);
  });

  it("distingue colisão de operationId do conflito de veículo ativo", async () => {
    const original = operationInput("operation-id-collision");
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );
    const collision = {
      ...operationInput("operation-id-collision-second"),
      operationId: original.operationId,
    };

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayOperation(client, collision),
      ),
    ).rejects.toBeInstanceOf(OperationIdentifierConflictError);
  });

  it("impõe nonce global por chave e reverte toda a segunda criação", async () => {
    const original = operationInput("projection-global-nonce-a");
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );
    const collision = {
      ...operationInput("projection-global-nonce-b"),
      establishmentId: establishmentB.id,
      reconciliationProjectionKeyId: original.reconciliationProjectionKeyId,
      reconciliationProjectionNonce: Buffer.from(
        original.reconciliationProjectionNonce,
      ),
    };

    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        createOrReplayOperation(client, collision),
      ),
    ).rejects.toBeInstanceOf(OperationStorageError);
    await expect(
      withTenant(appPool, tenantB.id, (client) =>
        getOperation(client, collision.operationId),
      ),
    ).resolves.toBeNull();
  });

  it("falha fechado no replay de estado legado sem projeção", async () => {
    const original = operationInput("legacy-without-projection");
    await withTenant(appPool, tenantA.id, (client) =>
      createOrReplayOperation(client, original),
    );

    await expect(
      withTenant(migratorPool, tenantA.id, async (client) => {
        await client.query(
          `alter table renave.operation_reconciliation_projection
             disable trigger operation_reconciliation_projection_reject_update_delete`,
        );
        await client.query(
          `delete from renave.operation_reconciliation_projection
            where operation_id = $1`,
          [original.operationId],
        );
        await createOrReplayOperation(client, original);
      }),
    ).rejects.toBeInstanceOf(OperationStorageError);

    const projection = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        `select 1 from renave.operation_reconciliation_projection
            where operation_id = $1`,
        [original.operationId],
      ),
    );
    expect(projection.rowCount).toBe(1);
  });
});
