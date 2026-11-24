import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOrReplayOperation,
  getOperation,
  OperationActiveConflictError,
  OperationIdempotencyConflictError,
  OperationInputError,
  OperationStorageError,
  type CreateOperationInput,
} from "../../src/operations.js";
import type { TenantClient } from "../../src/tenant-context.js";

function input(): CreateOperationInput {
  return {
    actorSubjectHash: Buffer.alloc(32, 1),
    correlationId: randomUUID(),
    establishmentId: randomUUID(),
    idempotencyKeyDigest: Buffer.alloc(32, 2),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 3),
    requestCiphertext: Buffer.from("ciphertext"),
    requestKeyId: "operation-key-v1",
    requestNonce: Buffer.alloc(12, 4),
    requestSchemaVersion: 1,
    requestSha256: Buffer.alloc(32, 5),
    vehicleKeyDigest: Buffer.alloc(32, 6),
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
    ]) {
      buffer.fill(9);
    }

    const capturedBuffers = [3, 4, 5, 9, 10, 11, 12].map(
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
    expect(query.mock.calls[0]?.[1]?.[8]).toBe(candidate.requestKeyId);
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
