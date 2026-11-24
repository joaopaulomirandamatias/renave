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
  OperationIdempotencyConflictError,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function operationInput(label: string): CreateOperationInput {
  const ciphertext = Buffer.from(`encrypted:${label}`);
  return {
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
    requestSha256: digest(ciphertext),
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
      requestSha256: digest(changedCiphertext),
    };

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOrReplayOperation(client, changed),
      ),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
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
});
