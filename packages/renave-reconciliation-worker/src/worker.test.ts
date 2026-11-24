import { randomUUID } from "node:crypto";

import {
  type OperationReconciliationBegin,
  type OperationReconciliationClaim,
} from "@seu-renave/db";
import {
  encryptOperationReconciliationProjection,
  OperationReconciliationProjectionCipher,
  prepareOperationReconciliationProjection,
} from "@seu-renave/protected-evidence";
import {
  prepareRenaveMutation,
  RenaveReconciliationReadError,
  RenaveReconciliationReader,
  type ReconciliationReadResult,
  type RenaveReadOnlyTransport,
} from "@seu-renave/renave-connector";
import { describe, expect, it, vi } from "vitest";

import {
  ReconciliationWorker,
  ReconciliationWorkerConfigurationError,
  type ReconciliationDatabasePort,
  type ReconciliationLimiterPort,
  type ReconciliationSchedulerPort,
  type ReconciliationWorkerConfig,
  type ReconciliationWorkerEvent,
} from "./worker.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const OUTBOX_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_OWNER = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";
const SENT_AT = new Date("2026-11-24T10:00:00.000Z");

function request() {
  return {
    cpfOperadorResponsavel: "123.456.789-01",
    dataCompra: "2026-11-24",
    emailEstabelecimento: "estabelecimento@example.test",
    emailVendedor: "vendedor@example.test",
    valorCompra: 123_456.78,
    veiculo: {
      codigoSegurancaCrv: "12345678901",
      dataHoraMedicaoHodometro: "2026-11-24T09:00:00-03:00",
      documentoProprietarioAtual: "00000000000",
      numeroCrv: "123456789012",
      placa: "QTP4H82",
      quilometragemHodometro: 99_999,
      renavam: "10987654321",
      tipoCrv: "DIGITAL",
      tipoDocumentoProprietarioAtual: "CPF",
    },
  };
}

function matchingStockRecord() {
  return {
    codigoSegurancaCrv: "12345678901",
    entradaEstoque: {
      cpfOperadorResponsavel: "12345678901",
      dataHoraRegistro: "2026-11-24T10:00:10.000Z",
    },
    estado: "CONFIRMADO" as const,
    id: 7,
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    renavam: "10987654321",
    tipoCrv: "DIGITAL" as const,
  };
}

function cipher() {
  return new OperationReconciliationProjectionCipher({
    activeKeyId: "projection-key-v1",
    environment: "homologation",
    masterKeys: new Map([["projection-key-v1", Buffer.alloc(32, 7)]]),
  });
}

async function fixture() {
  const projectionCipher = cipher();
  const mutation = await prepareRenaveMutation(
    "request-stock-entry",
    request(),
  );
  const prepared = prepareOperationReconciliationProjection(mutation);
  const encrypted = encryptOperationReconciliationProjection(
    projectionCipher,
    prepared,
    {
      environment: "homologation",
      establishmentId: ESTABLISHMENT_ID,
      generation: 1,
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      operationId: OPERATION_ID,
      requestSchemaVersion: 1,
      sourceRequestSha256: mutation.requestSha256,
      tenantId: TENANT_ID,
    },
  );
  prepared.destroy();
  const claim: OperationReconciliationClaim = {
    attemptCount: 3,
    leaseExpiresAt: new Date("2026-11-24T10:05:00.000Z"),
    leaseToken: LEASE_TOKEN,
    operationId: OPERATION_ID,
    operationVersion: "3",
    outboxId: OUTBOX_ID,
  };
  const begun: OperationReconciliationBegin = {
    attemptCount: claim.attemptCount,
    correlationId: randomUUID(),
    establishmentCnpj: "85106037000585",
    establishmentId: ESTABLISHMENT_ID,
    kind: "USED_STOCK_ENTRY",
    leaseExpiresAt: new Date("2026-11-24T10:05:00.000Z"),
    mutationFamily: "STOCK_ENTRY",
    operationId: OPERATION_ID,
    operationVersion: "3",
    outboxId: OUTBOX_ID,
    projectionAuthTag: Buffer.from(encrypted.authTag),
    projectionByteLength: encrypted.projectionByteLength,
    projectionCiphertext: Buffer.from(encrypted.ciphertext),
    projectionGeneration: "1",
    projectionKeyId: encrypted.keyId,
    projectionKind: encrypted.projectionKind,
    projectionNonce: Buffer.from(encrypted.nonce),
    projectionSchemaVersion: encrypted.projectionSchemaVersion,
    requestSchemaVersion: 1,
    sentAt: new Date(SENT_AT),
    sourceRequestSha256: Buffer.from(mutation.requestSha256, "hex"),
  };
  return { begun, claim, projectionCipher };
}

function scheduler(): ReconciliationSchedulerPort {
  return {
    sleep: (_milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
}

function config(overrides: Partial<ReconciliationWorkerConfig> = {}) {
  return {
    batchSize: 1,
    environment: "homologation" as const,
    heartbeatIntervalMs: 1_000,
    integratorCnpj: "69.418.503/0001-88",
    leaseOwner: LEASE_OWNER,
    limiterBackoff: { baseSeconds: 2, maxSeconds: 60 },
    notObservedBackoff: { baseSeconds: 5, maxSeconds: 60 },
    tenantAllowlist: [TENANT_ID],
    transientBackoff: { baseSeconds: 3, maxSeconds: 60 },
    ...overrides,
  };
}

async function setup(
  result: ReconciliationReadResult | Error,
  options: {
    clock?: Date;
    limiter?: ReconciliationLimiterPort;
    logger?: { write(event: ReconciliationWorkerEvent): void };
    projectionCipher?: OperationReconciliationProjectionCipher;
    scheduler?: ReconciliationSchedulerPort;
  } = {},
) {
  const { begun, claim, projectionCipher } = await fixture();
  const events: ReconciliationWorkerEvent[] = [];
  const permitRelease = vi.fn();
  const database: ReconciliationDatabasePort = {
    begin: vi.fn(async () => begun),
    claim: vi.fn(async () => [claim]),
    completeConfirmed: vi.fn(async () => ({
      completedAt: new Date("2026-11-24T10:00:31.000Z"),
      operationId: OPERATION_ID,
      operationVersion: "4",
      reconcileOutboxId: OUTBOX_ID,
    })),
    completeManual: vi.fn(async () => ({
      completedAt: new Date("2026-11-24T10:00:31.000Z"),
      operationId: OPERATION_ID,
      operationVersion: "4",
      reconcileOutboxId: OUTBOX_ID,
    })),
    release: vi.fn(async () => true),
    renew: vi.fn(async () => true),
  };
  const matchingRecord = matchingStockRecord();
  const transport: RenaveReadOnlyTransport = {
    environment: "homologation",
    findStockById: vi.fn(async () => {
      throw new Error("capacidade não utilizada na reconciliação por placa");
    }),
    findRecentStocks: vi.fn(async () => {
      throw new Error("capacidade não utilizada na reconciliação por placa");
    }),
    findStocksByPlate: vi.fn(async () => {
      if (result instanceof Error) throw result;
      if (result.outcome === "confirmed") {
        return [
          {
            ...matchingRecord,
            estado: result.remoteState,
            id: result.remoteRecordId,
          },
        ];
      }
      if (result.outcome === "manual_review") {
        return [
          {
            ...matchingRecord,
            entradaEstoque: {
              dataHoraRegistro: "2026-11-24T10:00:10.000Z",
            },
          },
        ];
      }
      return [];
    }),
    getAuthenticatedClient: vi.fn(async () => ({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    })),
  };
  const reader = new RenaveReconciliationReader({
    now: () =>
      new Date(
        result instanceof Error
          ? "2026-11-24T10:00:30.000Z"
          : result.observedAt,
      ),
    transport,
  });
  const limiter =
    options.limiter ??
    ({
      tryAcquire: vi.fn(async () => ({ release: permitRelease })),
    } satisfies ReconciliationLimiterPort);
  const workerConfig = config();
  const worker = new ReconciliationWorker(
    {
      clock: {
        now: () => new Date(options.clock ?? "2026-11-24T10:00:20.000Z"),
      },
      database,
      limiter,
      logger: options.logger ?? { write: (event) => events.push(event) },
      projectionCipher: options.projectionCipher ?? projectionCipher,
      reader,
      scheduler: options.scheduler ?? scheduler(),
    },
    workerConfig,
  );
  return {
    begun,
    database,
    events,
    limiter,
    permitRelease,
    reader,
    transport,
    worker,
    workerConfig,
  };
}

describe("ReconciliationWorker", () => {
  it("executa integração fake cifra→begin→read→confirmed sem vazar PII", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "confirmed",
      remoteRecordId: 7,
      remoteState: "CONFIRMADO",
    });
    const summary = await test.worker.runCycle();

    expect(summary).toEqual({
      aborted: 0,
      claimed: 1,
      confirmed: 1,
      keyUnavailable: 0,
      leaseLost: 0,
      manualReview: 0,
      released: 0,
    });
    expect(test.database.begin).toHaveBeenCalledBefore(
      vi.mocked(test.limiter.tryAcquire),
    );
    expect(test.transport.findStocksByPlate).toHaveBeenCalledOnce();
    const [, plate, readOptions] = vi.mocked(test.transport.findStocksByPlate)
      .mock.calls[0]!;
    expect(plate).toBe("QTP4H82");
    expect(readOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(test.database.completeConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRecordId: 7, remoteState: "CONFIRMADO" }),
    );
    expect(test.permitRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify({ events: test.events, summary })).not.toMatch(
      /QTP4H82|12345678901|85106037000585/u,
    );
    expect(test.begun.projectionCiphertext.every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it.each([
    [
      "manual_review",
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "manual_review",
      },
      "RENAVE_RECONCILIATION_AMBIGUOUS",
    ],
    [
      "window_expired",
      {
        observedAt: new Date("2026-11-24T11:00:00.001Z"),
        outcome: "window_expired",
      },
      "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
    ],
  ] as const)(
    "mapeia %s para manual fechado",
    async (_label, result, reason) => {
      const test = await setup(result);
      await expect(test.worker.runCycle()).resolves.toMatchObject({
        manualReview: 1,
      });
      expect(test.database.completeManual).toHaveBeenCalledWith(
        expect.objectContaining({ reason }),
      );
      expect(test.permitRelease).toHaveBeenCalledOnce();
    },
  );

  it("not_observed e transitório liberam com backoff determinístico por attempt", async () => {
    const notObserved = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    await notObserved.worker.runCycle();
    expect(notObserved.database.release).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: 20 }),
    );

    const transient = await setup(
      new RenaveReconciliationReadError("TRANSIENT"),
    );
    await transient.worker.runCycle();
    expect(transient.database.release).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: 12 }),
    );
    expect(transient.database.completeManual).not.toHaveBeenCalled();
  });

  it("chave surgida após preflight libera com backoff e nunca vira manual", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "confirmed",
      remoteRecordId: 7,
      remoteState: "CONFIRMADO",
    });
    test.begun.projectionKeyId = "projection-key-rotated-after-preflight";
    await expect(test.worker.runCycle()).resolves.toMatchObject({
      keyUnavailable: 1,
      manualReview: 0,
      released: 1,
    });
    expect(test.database.release).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: 12 }),
    );
    expect(test.database.completeManual).not.toHaveBeenCalled();
    expect(test.database.completeConfirmed).not.toHaveBeenCalled();
    expect(test.limiter.tryAcquire).not.toHaveBeenCalled();
    expect(test.transport.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(test.transport.findStocksByPlate).not.toHaveBeenCalled();
    expect(test.events).toEqual([
      expect.objectContaining({ event: "key_unavailable" }),
    ]);
  });

  it("limiter indisponível libera antes de qualquer rede e >1h vira manual", async () => {
    const noPermit: ReconciliationLimiterPort = {
      tryAcquire: vi.fn(async () => null),
    };
    const limited = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "not_observed",
      },
      { limiter: noPermit },
    );
    await limited.worker.runCycle();
    expect(limited.transport.findStocksByPlate).not.toHaveBeenCalled();
    expect(limited.database.release).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: 8 }),
    );

    const expired = await setup(
      {
        observedAt: new Date("2026-11-24T11:00:01.000Z"),
        outcome: "not_observed",
      },
      { clock: new Date("2026-11-24T11:00:00.001Z") },
    );
    await expired.worker.runCycle();
    expect(expired.limiter.tryAcquire).not.toHaveBeenCalled();
    expect(expired.transport.findStocksByPlate).not.toHaveBeenCalled();
    expect(expired.database.completeManual).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
      }),
    );

    const boundary = await setup(
      {
        observedAt: new Date("2026-11-24T11:00:00.000Z"),
        outcome: "not_observed",
      },
      { clock: new Date("2026-11-24T11:00:00.000Z") },
    );
    await boundary.worker.runCycle();
    expect(boundary.limiter.tryAcquire).toHaveBeenCalledOnce();
    expect(boundary.transport.findStocksByPlate).toHaveBeenCalledOnce();
  });

  it.each(["IDENTITY_MISMATCH", "PROTOCOL"] as const)(
    "%s vira manual irrecoverável",
    async (category) => {
      const test = await setup(new RenaveReconciliationReadError(category));
      await test.worker.runCycle();
      expect(test.database.completeManual).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
        }),
      );
    },
  );

  it("lease lost durante GET aborta e descarta resposta sem release/completion", async () => {
    let wakeHeartbeat: (() => void) | undefined;
    const controlledScheduler: ReconciliationSchedulerPort = {
      sleep: (_milliseconds, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else wakeHeartbeat = resolve;
        }),
    };
    const test = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "confirmed",
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      },
      { scheduler: controlledScheduler },
    );
    vi.mocked(test.database.renew).mockResolvedValueOnce(false);
    vi.mocked(test.transport.findStocksByPlate).mockImplementationOnce(
      async (_headers, _plate, { signal } = {}) => {
        wakeHeartbeat?.();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new RenaveReconciliationReadError("ABORTED");
      },
    );

    await expect(test.worker.runCycle()).resolves.toMatchObject({
      leaseLost: 1,
    });
    expect(test.database.renew).toHaveBeenCalledOnce();
    expect(test.database.release).not.toHaveBeenCalled();
    expect(test.database.completeConfirmed).not.toHaveBeenCalled();
    expect(test.database.completeManual).not.toHaveBeenCalled();
    expect(test.permitRelease).toHaveBeenCalledOnce();
  });

  it("falha do heartbeat também fecha o fence e descarta qualquer resposta", async () => {
    let wakeHeartbeat: (() => void) | undefined;
    const controlledScheduler: ReconciliationSchedulerPort = {
      sleep: (_milliseconds, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else wakeHeartbeat = resolve;
        }),
    };
    const test = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "confirmed",
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      },
      { scheduler: controlledScheduler },
    );
    vi.mocked(test.database.renew).mockRejectedValueOnce(
      new Error("database secret"),
    );
    vi.mocked(test.transport.findStocksByPlate).mockImplementationOnce(
      async (_headers, _plate, { signal } = {}) => {
        wakeHeartbeat?.();
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new RenaveReconciliationReadError("ABORTED");
      },
    );

    await expect(test.worker.runCycle()).resolves.toMatchObject({
      leaseLost: 1,
    });
    expect(test.database.release).not.toHaveBeenCalled();
    expect(test.database.completeConfirmed).not.toHaveBeenCalled();
    expect(JSON.stringify(test.events)).not.toContain("database secret");
  });

  it("cifra inválida falha fechada antes do limiter e da rede", async () => {
    const tampered = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    tampered.begun.projectionCiphertext[0]! ^= 1;
    await tampered.worker.runCycle();
    expect(tampered.limiter.tryAcquire).not.toHaveBeenCalled();
    expect(tampered.transport.findStocksByPlate).not.toHaveBeenCalled();
    expect(tampered.database.completeManual).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
      }),
    );
  });

  it("abort gracioso tenta release uma única vez quando a lease ainda é válida", async () => {
    const abort = new AbortController();
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    vi.mocked(test.transport.findStocksByPlate).mockImplementationOnce(
      async () => {
        abort.abort();
        throw new RenaveReconciliationReadError("ABORTED");
      },
    );
    await expect(test.worker.runCycle(abort.signal)).resolves.toMatchObject({
      aborted: 1,
      released: 1,
    });
    expect(test.database.release).toHaveBeenCalledOnce();
    expect(test.database.completeManual).not.toHaveBeenCalled();
  });

  it("renova com sucesso antes de persistir confirmação", async () => {
    let sleeps = 0;
    const controlledScheduler: ReconciliationSchedulerPort = {
      sleep: async (_milliseconds, signal) => {
        sleeps += 1;
        if (sleeps === 1) return;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const test = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "confirmed",
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      },
      { scheduler: controlledScheduler },
    );
    vi.mocked(test.database.renew).mockResolvedValueOnce(true);

    await test.worker.runCycle();
    expect(test.database.renew).toHaveBeenCalledOnce();
    expect(
      vi.mocked(test.database.renew).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(test.database.completeConfirmed).mock.invocationCallOrder[0]!,
    );
  });

  it.each(["false", "throw"] as const)(
    "descarta confirmação tardia quando renew=%s mesmo se reader ignora abort",
    async (mode) => {
      let wakeHeartbeat: (() => void) | undefined;
      const controlledScheduler: ReconciliationSchedulerPort = {
        sleep: (_milliseconds, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else wakeHeartbeat = resolve;
          }),
      };
      const test = await setup(
        {
          observedAt: new Date("2026-11-24T10:00:30.000Z"),
          outcome: "confirmed",
          remoteRecordId: 7,
          remoteState: "CONFIRMADO",
        },
        { scheduler: controlledScheduler },
      );
      if (mode === "false") {
        vi.mocked(test.database.renew).mockResolvedValueOnce(false);
      } else {
        vi.mocked(test.database.renew).mockRejectedValueOnce(
          new Error("renew sentinel"),
        );
      }
      vi.mocked(test.transport.findStocksByPlate).mockImplementationOnce(
        async (_headers, _plate, options) => {
          wakeHeartbeat?.();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return [matchingStockRecord()];
        },
      );

      await expect(test.worker.runCycle()).resolves.toMatchObject({
        leaseLost: 1,
      });
      expect(test.database.completeConfirmed).not.toHaveBeenCalled();
      expect(test.database.completeManual).not.toHaveBeenCalled();
      expect(test.database.release).not.toHaveBeenCalled();
      expect(JSON.stringify(test.events)).not.toContain("sentinel");
    },
  );

  it("release do permit não impede stop do heartbeat e falha fechado", async () => {
    const sleep = vi.fn(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const test = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "confirmed",
        remoteRecordId: 7,
        remoteState: "CONFIRMADO",
      },
      {
        limiter: {
          tryAcquire: vi.fn(async () => ({
            release: () => {
              throw new Error("permit sentinel");
            },
          })),
        },
        scheduler: { sleep },
      },
    );

    await expect(test.worker.runCycle()).resolves.toMatchObject({
      leaseLost: 1,
    });
    expect(test.database.completeConfirmed).not.toHaveBeenCalled();
    expect(test.database.release).not.toHaveBeenCalled();
    expect(test.database.renew).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
    expect(JSON.stringify(test.events)).not.toContain("permit sentinel");
  });

  it("mantém estado nominal congelado e snapshots imunes a mutação", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    const victim = randomUUID();
    (test.workerConfig.tenantAllowlist as string[])[0] = victim;
    test.database.claim = vi.fn(async () => {
      throw new Error("mutated port");
    });
    expect(Object.keys(test.worker)).toEqual([]);
    expect(Object.isFrozen(test.worker)).toBe(true);
    expect(Object.isFrozen(ReconciliationWorker.prototype)).toBe(true);
    expect(Object.isFrozen(ReconciliationWorker)).toBe(true);
    await expect(test.worker.runTenant(TENANT_ID)).resolves.toMatchObject({
      claimed: 1,
    });
    await expect(test.worker.runTenant(victim)).rejects.toBeInstanceOf(
      ReconciliationWorkerConfigurationError,
    );
    await expect(
      ReconciliationWorker.prototype.runCycle.call(new Proxy(test.worker, {})),
    ).rejects.toBeInstanceOf(ReconciliationWorkerConfigurationError);
    class Subclass extends ReconciliationWorker {}
    expect(
      () =>
        new Subclass(
          {
            clock: { now: () => new Date() },
            database: test.database,
            limiter: test.limiter,
            logger: { write: vi.fn() },
            projectionCipher: cipher(),
            reader: test.reader,
            scheduler: scheduler(),
          },
          config(),
        ),
    ).toThrow(ReconciliationWorkerConfigurationError);
  });

  it("captura config e ports uma vez contra Proxy TOCTOU e recusa reader forjado", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    const portSource = {
      clock: { now: () => new Date("2026-11-24T10:00:20.000Z") },
      database: test.database,
      limiter: test.limiter,
      logger: { write: vi.fn() },
      projectionCipher: cipher(),
      reader: test.reader,
      scheduler: scheduler(),
    };
    const configSource = config();
    const configReads = new Map<PropertyKey, number>();
    const portReads = new Map<PropertyKey, number>();
    const configProxy = new Proxy(configSource, {
      get(target, property, receiver) {
        const count = (configReads.get(property) ?? 0) + 1;
        configReads.set(property, count);
        if (count > 1) throw new Error("config TOCTOU");
        return Reflect.get(target, property, receiver);
      },
    });
    const portsProxy = new Proxy(portSource, {
      get(target, property, receiver) {
        const count = (portReads.get(property) ?? 0) + 1;
        portReads.set(property, count);
        if (count > 1) throw new Error("ports TOCTOU");
        return Reflect.get(target, property, receiver);
      },
    });
    const worker = new ReconciliationWorker(portsProxy, configProxy);
    await expect(worker.runTenant(TENANT_ID)).resolves.toMatchObject({
      claimed: 1,
    });
    expect([...configReads.values()].every((count) => count === 1)).toBe(true);
    expect([...portReads.values()].every((count) => count === 1)).toBe(true);

    for (const reader of [
      Object.create(RenaveReconciliationReader.prototype),
      new Proxy(test.reader, {}),
    ]) {
      expect(
        () => new ReconciliationWorker({ ...portSource, reader }, config()),
      ).toThrow(ReconciliationWorkerConfigurationError);
    }
  });

  it("recusa batch paralelo, heartbeat sem margem e backoff zero", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    const ports = {
      clock: { now: () => new Date() },
      database: test.database,
      limiter: test.limiter,
      logger: { write: vi.fn() },
      projectionCipher: cipher(),
      reader: test.reader,
      scheduler: scheduler(),
    };
    for (const invalid of [
      { batchSize: 2 },
      { heartbeatIntervalMs: 60_001 },
      { heartbeatIntervalMs: 999 },
      { transientBackoff: { baseSeconds: 0, maxSeconds: 60 } },
    ]) {
      expect(() => new ReconciliationWorker(ports, config(invalid))).toThrow(
        ReconciliationWorkerConfigurationError,
      );
    }
    expect(
      () =>
        new ReconciliationWorker(
          ports,
          config({ heartbeatIntervalMs: 60_000 }),
        ),
    ).not.toThrow();
  });

  it("cipher forjado vira manual antes do limiter e da rede", async () => {
    const forged = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "not_observed",
      },
      {
        projectionCipher: Object.create(
          OperationReconciliationProjectionCipher.prototype,
        ),
      },
    );
    await forged.worker.runCycle();
    expect(forged.limiter.tryAcquire).not.toHaveBeenCalled();
    expect(forged.transport.findStocksByPlate).not.toHaveBeenCalled();
    expect(forged.database.completeManual).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
      }),
    );
  });

  it("nunca envia sentinelas de limiter, reader, logger ou persistência ao logger", async () => {
    const limiter = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "not_observed",
      },
      {
        limiter: {
          tryAcquire: vi.fn(async () => {
            throw new Error("limiter sentinel");
          }),
        },
      },
    );
    await limiter.worker.runCycle();

    const reader = await setup(
      Object.assign(new Error("reader sentinel"), {
        code: "RENAVE_HTTP_ERROR",
        status: 503,
      }),
    );
    await reader.worker.runCycle();

    const logger = await setup(
      {
        observedAt: new Date("2026-11-24T10:00:30.000Z"),
        outcome: "not_observed",
      },
      {
        logger: {
          write: () => {
            throw new Error("logger sentinel");
          },
        },
      },
    );
    await expect(logger.worker.runCycle()).resolves.toMatchObject({
      released: 1,
    });

    const persistence = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "confirmed",
      remoteRecordId: 7,
      remoteState: "CONFIRMADO",
    });
    vi.mocked(persistence.database.completeConfirmed).mockRejectedValueOnce(
      new Error("persistence sentinel"),
    );
    await expect(persistence.worker.runCycle()).resolves.toMatchObject({
      leaseLost: 1,
    });

    expect(
      JSON.stringify([
        limiter.events,
        reader.events,
        logger.events,
        persistence.events,
      ]),
    ).not.toMatch(
      /limiter sentinel|reader sentinel|logger sentinel|persistence sentinel/u,
    );
  });

  it("recusa produção e tenant fora da allowlist", async () => {
    const test = await setup({
      observedAt: new Date("2026-11-24T10:00:30.000Z"),
      outcome: "not_observed",
    });
    await expect(test.worker.runTenant(randomUUID())).rejects.toBeInstanceOf(
      ReconciliationWorkerConfigurationError,
    );
    expect(
      () =>
        new ReconciliationWorker(
          {
            clock: { now: () => new Date() },
            database: test.database,
            limiter: test.limiter,
            logger: { write: vi.fn() },
            projectionCipher: cipher(),
            reader: test.reader,
            scheduler: scheduler(),
          },
          { ...config(), environment: "production" as never },
        ),
    ).toThrow(ReconciliationWorkerConfigurationError);
  });
});
