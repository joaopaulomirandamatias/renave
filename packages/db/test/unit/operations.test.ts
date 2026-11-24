import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOrReplayHeldLocalOperation,
  createOrReplayOperation,
  getOperation,
  OperationActiveConflictError,
  OperationIdempotencyConflictError,
  OperationInputError,
  OperationPromotionDeniedError,
  OperationStorageError,
  promoteHeldLocalOperation,
  type CreateHeldLocalOperationInput,
  type CreateOperationInput,
} from "../../src/operations.js";
import type { TenantClient } from "../../src/tenant-context.js";

function input(): CreateHeldLocalOperationInput {
  return {
    actorSubjectHash: Buffer.alloc(32, 1),
    correlationId: randomUUID(),
    establishmentId: randomUUID(),
    idempotencyKeyDigest: Buffer.alloc(32, 2),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    operationId: randomUUID(),
    establishmentProfileId: randomUUID(),
    establishmentProfileVersion: "1",
    operatorProfileId: randomUUID(),
    operatorProfileVersion: "1",
    reconciliationProjectionAuthTag: Buffer.alloc(16, 7),
    reconciliationProjectionByteLength: 21,
    reconciliationProjectionCiphertext: Buffer.alloc(21, 8),
    reconciliationProjectionGeneration: 1,
    reconciliationProjectionKeyId: "projection-key-v1",
    reconciliationProjectionKind: "STOCK_ENTRY_RECONCILIATION",
    reconciliationProjectionNonce: Buffer.alloc(12, 9),
    reconciliationProjectionSchemaVersion: 1,
    requestAuthTag: Buffer.alloc(16, 3),
    requestCiphertext: Buffer.from("ciphertext"),
    requestKeyId: "operation-key-v1",
    requestNonce: Buffer.alloc(12, 4),
    requestSchemaVersion: 1,
    requestSha256: Buffer.alloc(32, 5),
    subject: "oidc|operations-unit",
    vehicleKeyDigest: Buffer.alloc(32, 6),
  };
}

function promotionInput(operationId: string = randomUUID()) {
  return {
    artifactDigest: Buffer.alloc(32, 11),
    authorizationBindingDigest: Buffer.alloc(32, 12),
    changedByDigest: Buffer.alloc(32, 13),
    credentialLinkVersion: "3",
    decisionId: randomUUID(),
    environment: "homologation" as const,
    establishmentProfileId: randomUUID(),
    establishmentProfileVersion: "5",
    evidenceManifestDigest: Buffer.alloc(32, 14),
    executorWorkloadDigest: Buffer.alloc(32, 15),
    expiresAt: new Date("2026-11-24T12:10:00.000Z"),
    issuerKeyId: "operations-key-v1",
    issuedAt: new Date("2026-11-24T12:00:00.000Z"),
    jurisdictionGeneration: "7",
    jurisdictionUf: "PA",
    logicalDatabaseId: randomUUID(),
    notBefore: new Date("2026-11-24T12:00:00.000Z"),
    operationId,
    operatorProfileId: randomUUID(),
    operatorProfileVersion: "9",
    policyVersion: "operation-promotion/v1",
    scopeGeneration: "11",
    serviceNature: "establishment" as const,
  };
}

function summary(operationId: string, candidate: CreateOperationInput) {
  return {
    correlation_id: candidate.correlationId,
    created_at: new Date("2026-11-24T00:00:00.000Z"),
    establishment_id: candidate.establishmentId,
    kind: candidate.kind,
    mutation_family: candidate.mutationFamily,
    operation_id: operationId,
    status: "PENDING_SEND",
    updated_at: new Date("2026-11-24T00:00:00.000Z"),
    version: "1",
  };
}

function clientWithQuery(query: ReturnType<typeof vi.fn>): TenantClient {
  return { query } as unknown as TenantClient;
}

function expectSanitizedError(
  error: unknown,
  secrets: readonly string[],
): void {
  expect(error).toBeInstanceOf(Error);
  const candidate = error as Error & {
    cause?: unknown;
    [key: string]: unknown;
  };
  const enumerableProperties = Object.fromEntries(Object.entries(candidate));
  const surfaces = [
    candidate.message,
    String(candidate),
    candidate.stack ?? "",
    String(candidate.cause ?? ""),
    JSON.stringify(enumerableProperties),
  ];

  expect(candidate.cause).toBeUndefined();
  for (const secret of secrets) {
    for (const surface of surfaces) expect(surface).not.toContain(secret);
  }
}

describe("operation repository", () => {
  it("copia buffers antes da primeira espera e devolve somente resumo", async () => {
    const candidate = input();
    const originalBuffers = [
      candidate.idempotencyKeyDigest,
      candidate.vehicleKeyDigest,
      candidate.requestSha256,
      candidate.requestNonce,
      candidate.requestAuthTag,
      candidate.requestCiphertext,
      candidate.actorSubjectHash,
      candidate.reconciliationProjectionNonce,
      candidate.reconciliationProjectionAuthTag,
      candidate.reconciliationProjectionCiphertext,
    ].map((buffer) => Buffer.from(buffer));
    const operationId = randomUUID();
    let resolveCreate!: (value: { rows: unknown[] }) => void;
    let createParameters: unknown[] | undefined;
    const query = vi
      .fn()
      .mockImplementationOnce((_sql: string, parameters: unknown[]) => {
        createParameters = parameters;
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      })
      .mockResolvedValueOnce({ rows: [summary(operationId, candidate)] });

    const pending = createOrReplayOperation(clientWithQuery(query), candidate);
    for (const buffer of [
      candidate.idempotencyKeyDigest,
      candidate.vehicleKeyDigest,
      candidate.requestSha256,
      candidate.requestNonce,
      candidate.requestAuthTag,
      candidate.requestCiphertext,
      candidate.actorSubjectHash,
      candidate.reconciliationProjectionNonce,
      candidate.reconciliationProjectionAuthTag,
      candidate.reconciliationProjectionCiphertext,
    ]) {
      buffer.fill(9);
    }

    const capturedBuffers = [4, 5, 6, 10, 11, 12, 13, 20, 21, 22].map(
      (index) => createParameters?.[index],
    );
    expect(capturedBuffers).toEqual(originalBuffers);
    for (const [captured, current] of capturedBuffers.map((value, index) => [
      value,
      [
        candidate.idempotencyKeyDigest,
        candidate.vehicleKeyDigest,
        candidate.requestSha256,
        candidate.requestNonce,
        candidate.requestAuthTag,
        candidate.requestCiphertext,
        candidate.actorSubjectHash,
        candidate.reconciliationProjectionNonce,
        candidate.reconciliationProjectionAuthTag,
        candidate.reconciliationProjectionCiphertext,
      ][index],
    ])) {
      expect(captured).not.toBe(current);
    }
    resolveCreate({ rows: [{ operation_id: operationId, replayed: false }] });

    await expect(pending).resolves.toMatchObject({
      operation: {
        id: operationId,
        status: "PENDING_SEND",
        version: "1",
      },
      replayed: false,
    });
    expect(JSON.stringify(await pending)).not.toMatch(
      /cipher|digest|hash|nonce|tag/iu,
    );
  });

  const invalidCases: readonly (readonly [
    string,
    (value: CreateOperationInput) => void,
  ])[] = [
    [
      "operation uuid",
      (value) => {
        value.operationId = "invalid";
      },
    ],
    [
      "establishment uuid",
      (value) => {
        value.establishmentId = "invalid";
      },
    ],
    [
      "correlation uuid",
      (value) => {
        value.correlationId = "invalid";
      },
    ],
    [
      "kind",
      (value) => {
        value.kind = "OTHER" as never;
      },
    ],
    [
      "family",
      (value) => {
        value.mutationFamily = "OTHER" as never;
      },
    ],
    [
      "schema zero",
      (value) => {
        value.requestSchemaVersion = 0;
      },
    ],
    [
      "schema fractional",
      (value) => {
        value.requestSchemaVersion = 1.5;
      },
    ],
    [
      "key id inválido",
      (value) => {
        value.requestKeyId = " invalid";
      },
    ],
    [
      "key id undefined",
      (value) => {
        value.requestKeyId = undefined as never;
      },
    ],
    [
      "key id null",
      (value) => {
        value.requestKeyId = null as never;
      },
    ],
    [
      "key id objeto",
      (value) => {
        value.requestKeyId = {} as never;
      },
    ],
    [
      "key id vazio",
      (value) => {
        value.requestKeyId = "";
      },
    ],
    [
      "key id com 65 caracteres",
      (value) => {
        value.requestKeyId = "a".repeat(65);
      },
    ],
    [
      "idempotency digest",
      (value) => {
        value.idempotencyKeyDigest = Buffer.alloc(31);
      },
    ],
    [
      "vehicle digest",
      (value) => {
        value.vehicleKeyDigest = Buffer.alloc(33);
      },
    ],
    [
      "request digest",
      (value) => {
        value.requestSha256 = Buffer.alloc(0);
      },
    ],
    [
      "actor digest",
      (value) => {
        value.actorSubjectHash = Buffer.alloc(4);
      },
    ],
    [
      "nonce",
      (value) => {
        value.requestNonce = Buffer.alloc(11);
      },
    ],
    [
      "tag",
      (value) => {
        value.requestAuthTag = Buffer.alloc(15);
      },
    ],
    [
      "ciphertext empty",
      (value) => {
        value.requestCiphertext = Buffer.alloc(0);
      },
    ],
    [
      "ciphertext large",
      (value) => {
        value.requestCiphertext = Buffer.alloc(1_048_577);
      },
    ],
    [
      "projection kind",
      (value) => {
        value.reconciliationProjectionKind = "OTHER" as never;
      },
    ],
    [
      "projection schema",
      (value) => {
        value.reconciliationProjectionSchemaVersion = 2 as never;
      },
    ],
    [
      "projection generation",
      (value) => {
        value.reconciliationProjectionGeneration = 2;
      },
    ],
    [
      "projection size mismatch",
      (value) => {
        value.reconciliationProjectionByteLength += 1;
      },
    ],
    [
      "projection key",
      (value) => {
        value.reconciliationProjectionKeyId = " invalid";
      },
    ],
    [
      "projection nonce",
      (value) => {
        value.reconciliationProjectionNonce = Buffer.alloc(11);
      },
    ],
    [
      "projection tag",
      (value) => {
        value.reconciliationProjectionAuthTag = Buffer.alloc(15);
      },
    ],
    [
      "projection ciphertext large",
      (value) => {
        value.reconciliationProjectionCiphertext = Buffer.alloc(4097);
        value.reconciliationProjectionByteLength = 4097;
      },
    ],
  ];

  it.each(invalidCases)("recusa %s antes do banco", async (_name, mutate) => {
    const candidate = input();
    mutate(candidate);
    const query = vi.fn();

    await expect(
      createOrReplayOperation(clientWithQuery(query), candidate),
    ).rejects.toBeInstanceOf(OperationInputError);
    expect(query).not.toHaveBeenCalled();
  });

  it("aceita key id com o limite de 64 caracteres", async () => {
    const candidate = input();
    candidate.requestKeyId = `a${"b".repeat(63)}`;
    const operationId = randomUUID();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ operation_id: operationId, replayed: false }],
      })
      .mockResolvedValueOnce({ rows: [summary(operationId, candidate)] });

    await expect(
      createOrReplayOperation(clientWithQuery(query), candidate),
    ).resolves.toMatchObject({ replayed: false });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[9]).toBe(candidate.requestKeyId);
  });

  it("serializa o snapshot regulatório completo ao criar HELD_LOCAL", async () => {
    const candidate = input();
    candidate.subject = "oidc|operator-123";
    candidate.operatorProfileId = randomUUID();
    candidate.operatorProfileVersion = "7";
    candidate.establishmentProfileId = randomUUID();
    candidate.establishmentProfileVersion = "11";
    const operationId = randomUUID();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ operation_id: operationId, replayed: false }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            ...summary(operationId, candidate),
            status: "HELD_LOCAL",
          },
        ],
      });

    await expect(
      createOrReplayHeldLocalOperation(clientWithQuery(query), candidate),
    ).resolves.toMatchObject({
      operation: { id: operationId, status: "HELD_LOCAL" },
      replayed: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("create_held_local_operation");
    expect(query.mock.calls[0]?.[1]?.slice(23)).toEqual([
      candidate.subject,
      candidate.operatorProfileId,
      candidate.operatorProfileVersion,
      candidate.establishmentProfileId,
      candidate.establishmentProfileVersion,
    ]);
  });

  it.each([
    "subject",
    "operatorProfileId",
    "operatorProfileVersion",
    "establishmentProfileId",
    "establishmentProfileVersion",
  ] as const)(
    "recusa HELD_LOCAL sem snapshot %s antes do banco",
    async (field) => {
      const candidate = input();
      candidate.subject = "oidc|operator-123";
      candidate.operatorProfileId = randomUUID();
      candidate.operatorProfileVersion = "7";
      candidate.establishmentProfileId = randomUUID();
      candidate.establishmentProfileVersion = "11";
      delete candidate[field];
      const query = vi.fn();

      await expect(
        createOrReplayHeldLocalOperation(clientWithQuery(query), candidate),
      ).rejects.toBeInstanceOf(OperationInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("mapeia a promoção sem expor o binding regulatório", async () => {
    const candidate = input();
    const operationId = randomUUID();
    const outboxId = randomUUID();
    const promotedAt = new Date("2026-11-24T12:00:00.000Z");
    const promotion = promotionInput(operationId);
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          operation_id: operationId,
          operation_status: "PENDING_SEND",
          outbox_id: outboxId,
          promoted_at: promotedAt,
          replayed: false,
        },
      ],
    });

    await expect(
      promoteHeldLocalOperation(clientWithQuery(query), promotion),
    ).resolves.toEqual({
      operationId,
      operationStatus: "PENDING_SEND",
      outboxId,
      promotedAt,
      replayed: false,
    });
    expect(query.mock.calls[0]?.[1]?.slice(0, 9)).toEqual([
      operationId,
      promotion.environment,
      promotion.logicalDatabaseId,
      promotion.decisionId,
      promotion.issuedAt,
      promotion.notBefore,
      promotion.expiresAt,
      promotion.issuerKeyId,
      promotion.policyVersion,
    ]);
    for (const [index, source] of [
      promotion.authorizationBindingDigest,
      promotion.executorWorkloadDigest,
      promotion.artifactDigest,
      promotion.evidenceManifestDigest,
      promotion.changedByDigest,
    ].entries()) {
      const captured = query.mock.calls[0]?.[1]?.[index + 9] as Buffer;
      expect(captured).not.toBe(source);
      expect(captured).toEqual(Buffer.alloc(32));
    }
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["artifactDigest", Buffer.alloc(31)],
    ["authorizationBindingDigest", Buffer.alloc(33)],
    ["evidenceManifestDigest", Buffer.alloc(0)],
    ["executorWorkloadDigest", Buffer.alloc(0)],
    ["changedByDigest", Buffer.alloc(0)],
  ] as const)(
    "recusa digest de promoção inválido em %s",
    async (field, value) => {
      const candidate = promotionInput();
      candidate[field] = value;
      const query = vi.fn();
      await expect(
        promoteHeldLocalOperation(clientWithQuery(query), candidate),
      ).rejects.toBeInstanceOf(OperationInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("mapeia somente a negativa exata da promoção e sanitiza o erro", async () => {
    const leaked = "binding-regulatorio-secreto";
    const exact = clientWithQuery(
      vi.fn().mockRejectedValue({
        code: "55000",
        detail: leaked,
        message: "operation promotion: indisponível",
      }),
    );
    const denied = await promoteHeldLocalOperation(
      exact,
      promotionInput(),
    ).catch((caught: unknown) => caught);
    expect(denied).toBeInstanceOf(OperationPromotionDeniedError);
    expectSanitizedError(denied, ["55000", leaked, "indisponível"]);

    const approximate = clientWithQuery(
      vi.fn().mockRejectedValue({
        code: "55000",
        detail: leaked,
        message: "operation promotion: indisponível agora",
      }),
    );
    const storage = await promoteHeldLocalOperation(
      approximate,
      promotionInput(),
    ).catch((caught: unknown) => caught);
    expect(storage).toBeInstanceOf(OperationStorageError);
    expectSanitizedError(storage, ["55000", leaked, "indisponível"]);
  });

  it("fecha promoção com identificador ou resposta inválida sem consultar resumo", async () => {
    const query = vi.fn();
    await expect(
      promoteHeldLocalOperation(
        clientWithQuery(query),
        promotionInput("invalid"),
      ),
    ).rejects.toBeInstanceOf(OperationInputError);
    expect(query).not.toHaveBeenCalled();

    const malformedQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          operation_id: randomUUID(),
          operation_status: "PENDING_SEND",
          outbox_id: "invalid",
          promoted_at: new Date(),
          replayed: false,
        },
      ],
    });
    await expect(
      promoteHeldLocalOperation(
        clientWithQuery(malformedQuery),
        promotionInput(),
      ),
    ).rejects.toBeInstanceOf(OperationStorageError);
    expect(malformedQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["operation: conflito de idempotência", OperationIdempotencyConflictError],
    ["operation: mutação ativa conflitante", OperationActiveConflictError],
  ] as const)("mapeia conflito fechado: %s", async (message, expected) => {
    const query = vi.fn().mockRejectedValue({
      code: "23000",
      detail: "ciphertext sigiloso",
      message,
    });

    const error = await createOrReplayOperation(
      clientWithQuery(query),
      input(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(expected);
    expectSanitizedError(error, ["23000", "ciphertext", "operation:"]);
  });

  it.each([
    ["23000", "operation: conflito desconhecido"],
    ["23505", "operation: conflito de idempotência"],
    ["23000", "prefixo operation: conflito de idempotência"],
    ["23000", "operation: conflito de idempotência sufixo"],
    ["23505", "duplicate key value violates unique constraint operation_key"],
  ])(
    "não classifica erro aproximado do banco: %s / %s",
    async (code, message) => {
      const query = vi.fn().mockRejectedValue({
        code,
        detail: "payload-ciphertext-super-secreto",
        message,
      });

      const error = await createOrReplayOperation(
        clientWithQuery(query),
        input(),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OperationStorageError);
      expectSanitizedError(error, [
        code,
        message,
        "payload-ciphertext-super-secreto",
      ]);
    },
  );

  it("fecha erros inesperados e respostas inválidas do banco", async () => {
    const leakedPassword = "password=senha-super-secreta";
    const leakedPayload = "payload=conteudo-pessoal";
    const unavailable = clientWithQuery(
      vi.fn().mockRejectedValue(
        new Error(`${leakedPassword}; ${leakedPayload}`, {
          cause: { leakedPassword, leakedPayload },
        }),
      ),
    );
    const unexpectedError = await createOrReplayOperation(
      unavailable,
      input(),
    ).catch((caught: unknown) => caught);
    expect(unexpectedError).toBeInstanceOf(OperationStorageError);
    expectSanitizedError(unexpectedError, [leakedPassword, leakedPayload]);

    const invalid = clientWithQuery(
      vi.fn().mockResolvedValue({ rows: [{ operation_id: "x" }] }),
    );
    await expect(
      createOrReplayOperation(invalid, input()),
    ).rejects.toBeInstanceOf(OperationStorageError);
  });

  it("valida a leitura e fecha uma linha inválida", async () => {
    const query = vi.fn();
    await expect(
      getOperation(clientWithQuery(query), "invalid"),
    ).rejects.toBeInstanceOf(OperationInputError);
    expect(query).not.toHaveBeenCalled();

    const invalid = clientWithQuery(
      vi.fn().mockResolvedValue({ rows: [{ operation_id: randomUUID() }] }),
    );
    await expect(getOperation(invalid, randomUUID())).rejects.toBeInstanceOf(
      OperationStorageError,
    );
  });
});
