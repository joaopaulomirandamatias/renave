import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  beginOperationReconciliation,
  claimOperationReconciliations,
  completeOperationReconciliationConfirmed,
  completeOperationReconciliationManualReview,
  listPendingOperationReconciliationProjectionKeyIds,
  preflightPendingOperationReconciliationProjectionSamples,
  OperationReconciliationInputError,
  OperationReconciliationStorageError,
  releaseOperationReconciliationLease,
  renewOperationReconciliationLease,
} from "../../src/operation-reconciliation.js";
import type { TenantClient } from "../../src/tenant-context.js";

function client(query: ReturnType<typeof vi.fn>): TenantClient {
  return { query } as unknown as TenantClient;
}

function fence() {
  return {
    leaseOwner: randomUUID(),
    leaseToken: randomUUID(),
    operationVersion: "3",
    outboxId: randomUUID(),
  };
}

function claimRow() {
  return {
    attempt_count: 2,
    lease_expires_at: new Date("2026-11-24T12:05:00.000Z"),
    lease_token: randomUUID(),
    operation_id: randomUUID(),
    operation_version: "3",
    outbox_id: randomUUID(),
  };
}

describe("operation reconciliation repository", () => {
  it("lista IDs de chave validados, ordenados pelo banco e sem duplicatas", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ projection_key_id: "key-a" }, { projection_key_id: "key-b" }],
    });
    await expect(
      listPendingOperationReconciliationProjectionKeyIds(client(query)),
    ).resolves.toEqual(["key-a", "key-b"]);
    expect(query).toHaveBeenCalledWith(
      "select * from renave.list_pending_operation_reconciliation_projection_key_ids()",
    );
    for (const rows of [
      [{ projection_key_id: "bad key" }],
      [{ projection_key_id: "key-a" }, { projection_key_id: "key-a" }],
    ]) {
      await expect(
        listPendingOperationReconciliationProjectionKeyIds(
          client(vi.fn().mockResolvedValue({ rows })),
        ),
      ).rejects.toBeInstanceOf(OperationReconciliationStorageError);
    }
  });

  it("mapeia e copia somente amostras cifradas de preflight", async () => {
    const ciphertext = Buffer.from("sample-ciphertext");
    const authTag = Buffer.alloc(16, 1);
    const nonce = Buffer.alloc(12, 2);
    const sourceHash = Buffer.alloc(32, 3);
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          establishment_id: randomUUID(),
          kind: "USED_STOCK_ENTRY",
          mutation_family: "STOCK_ENTRY",
          operation_id: randomUUID(),
          projection_auth_tag: authTag,
          projection_ciphertext: ciphertext,
          projection_generation: "1",
          projection_key_id: "key-a",
          projection_kind: "STOCK_ENTRY_RECONCILIATION",
          projection_nonce: nonce,
          projection_schema_version: 1,
          projection_size: ciphertext.length,
          request_schema_version: 1,
          source_request_sha256: sourceHash,
        },
      ],
    });
    const result =
      await preflightPendingOperationReconciliationProjectionSamples(
        client(query),
      );
    expect(query).toHaveBeenCalledWith(
      "select * from renave.preflight_pending_operation_reconciliation_projection_samples()",
    );
    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]!).sort()).toEqual(
      [
        "establishmentId",
        "kind",
        "mutationFamily",
        "operationId",
        "projectionAuthTag",
        "projectionByteLength",
        "projectionCiphertext",
        "projectionGeneration",
        "projectionKeyId",
        "projectionKind",
        "projectionNonce",
        "projectionSchemaVersion",
        "requestSchemaVersion",
        "sourceRequestSha256",
      ].sort(),
    );
    expect(result[0]!.projectionCiphertext).not.toBe(ciphertext);
    expect(result[0]!.projectionAuthTag).not.toBe(authTag);
    expect(result[0]!.projectionNonce).not.toBe(nonce);
    expect(result[0]!.sourceRequestSha256).not.toBe(sourceHash);
  });

  it("mapeia claim e begin copiando o envelope", async () => {
    const claim = claimRow();
    const ciphertext = Buffer.from("projection");
    const authTag = Buffer.alloc(16, 1);
    const nonce = Buffer.alloc(12, 2);
    const sourceHash = Buffer.alloc(32, 3);
    const begin = {
      ...claim,
      correlation_id: randomUUID(),
      establishment_cnpj: "11222333000181",
      establishment_id: randomUUID(),
      kind: "USED_STOCK_ENTRY",
      mutation_family: "STOCK_ENTRY",
      projection_auth_tag: authTag,
      projection_ciphertext: ciphertext,
      projection_generation: "1",
      projection_key_id: "projection-v1",
      projection_kind: "STOCK_ENTRY_RECONCILIATION",
      projection_nonce: nonce,
      projection_schema_version: 1,
      projection_size: ciphertext.length,
      request_schema_version: 1,
      sent_at: new Date("2026-11-24T12:00:00.000Z"),
      source_request_sha256: sourceHash,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [claim] })
      .mockResolvedValueOnce({ rows: [begin] });
    const tenantClient = client(query);

    const claims = await claimOperationReconciliations(
      tenantClient,
      randomUUID(),
      1,
    );
    expect(claims).toEqual([
      expect.objectContaining({
        attemptCount: 2,
        operationId: claim.operation_id,
      }),
    ]);
    const result = await beginOperationReconciliation(tenantClient, fence());
    expect(result).toMatchObject({
      establishmentCnpj: "11222333000181",
      kind: "USED_STOCK_ENTRY",
      projectionKind: "STOCK_ENTRY_RECONCILIATION",
    });
    expect(result?.projectionCiphertext).toEqual(ciphertext);
    expect(result?.projectionCiphertext).not.toBe(ciphertext);
    expect(result?.projectionAuthTag).not.toBe(authTag);
    expect(result?.projectionNonce).not.toBe(nonce);
    expect(result?.sourceRequestSha256).not.toBe(sourceHash);
    expect(result?.leaseExpiresAt).not.toBe(begin.lease_expires_at);
    expect(result?.sentAt).not.toBe(begin.sent_at);
    expect(claims[0]?.leaseExpiresAt).not.toBe(claim.lease_expires_at);

    const leaseTime = result!.leaseExpiresAt.getTime();
    const sentTime = result!.sentAt.getTime();
    const claimLeaseTime = claims[0]!.leaseExpiresAt.getTime();
    authTag.fill(9);
    ciphertext.fill(9);
    nonce.fill(9);
    sourceHash.fill(9);
    begin.lease_expires_at.setTime(0);
    begin.sent_at.setTime(0);
    claim.lease_expires_at.setTime(0);
    expect(result?.projectionAuthTag).toEqual(Buffer.alloc(16, 1));
    expect(result?.projectionCiphertext).toEqual(Buffer.from("projection"));
    expect(result?.projectionNonce).toEqual(Buffer.alloc(12, 2));
    expect(result?.sourceRequestSha256).toEqual(Buffer.alloc(32, 3));
    expect(result?.leaseExpiresAt.getTime()).toBe(leaseTime);
    expect(result?.sentAt.getTime()).toBe(sentTime);
    expect(claims[0]?.leaseExpiresAt.getTime()).toBe(claimLeaseTime);
  });

  it("copia a data de completion e captura cada campo do input uma vez", async () => {
    const completedAt = new Date("2026-11-24T12:10:00.000Z");
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          completed_at: completedAt,
          operation_id: randomUUID(),
          operation_version: "4",
          reconcile_outbox_id: randomUUID(),
        },
      ],
    });
    const reads = new Map<PropertyKey, number>();
    const source = {
      ...fence(),
      remoteRecordId: 7,
      remoteState: "CONFIRMADO" as const,
    };
    const input = new Proxy(source, {
      get(target, property, receiver) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await completeOperationReconciliationConfirmed(
      client(query),
      input,
    );
    expect(result?.completedAt).toEqual(completedAt);
    expect(result?.completedAt).not.toBe(completedAt);
    completedAt.setTime(0);
    expect(result?.completedAt.toISOString()).toBe("2026-11-24T12:10:00.000Z");
    for (const property of [
      "outboxId",
      "leaseOwner",
      "leaseToken",
      "operationVersion",
      "remoteRecordId",
      "remoteState",
    ]) {
      expect(reads.get(property)).toBe(1);
    }
  });

  it("mapeia fences perdidos sem fabricar resultado", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: false }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const tenantClient = client(query);
    const input = fence();

    await expect(
      beginOperationReconciliation(tenantClient, input),
    ).resolves.toBeNull();
    await expect(
      renewOperationReconciliationLease(tenantClient, input),
    ).resolves.toBe(false);
    await expect(
      releaseOperationReconciliationLease(tenantClient, {
        ...input,
        retryAt: new Date("2026-11-24T12:01:00.000Z"),
      }),
    ).resolves.toBe(true);
    await expect(
      completeOperationReconciliationConfirmed(tenantClient, {
        ...input,
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      }),
    ).resolves.toBeNull();
  });

  it("converte o alvo absoluto no banco e preserva o contrato fenced", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ value: true }] });
    const retryAt = new Date("2026-11-24T12:05:00.000Z");
    const input = fence();

    await expect(
      releaseOperationReconciliationLease(client(query), {
        ...input,
        retryAt,
      }),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      `select renave.release_operation_reconciliation_lease(
       $1,$2,$3,$4,
       greatest(0, least(86400, ceil(extract(epoch from
         $5::timestamptz - pg_catalog.clock_timestamp())))::integer)
     ) as value`,
      [
        input.outboxId,
        input.leaseOwner,
        input.leaseToken,
        input.operationVersion,
        retryAt,
      ],
    );
    expect(query.mock.calls[0]![1]![4]).not.toBe(retryAt);
  });

  it("valida inputs antes de consultar", async () => {
    const query = vi.fn();
    const tenantClient = client(query);
    await expect(
      claimOperationReconciliations(tenantClient, randomUUID(), 0),
    ).rejects.toBeInstanceOf(OperationReconciliationInputError);
    await expect(
      renewOperationReconciliationLease(tenantClient, {
        ...fence(),
        operationVersion: "0",
      }),
    ).rejects.toBeInstanceOf(OperationReconciliationInputError);
    await expect(
      releaseOperationReconciliationLease(tenantClient, {
        ...fence(),
        retryAt: new Date(Number.NaN),
      }),
    ).rejects.toBeInstanceOf(OperationReconciliationInputError);
    await expect(
      completeOperationReconciliationConfirmed(tenantClient, {
        ...fence(),
        remoteRecordId: 0,
        remoteState: "CONFIRMADO",
      }),
    ).rejects.toBeInstanceOf(OperationReconciliationInputError);
    await expect(
      completeOperationReconciliationManualReview(tenantClient, {
        ...fence(),
        reason: "RENAVE_RECONCILIATION_NOT_OBSERVED" as never,
      }),
    ).rejects.toBeInstanceOf(OperationReconciliationInputError);
    expect(query).not.toHaveBeenCalled();
  });

  it("falha fechado e sanitiza resposta malformada/erro do driver", async () => {
    const malformed = vi.fn().mockResolvedValue({
      rows: [{ ...claimRow(), operation_version: 3 }],
    });
    await expect(
      claimOperationReconciliations(client(malformed), randomUUID(), 1),
    ).rejects.toBeInstanceOf(OperationReconciliationStorageError);

    const secret = "cpf=12345678901";
    const failing = vi.fn().mockRejectedValue(new Error(secret));
    const error = await beginOperationReconciliation(
      client(failing),
      fence(),
    ).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(OperationReconciliationStorageError);
    expect(String(error)).not.toContain(secret);

    const completionDriverError = Object.assign(
      new Error(secret, { cause: new Error(`cause:${secret}`) }),
      { leaked: secret },
    );
    completionDriverError.stack = `stack:${secret}`;
    const completionError = await completeOperationReconciliationConfirmed(
      client(vi.fn().mockRejectedValue(completionDriverError)),
      {
        ...fence(),
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      },
    ).catch((candidate: unknown) => candidate);
    expect(completionError).toBeInstanceOf(OperationReconciliationStorageError);
    expect(String(completionError)).not.toContain(secret);
    expect((completionError as Error).stack).not.toContain(secret);
    expect(
      (completionError as Error & { cause?: unknown }).cause,
    ).toBeUndefined();
    expect(Object.keys(completionError as object)).toEqual([]);
    expect(JSON.stringify(completionError)).toBe("{}");
  });
});
