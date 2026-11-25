import {
  type OperationReconciliationBegin,
  type OperationReconciliationClaim,
  type OperationReconciliationCompletion,
  type OperationReconciliationFence,
  type ReconciliationManualReviewReason,
  type ReconciliationRemoteState,
} from "@seu-renave/db/operation-worker";
import {
  decryptOperationReconciliationProjection,
  hasOperationReconciliationProjectionKey,
  type EncryptedOperationReconciliationProjection,
  type OperationReconciliationProjectionBinding,
  OperationReconciliationProjectionCipher,
  type OperationReconciliationProjectionV1,
  type StockEntryReconciliationProjectionV1,
} from "@seu-renave/protected-evidence";
import {
  isRenaveReconciliationReader,
  normalizeCnpj,
  readRenaveReconciliation,
  RenaveReconciliationReadError,
  RenaveReconciliationReader,
  type ReconciliationReadResult,
} from "@seu-renave/renave-connector";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECONCILIATION_HORIZON_MS = 60 * 60 * 1_000;
const RECONCILIATION_FINAL_WINDOW_TOLERANCE_MS = 5 * 60 * 1_000;
const RECONCILIATION_SCHEDULE_SECONDS = Object.freeze([60, 300, 900, 3_600]);
const REMOTE_STATES = new Set<ReconciliationRemoteState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);

export interface ReconciliationDatabaseFence extends OperationReconciliationFence {
  tenantId: string;
}

export interface ReconciliationDatabasePort {
  begin(
    input: ReconciliationDatabaseFence,
  ): Promise<OperationReconciliationBegin | null>;
  claim(input: {
    leaseOwner: string;
    limit: number;
    tenantId: string;
  }): Promise<readonly OperationReconciliationClaim[]>;
  completeConfirmed(
    input: ReconciliationDatabaseFence & {
      remoteRecordId: number;
      remoteState: ReconciliationRemoteState;
    },
  ): Promise<OperationReconciliationCompletion | null>;
  completeManual(
    input: ReconciliationDatabaseFence & {
      reason: ReconciliationManualReviewReason;
    },
  ): Promise<OperationReconciliationCompletion | null>;
  release(
    input: ReconciliationDatabaseFence & { retryAt: Date },
  ): Promise<boolean>;
  renew(input: ReconciliationDatabaseFence): Promise<boolean>;
}

export interface ReconciliationPermit {
  release(): Promise<void> | void;
}

export interface ReconciliationLimiterPort {
  /** Tenta adquirir imediatamente; nunca mantém a lease aguardando capacidade. */
  tryAcquire(
    input: {
      establishmentId: string;
      operationId: string;
      tenantId: string;
    },
    signal: AbortSignal,
  ): Promise<ReconciliationPermit | null>;
}

export interface ReconciliationClockPort {
  now(): Date;
}

export interface ReconciliationSchedulerPort {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type ReconciliationWorkerEventName =
  | "confirmed"
  | "manual_review"
  | "released"
  | "lease_lost"
  | "aborted"
  | "key_unavailable";

export interface ReconciliationWorkerEvent {
  attemptCount: number;
  event: ReconciliationWorkerEventName;
  operationId: string;
  tenantId: string;
}

export interface ReconciliationLoggerPort {
  write(event: ReconciliationWorkerEvent): void;
}

export interface ReconciliationBackoffPolicy {
  baseSeconds: number;
  maxSeconds: number;
}

export interface ReconciliationWorkerConfig {
  batchSize: number;
  environment: "homologation";
  heartbeatIntervalMs: number;
  integratorCnpj: string;
  leaseOwner: string;
  limiterBackoff: ReconciliationBackoffPolicy;
  tenantAllowlist: readonly string[];
  transientBackoff: ReconciliationBackoffPolicy;
}

export interface ReconciliationWorkerPorts {
  clock: ReconciliationClockPort;
  database: ReconciliationDatabasePort;
  limiter: ReconciliationLimiterPort;
  logger: ReconciliationLoggerPort;
  projectionCipher: OperationReconciliationProjectionCipher;
  reader: RenaveReconciliationReader;
  scheduler: ReconciliationSchedulerPort;
}

export interface ReconciliationWorkerSummary {
  aborted: number;
  claimed: number;
  confirmed: number;
  leaseLost: number;
  manualReview: number;
  released: number;
  keyUnavailable: number;
}

type Decision =
  | {
      kind: "confirmed";
      remoteRecordId: number;
      remoteState: ReconciliationRemoteState;
    }
  | { kind: "manual"; reason: ReconciliationManualReviewReason }
  | { kind: "release"; retryAt: Date }
  | { kind: "abort" };

export class ReconciliationWorkerConfigurationError extends Error {
  readonly code = "RECONCILIATION_WORKER_CONFIGURATION_INVALID";

  override get name(): string {
    return "ReconciliationWorkerConfigurationError";
  }

  constructor() {
    super("A configuração do worker de reconciliação é inválida");
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeBackoff(
  policy: ReconciliationBackoffPolicy,
): ReconciliationBackoffPolicy {
  let baseSeconds: unknown;
  let maxSeconds: unknown;
  try {
    baseSeconds = policy.baseSeconds;
    maxSeconds = policy.maxSeconds;
  } catch {
    throw new ReconciliationWorkerConfigurationError();
  }
  if (
    !Number.isInteger(baseSeconds) ||
    !Number.isInteger(maxSeconds) ||
    (baseSeconds as number) <= 0 ||
    (maxSeconds as number) < (baseSeconds as number) ||
    (maxSeconds as number) > 86_400
  ) {
    throw new ReconciliationWorkerConfigurationError();
  }
  return {
    baseSeconds: baseSeconds as number,
    maxSeconds: maxSeconds as number,
  };
}

function deterministicBackoff(
  policy: ReconciliationBackoffPolicy,
  attemptCount: number,
): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  return Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** exponent);
}

function elapsedMilliseconds(sentAt: Date, observedAt: Date): number | null {
  const sentAtMilliseconds = sentAt.getTime();
  const observedAtMilliseconds = observedAt.getTime();
  if (
    !Number.isFinite(sentAtMilliseconds) ||
    !Number.isFinite(observedAtMilliseconds) ||
    observedAtMilliseconds < sentAtMilliseconds
  ) {
    return null;
  }
  return observedAtMilliseconds - sentAtMilliseconds;
}

function windowExpiredDecision(): Decision {
  return {
    kind: "manual",
    reason: "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
  };
}

function boundedTechnicalRelease(
  sentAt: Date,
  observedAt: Date,
  delaySeconds: number,
): Decision {
  const elapsed = elapsedMilliseconds(sentAt, observedAt);
  if (elapsed === null || elapsed >= RECONCILIATION_HORIZON_MS) {
    return windowExpiredDecision();
  }
  return {
    kind: "release",
    retryAt: new Date(
      Math.min(
        observedAt.getTime() + delaySeconds * 1_000,
        sentAt.getTime() + RECONCILIATION_HORIZON_MS,
      ),
    ),
  };
}

function notObservedDecision(sentAt: Date, observedAt: Date): Decision {
  const elapsed = elapsedMilliseconds(sentAt, observedAt);
  if (elapsed === null || elapsed >= RECONCILIATION_HORIZON_MS) {
    return windowExpiredDecision();
  }
  const nextOffsetSeconds = RECONCILIATION_SCHEDULE_SECONDS.find(
    (offsetSeconds) => offsetSeconds * 1_000 > elapsed,
  );
  if (nextOffsetSeconds === undefined) return windowExpiredDecision();
  return {
    kind: "release",
    retryAt: new Date(sentAt.getTime() + nextOffsetSeconds * 1_000),
  };
}

function emptySummary(): ReconciliationWorkerSummary {
  return {
    aborted: 0,
    claimed: 0,
    confirmed: 0,
    leaseLost: 0,
    manualReview: 0,
    released: 0,
    keyUnavailable: 0,
  };
}

function addSummary(
  target: ReconciliationWorkerSummary,
  source: ReconciliationWorkerSummary,
): void {
  target.aborted += source.aborted;
  target.claimed += source.claimed;
  target.confirmed += source.confirmed;
  target.leaseLost += source.leaseLost;
  target.manualReview += source.manualReview;
  target.released += source.released;
  target.keyUnavailable += source.keyUnavailable;
}

function fence(
  tenantId: string,
  claim: OperationReconciliationClaim,
  leaseOwner: string,
  operationVersion = claim.operationVersion,
): ReconciliationDatabaseFence {
  return {
    leaseOwner,
    leaseToken: claim.leaseToken,
    operationVersion,
    outboxId: claim.outboxId,
    tenantId,
  };
}

function envelopeFrom(
  begun: OperationReconciliationBegin,
): EncryptedOperationReconciliationProjection {
  return {
    authTag: Buffer.from(begun.projectionAuthTag),
    ciphertext: Buffer.from(begun.projectionCiphertext),
    generation: Number(begun.projectionGeneration),
    keyId: begun.projectionKeyId,
    nonce: Buffer.from(begun.projectionNonce),
    projectionByteLength: begun.projectionByteLength,
    projectionKind: begun.projectionKind,
    projectionSchemaVersion: begun.projectionSchemaVersion,
  };
}

function isStockEntryReconciliationBegin(
  begun: OperationReconciliationBegin,
): begun is OperationReconciliationBegin & {
  kind: "USED_STOCK_ENTRY";
  mutationFamily: "STOCK_ENTRY";
  projectionKind: "STOCK_ENTRY_RECONCILIATION";
} {
  return (
    begun.kind === "USED_STOCK_ENTRY" &&
    begun.mutationFamily === "STOCK_ENTRY" &&
    begun.projectionKind === "STOCK_ENTRY_RECONCILIATION"
  );
}

function isStockEntryReconciliationProjection(
  projection: OperationReconciliationProjectionV1,
): projection is StockEntryReconciliationProjectionV1 {
  return !("comprador" in projection) && !("dataVenda" in projection);
}

function decryptStockEntryReconciliationProjection(
  cipher: OperationReconciliationProjectionCipher,
  envelope: EncryptedOperationReconciliationProjection,
  binding: OperationReconciliationProjectionBinding,
): StockEntryReconciliationProjectionV1 {
  const projection = decryptOperationReconciliationProjection(
    cipher,
    envelope,
    binding,
  );
  if (!isStockEntryReconciliationProjection(projection)) {
    throw new Error("stock-entry-projection-required");
  }
  return projection;
}

function bindingFrom(
  tenantId: string,
  begun: OperationReconciliationBegin,
): OperationReconciliationProjectionBinding {
  return {
    environment: "homologation",
    establishmentId: begun.establishmentId,
    generation: Number(begun.projectionGeneration),
    kind: begun.kind,
    mutationFamily: begun.mutationFamily,
    operationId: begun.operationId,
    requestSchemaVersion: begun.requestSchemaVersion,
    sourceRequestSha256: begun.sourceRequestSha256.toString("hex"),
    tenantId,
  };
}

function zeroBeginBytes(begun: OperationReconciliationBegin): void {
  begun.projectionAuthTag.fill(0);
  begun.projectionCiphertext.fill(0);
  begun.projectionNonce.fill(0);
  begun.sourceRequestSha256.fill(0);
}

interface Heartbeat {
  leaseLost(): boolean;
  signal: AbortSignal;
  stop(): Promise<void>;
}

interface WorkerState {
  allowlist: ReadonlySet<string>;
  config: Readonly<Omit<ReconciliationWorkerConfig, "tenantAllowlist">>;
  ports: {
    begin: ReconciliationDatabasePort["begin"];
    claim: ReconciliationDatabasePort["claim"];
    clockNow: ReconciliationClockPort["now"];
    completeConfirmed: ReconciliationDatabasePort["completeConfirmed"];
    completeManual: ReconciliationDatabasePort["completeManual"];
    limiterTryAcquire: ReconciliationLimiterPort["tryAcquire"];
    loggerWrite: ReconciliationLoggerPort["write"];
    projectionCipher: OperationReconciliationProjectionCipher;
    reader: RenaveReconciliationReader;
    release: ReconciliationDatabasePort["release"];
    renew: ReconciliationDatabasePort["renew"];
    schedulerSleep: ReconciliationSchedulerPort["sleep"];
  };
}

const workerStates = new WeakMap<ReconciliationWorker, WorkerState>();

function workerState(worker: ReconciliationWorker): WorkerState {
  const state = workerStates.get(worker);
  if (!state) throw new ReconciliationWorkerConfigurationError();
  return state;
}

export class ReconciliationWorker {
  constructor(
    ports: ReconciliationWorkerPorts,
    config: ReconciliationWorkerConfig,
  ) {
    if (new.target !== ReconciliationWorker) {
      throw new ReconciliationWorkerConfigurationError();
    }
    let batchSize: unknown;
    let environment: unknown;
    let heartbeatIntervalMs: unknown;
    let integratorCnpjInput: unknown;
    let leaseOwner: unknown;
    let limiterBackoff: ReconciliationBackoffPolicy;
    let tenantAllowlist: readonly string[];
    let transientBackoff: ReconciliationBackoffPolicy;
    let capturedPorts: WorkerState["ports"];
    try {
      batchSize = config.batchSize;
      environment = config.environment;
      heartbeatIntervalMs = config.heartbeatIntervalMs;
      integratorCnpjInput = config.integratorCnpj;
      leaseOwner = config.leaseOwner;
      limiterBackoff = config.limiterBackoff;
      tenantAllowlist = [...config.tenantAllowlist];
      transientBackoff = config.transientBackoff;

      const clock = ports.clock;
      const database = ports.database;
      const limiter = ports.limiter;
      const logger = ports.logger;
      const projectionCipher = ports.projectionCipher;
      const reader = ports.reader;
      const scheduler = ports.scheduler;
      const clockNow = clock.now;
      const begin = database.begin;
      const claim = database.claim;
      const completeConfirmed = database.completeConfirmed;
      const completeManual = database.completeManual;
      const release = database.release;
      const renew = database.renew;
      const limiterTryAcquire = limiter.tryAcquire;
      const loggerWrite = logger.write;
      const schedulerSleep = scheduler.sleep;
      if (
        !isRenaveReconciliationReader(reader) ||
        typeof clockNow !== "function" ||
        typeof begin !== "function" ||
        typeof claim !== "function" ||
        typeof completeConfirmed !== "function" ||
        typeof completeManual !== "function" ||
        typeof release !== "function" ||
        typeof renew !== "function" ||
        typeof limiterTryAcquire !== "function" ||
        typeof loggerWrite !== "function" ||
        typeof schedulerSleep !== "function"
      ) {
        throw new ReconciliationWorkerConfigurationError();
      }
      capturedPorts = {
        begin: begin.bind(database),
        claim: claim.bind(database),
        clockNow: clockNow.bind(clock),
        completeConfirmed: completeConfirmed.bind(database),
        completeManual: completeManual.bind(database),
        limiterTryAcquire: limiterTryAcquire.bind(limiter),
        loggerWrite: loggerWrite.bind(logger),
        projectionCipher,
        reader,
        release: release.bind(database),
        renew: renew.bind(database),
        schedulerSleep: schedulerSleep.bind(scheduler),
      };
    } catch {
      throw new ReconciliationWorkerConfigurationError();
    }
    let integratorCnpj: string;
    try {
      if (typeof integratorCnpjInput !== "string") {
        throw new ReconciliationWorkerConfigurationError();
      }
      integratorCnpj = normalizeCnpj(integratorCnpjInput);
    } catch {
      throw new ReconciliationWorkerConfigurationError();
    }
    const allowlist = new Set(
      tenantAllowlist.map((tenantId) => tenantId.toLowerCase()),
    );
    if (
      environment !== "homologation" ||
      !validUuid(leaseOwner) ||
      batchSize !== 1 ||
      !Number.isInteger(heartbeatIntervalMs) ||
      (heartbeatIntervalMs as number) < 1_000 ||
      (heartbeatIntervalMs as number) > 60_000 ||
      allowlist.size === 0 ||
      allowlist.size !== tenantAllowlist.length ||
      [...allowlist].some((tenantId) => !validUuid(tenantId))
    ) {
      throw new ReconciliationWorkerConfigurationError();
    }
    workerStates.set(this, {
      allowlist,
      config: Object.freeze({
        batchSize: 1,
        environment: "homologation" as const,
        heartbeatIntervalMs: heartbeatIntervalMs as number,
        integratorCnpj,
        leaseOwner: leaseOwner.toLowerCase(),
        limiterBackoff: Object.freeze(normalizeBackoff(limiterBackoff)),
        transientBackoff: Object.freeze(normalizeBackoff(transientBackoff)),
      }),
      ports: capturedPorts,
    });
    Object.freeze(this);
  }

  async runCycle(signal: AbortSignal = new AbortController().signal) {
    const state = workerState(this);
    const summary = emptySummary();
    for (const tenantId of state.allowlist) {
      if (signal.aborted) break;
      addSummary(summary, await this.runTenant(tenantId, signal));
    }
    return summary;
  }

  async runTenant(
    tenantId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ReconciliationWorkerSummary> {
    const state = workerState(this);
    const normalizedTenant = tenantId.toLowerCase();
    if (!state.allowlist.has(normalizedTenant)) {
      throw new ReconciliationWorkerConfigurationError();
    }
    const summary = emptySummary();
    if (signal.aborted) return summary;
    const claims = await state.ports.claim({
      leaseOwner: state.config.leaseOwner,
      limit: state.config.batchSize,
      tenantId: normalizedTenant,
    });
    summary.claimed = claims.length;
    for (const claim of claims) {
      addSummary(
        summary,
        await this.processClaim(normalizedTenant, claim, signal),
      );
    }
    return summary;
  }

  private startHeartbeat(
    databaseFence: ReconciliationDatabaseFence,
    externalSignal: AbortSignal,
  ): Heartbeat {
    const state = workerState(this);
    const stop = new AbortController();
    const lost = new AbortController();
    let leaseLost = false;
    const sleepSignal = AbortSignal.any([stop.signal, externalSignal]);
    const running = (async () => {
      for (;;) {
        try {
          await state.ports.schedulerSleep(
            state.config.heartbeatIntervalMs,
            sleepSignal,
          );
        } catch {
          if (sleepSignal.aborted) return;
          leaseLost = true;
          lost.abort();
          return;
        }
        if (sleepSignal.aborted) return;
        try {
          if (!(await state.ports.renew(databaseFence))) {
            leaseLost = true;
            lost.abort();
            return;
          }
        } catch {
          leaseLost = true;
          lost.abort();
          return;
        }
      }
    })();
    return {
      leaseLost: () => leaseLost,
      signal: lost.signal,
      stop: async () => {
        stop.abort();
        await running;
      },
    };
  }

  private event(
    event: ReconciliationWorkerEventName,
    tenantId: string,
    claim: OperationReconciliationClaim,
  ): void {
    try {
      workerState(this).ports.loggerWrite(
        Object.freeze({
          attemptCount: claim.attemptCount,
          event,
          operationId: claim.operationId,
          tenantId,
        }),
      );
    } catch {
      // Logging é best-effort e nunca altera o fence nem expõe erro do sink.
    }
  }

  private async processClaim(
    tenantId: string,
    claim: OperationReconciliationClaim,
    externalSignal: AbortSignal,
  ): Promise<ReconciliationWorkerSummary> {
    const state = workerState(this);
    const summary = emptySummary();
    const initialFence = fence(tenantId, claim, state.config.leaseOwner);
    const begun = await state.ports.begin(initialFence);
    if (!begun) {
      summary.leaseLost = 1;
      this.event("lease_lost", tenantId, claim);
      return summary;
    }
    const databaseFence = {
      ...initialFence,
      operationVersion: begun.operationVersion,
    };
    const heartbeat = this.startHeartbeat(databaseFence, externalSignal);
    const executionSignal = AbortSignal.any([externalSignal, heartbeat.signal]);
    let decision: Decision;
    let permit: ReconciliationPermit | null = null;
    let projection: StockEntryReconciliationProjectionV1 | undefined;
    let cleanupFailed = false;
    let keyUnavailable = false;
    try {
      if (externalSignal.aborted) {
        decision = { kind: "abort" };
      } else {
        try {
          let envelope: EncryptedOperationReconciliationProjection | undefined;
          try {
            if (!isStockEntryReconciliationBegin(begun)) {
              throw new Error("stock-entry-reconciliation-required");
            } else if (
              !hasOperationReconciliationProjectionKey(
                state.ports.projectionCipher,
                begun.projectionKeyId,
              )
            ) {
              keyUnavailable = true;
              decision = boundedTechnicalRelease(
                begun.sentAt,
                state.ports.clockNow(),
                deterministicBackoff(
                  state.config.transientBackoff,
                  claim.attemptCount,
                ),
              );
            } else {
              envelope = envelopeFrom(begun);
              const binding = bindingFrom(tenantId, begun);
              projection = decryptStockEntryReconciliationProjection(
                state.ports.projectionCipher,
                envelope,
                binding,
              );
            }
          } finally {
            envelope?.authTag.fill(0);
            envelope?.ciphertext.fill(0);
            envelope?.nonce.fill(0);
            zeroBeginBytes(begun);
          }
        } catch {
          decision = {
            kind: "manual",
            reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
          };
        }

        if (projection !== undefined) {
          const now = state.ports.clockNow();
          if (
            !(now instanceof Date) ||
            !Number.isFinite(now.getTime()) ||
            now.getTime() - begun.sentAt.getTime() >
              RECONCILIATION_HORIZON_MS +
                RECONCILIATION_FINAL_WINDOW_TOLERANCE_MS
          ) {
            decision = {
              kind: "manual",
              reason: "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
            };
          } else {
            try {
              permit = await state.ports.limiterTryAcquire(
                {
                  establishmentId: begun.establishmentId,
                  operationId: begun.operationId,
                  tenantId,
                },
                executionSignal,
              );
            } catch {
              permit = null;
            }
            if (!permit) {
              decision = externalSignal.aborted
                ? { kind: "abort" }
                : boundedTechnicalRelease(
                    begun.sentAt,
                    now,
                    deterministicBackoff(
                      state.config.limiterBackoff,
                      claim.attemptCount,
                    ),
                  );
            } else {
              try {
                const result = await readRenaveReconciliation(
                  state.ports.reader,
                  {
                    environment: "homologation",
                    establishmentCnpj: begun.establishmentCnpj,
                    establishmentId: begun.establishmentId,
                    integratorCnpj: state.config.integratorCnpj,
                    tenantId,
                  },
                  projection,
                  { sentAt: begun.sentAt, signal: executionSignal },
                );
                decision =
                  !(result.observedAt instanceof Date) ||
                  !Number.isFinite(result.observedAt.getTime())
                    ? {
                        kind: "manual",
                        reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
                      }
                    : this.decisionFromResult(result, begun.sentAt);
              } catch (error) {
                decision = this.decisionFromReadError(
                  error,
                  claim.attemptCount,
                  externalSignal,
                  begun.sentAt,
                  state.ports.clockNow(),
                );
              }
            }
          }
        }
      }
    } finally {
      projection = undefined;
      try {
        await permit?.release();
      } catch {
        cleanupFailed = true;
      } finally {
        await heartbeat.stop();
      }
    }

    if (cleanupFailed || heartbeat.leaseLost()) {
      summary.leaseLost = 1;
      this.event("lease_lost", tenantId, claim);
      return summary;
    }
    if (externalSignal.aborted || decision!.kind === "abort") {
      let released = false;
      try {
        released = await state.ports.release({
          ...databaseFence,
          retryAt: new Date(begun.sentAt),
        });
      } catch {
        // Resultado incerto do fence: falha fechada, sem propagar detalhe bruto.
      }
      if (released) summary.released = 1;
      else summary.leaseLost = 1;
      summary.aborted = 1;
      this.event(released ? "aborted" : "lease_lost", tenantId, claim);
      return summary;
    }
    if (decision!.kind === "release") {
      let released = false;
      try {
        released = await state.ports.release({
          ...databaseFence,
          retryAt: decision!.retryAt,
        });
      } catch {
        // Resultado incerto do fence: falha fechada, sem propagar detalhe bruto.
      }
      if (released) summary.released = 1;
      else summary.leaseLost = 1;
      if (keyUnavailable) summary.keyUnavailable = 1;
      this.event(
        released
          ? keyUnavailable
            ? "key_unavailable"
            : "released"
          : "lease_lost",
        tenantId,
        claim,
      );
      return summary;
    }
    let completed: OperationReconciliationCompletion | null = null;
    try {
      completed =
        decision!.kind === "confirmed"
          ? await state.ports.completeConfirmed({
              ...databaseFence,
              remoteRecordId: decision!.remoteRecordId,
              remoteState: decision!.remoteState,
            })
          : await state.ports.completeManual({
              ...databaseFence,
              reason: decision!.reason,
            });
    } catch {
      // Resultado incerto do fence: falha fechada, sem propagar detalhe bruto.
    }
    if (!completed) {
      summary.leaseLost = 1;
      this.event("lease_lost", tenantId, claim);
    } else if (decision!.kind === "confirmed") {
      summary.confirmed = 1;
      this.event("confirmed", tenantId, claim);
    } else {
      summary.manualReview = 1;
      this.event("manual_review", tenantId, claim);
    }
    return summary;
  }

  private decisionFromResult(
    result: ReconciliationReadResult,
    sentAt: Date,
  ): Decision {
    if (result.outcome === "confirmed") {
      if (
        !Number.isSafeInteger(result.remoteRecordId) ||
        result.remoteRecordId <= 0 ||
        !REMOTE_STATES.has(result.remoteState)
      ) {
        return {
          kind: "manual",
          reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
        };
      }
      return {
        kind: "confirmed",
        remoteRecordId: result.remoteRecordId,
        remoteState: result.remoteState,
      };
    }
    if (result.outcome === "manual_review") {
      return {
        kind: "manual",
        reason: "RENAVE_RECONCILIATION_AMBIGUOUS",
      };
    }
    if (result.outcome === "window_expired") {
      return {
        kind: "manual",
        reason: "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
      };
    }
    return notObservedDecision(sentAt, result.observedAt);
  }

  private decisionFromReadError(
    error: unknown,
    attemptCount: number,
    externalSignal: AbortSignal,
    sentAt: Date,
    observedAt: Date,
  ): Decision {
    const state = workerState(this);
    if (error instanceof RenaveReconciliationReadError) {
      if (error.category === "ABORTED") {
        return externalSignal.aborted
          ? { kind: "abort" }
          : boundedTechnicalRelease(
              sentAt,
              observedAt,
              deterministicBackoff(state.config.transientBackoff, attemptCount),
            );
      }
      if (error.category === "TRANSIENT") {
        return boundedTechnicalRelease(
          sentAt,
          observedAt,
          deterministicBackoff(state.config.transientBackoff, attemptCount),
        );
      }
    }
    return {
      kind: "manual",
      reason: "RENAVE_RECONCILIATION_UNRECOVERABLE",
    };
  }
}

Object.freeze(ReconciliationWorker.prototype);
Object.freeze(ReconciliationWorker);
