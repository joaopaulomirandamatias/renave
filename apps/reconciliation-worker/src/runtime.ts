import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assertRuntimeDatabase,
  createPool,
  decodeSerproQueryHmacKeyBase64,
  OPERATION_WORKER_ROLE,
  PostgresSerproQueryLimiter,
} from "@seu-renave/db";
import {
  decryptOperationReconciliationProjection,
  hasOperationReconciliationProjectionKey,
  OperationReconciliationProjectionCipher,
  type EncryptedOperationReconciliationProjection,
  type OperationReconciliationProjectionBinding,
} from "@seu-renave/protected-evidence";
import {
  createHomologationPemMtlsClient,
  createHomologationRenaveReadOnlyRequest,
  HttpRenaveReadOnlyTransport,
  RenaveReconciliationReader,
  type HomologationMtlsClient,
  type PemMtlsMaterial,
} from "@seu-renave/renave-connector";
import {
  PostgresReconciliationDatabase,
  ReconciliationWorker,
  type ReconciliationLimiterPort,
} from "@seu-renave/renave-reconciliation-worker";
import type { Pool } from "pg";

import type { EnabledWorkerConfig } from "./config.js";
import { SanitizedWorkerLogger } from "./logger.js";

const TECHNICAL_SUBJECT = "renave-reconciliation-worker-v1";

export interface OperationalRuntime {
  preflight(signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
  worker: ReconciliationWorker;
}

export interface OperationalRuntimeFactories {
  createMtlsClient(material: PemMtlsMaterial): HomologationMtlsClient;
  createPool(config: EnabledWorkerConfig): Promise<Pool>;
  readMtlsMaterial(config: EnabledWorkerConfig): Promise<PemMtlsMaterial>;
}

async function defaultPool(config: EnabledWorkerConfig): Promise<Pool> {
  const ca = config.databaseTlsCaFile
    ? await readFile(config.databaseTlsCaFile, "utf8")
    : undefined;
  return createPool(config.databaseUrl, {
    application_name: "seu-renave-reconciliation-worker",
    connectionTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    lock_timeout: 5_000,
    max: 4,
    query_timeout: 17_000,
    statement_timeout: 15_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
}

async function defaultMaterial(
  config: EnabledWorkerConfig,
): Promise<PemMtlsMaterial> {
  const [ca, cert, key] = await Promise.all([
    readFile(config.mtlsCaFile, "utf8"),
    readFile(config.mtlsCertificateFile, "utf8"),
    readFile(config.mtlsKeyFile, "utf8"),
  ]);
  return {
    ca,
    cert,
    key,
    ...(config.mtlsKeyPassphrase === undefined
      ? {}
      : { passphrase: config.mtlsKeyPassphrase }),
  };
}

const defaultFactories: OperationalRuntimeFactories = {
  createMtlsClient: (material) =>
    createHomologationPemMtlsClient("homologation", material),
  createPool: defaultPool,
  readMtlsMaterial: defaultMaterial,
};

class DistributedLimiterAdapter implements ReconciliationLimiterPort {
  readonly #limiter: PostgresSerproQueryLimiter;

  constructor(limiter: PostgresSerproQueryLimiter) {
    this.#limiter = limiter;
    Object.freeze(this);
  }

  async tryAcquire(
    input: { establishmentId: string; operationId: string; tenantId: string },
    signal: AbortSignal,
  ) {
    if (signal.aborted) return null;
    const result = await this.#limiter.acquire({
      establishmentId: input.establishmentId,
      subject: TECHNICAL_SUBJECT,
      tenantId: input.tenantId,
    });
    return result.allowed ? result.permit : null;
  }
}

function decodeProjectionKeys(
  configured: EnabledWorkerConfig["projectionKeysBase64"],
): Map<string, Buffer> {
  const decoded = new Map<string, Buffer>();
  try {
    for (const { keyBase64, keyId } of configured) {
      decoded.set(keyId, Buffer.from(keyBase64, "base64"));
    }
    return decoded;
  } catch (error) {
    for (const key of decoded.values()) key.fill(0);
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operação abortada", "AbortError");
}

export async function createOperationalRuntime(
  config: EnabledWorkerConfig,
  signal: AbortSignal,
  factories: OperationalRuntimeFactories = defaultFactories,
): Promise<OperationalRuntime> {
  let pool: Pool | undefined;
  let mtls: HomologationMtlsClient | undefined;
  let projectionCipher: OperationReconciliationProjectionCipher | undefined;
  let limiter: PostgresSerproQueryLimiter | undefined;
  let poolErrorHandler: ((error: Error) => void) | undefined;
  let poolHealthy = true;
  const projectionKeyConfig = Object.freeze(
    config.projectionKeysBase64.map(({ keyBase64, keyId }) =>
      Object.freeze({ keyBase64, keyId }),
    ),
  );
  const tenantAllowlist = Object.freeze([...config.tenantAllowlist]);
  const decodedKeys = decodeProjectionKeys(projectionKeyConfig);
  let limiterKey: Buffer | undefined;
  try {
    limiterKey = decodeSerproQueryHmacKeyBase64(config.limiterHmacKeyBase64);
    if (
      [...decodedKeys.values()].some(
        (projectionKey) =>
          projectionKey.byteLength === limiterKey!.byteLength &&
          timingSafeEqual(projectionKey, limiterKey!),
      )
    ) {
      throw new Error("Material criptográfico inválido");
    }
    throwIfAborted(signal);
    pool = await factories.createPool(config);
    poolErrorHandler = () => {
      poolHealthy = false;
    };
    pool.on("error", poolErrorHandler);
    throwIfAborted(signal);
    const database = await PostgresReconciliationDatabase.create(pool);
    throwIfAborted(signal);
    const material = await factories.readMtlsMaterial(config);
    throwIfAborted(signal);
    mtls = factories.createMtlsClient(material);
    throwIfAborted(signal);
    const isCertificateValidAt = mtls.isCertificateValidAt.bind(mtls);
    const mtlsClose = mtls.close.bind(mtls);
    const mtlsRequest = mtls.request;
    const readRequest = createHomologationRenaveReadOnlyRequest(
      "homologation",
      mtlsRequest,
    );
    const reader = new RenaveReconciliationReader({
      now: () => new Date(),
      transport: new HttpRenaveReadOnlyTransport({
        environment: "homologation",
        request: readRequest,
      }),
    });
    projectionCipher = new OperationReconciliationProjectionCipher({
      activeKeyId: config.activeProjectionKeyId,
      environment: "homologation",
      masterKeys: decodedKeys,
    });
    limiter = new PostgresSerproQueryLimiter(pool, limiterKey);
    const worker = new ReconciliationWorker(
      {
        clock: { now: () => new Date() },
        database,
        limiter: new DistributedLimiterAdapter(limiter),
        logger: new SanitizedWorkerLogger(),
        projectionCipher,
        reader,
        scheduler: {
          sleep: async (milliseconds, signal) => {
            await sleep(milliseconds, undefined, { signal });
          },
        },
      },
      {
        batchSize: 1,
        environment: "homologation",
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        integratorCnpj: config.integratorCnpj,
        leaseOwner: config.leaseOwner,
        limiterBackoff: { baseSeconds: 15, maxSeconds: 300 },
        notObservedBackoff: { baseSeconds: 60, maxSeconds: 900 },
        tenantAllowlist,
        transientBackoff: { baseSeconds: 30, maxSeconds: 600 },
      },
    );
    throwIfAborted(signal);
    let closed = false;
    return Object.freeze({
      preflight: async (preflightSignal: AbortSignal) => {
        throwIfAborted(preflightSignal);
        if (!poolHealthy) return false;
        await assertRuntimeDatabase(pool!, {
          expectedRole: OPERATION_WORKER_ROLE,
        });
        throwIfAborted(preflightSignal);
        if (!poolHealthy || !isCertificateValidAt(new Date())) {
          return false;
        }
        for (const tenantId of tenantAllowlist) {
          throwIfAborted(preflightSignal);
          const pending =
            await database.preflightPendingProjectionSamples(tenantId);
          throwIfAborted(preflightSignal);
          let tenantReady = true;
          try {
            for (const projection of pending) {
              if (
                !hasOperationReconciliationProjectionKey(
                  projectionCipher!,
                  projection.projectionKeyId,
                )
              ) {
                tenantReady = false;
              } else {
                const envelope: EncryptedOperationReconciliationProjection = {
                  authTag: projection.projectionAuthTag,
                  ciphertext: projection.projectionCiphertext,
                  generation: Number(projection.projectionGeneration),
                  keyId: projection.projectionKeyId,
                  nonce: projection.projectionNonce,
                  projectionByteLength: projection.projectionByteLength,
                  projectionKind: projection.projectionKind,
                  projectionSchemaVersion: projection.projectionSchemaVersion,
                };
                const binding: OperationReconciliationProjectionBinding = {
                  environment: "homologation",
                  establishmentId: projection.establishmentId,
                  generation: Number(projection.projectionGeneration),
                  kind: projection.kind,
                  mutationFamily: projection.mutationFamily,
                  operationId: projection.operationId,
                  requestSchemaVersion: projection.requestSchemaVersion,
                  sourceRequestSha256:
                    projection.sourceRequestSha256.toString("hex"),
                  tenantId,
                };
                decryptOperationReconciliationProjection(
                  projectionCipher!,
                  envelope,
                  binding,
                );
              }
            }
          } finally {
            for (const projection of pending) {
              projection.projectionAuthTag.fill(0);
              projection.projectionCiphertext.fill(0);
              projection.projectionNonce.fill(0);
              projection.sourceRequestSha256.fill(0);
            }
          }
          if (!tenantReady) return false;
        }
        throwIfAborted(preflightSignal);
        return true;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        let cleanupFailed = false;
        try {
          projectionCipher!.destroy();
        } catch {
          cleanupFailed = true;
        }
        try {
          limiter!.destroy();
        } catch {
          cleanupFailed = true;
        }
        try {
          mtlsClose();
        } catch {
          cleanupFailed = true;
        }
        try {
          await pool!.end();
        } catch {
          cleanupFailed = true;
        } finally {
          if (poolErrorHandler) pool!.off("error", poolErrorHandler);
        }
        if (cleanupFailed) throw new Error("Falha ao encerrar runtime");
      },
      worker,
    });
  } catch (error) {
    try {
      projectionCipher?.destroy();
    } catch {
      // Continua limpando os demais recursos.
    }
    try {
      limiter?.destroy();
    } catch {
      // Continua limpando os demais recursos.
    }
    try {
      mtls?.close();
    } catch {
      // Continua limpando os demais recursos.
    }
    await pool?.end().catch(() => undefined);
    if (pool && poolErrorHandler) pool.off("error", poolErrorHandler);
    throw error;
  } finally {
    limiterKey?.fill(0);
    for (const key of decodedKeys.values()) key.fill(0);
    decodedKeys.clear();
  }
}
