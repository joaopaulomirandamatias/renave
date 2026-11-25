import { createHmac } from "node:crypto";

import {
  PostgresStockExitMunicipalityCatalog,
  PostgresStockExitRateLimiter,
} from "@seu-renave/db/api-runtime";
import {
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import type { HomologationMtlsClient } from "@seu-renave/renave-connector";
import type { AuthenticatedSession } from "@seu-renave/identity";
import type { Pool } from "pg";

import type { TenantActionRunner } from "../auth/request-access-guard.js";
import {
  databaseStockEntryRuntimeKeyGenerationChecker,
  databaseVerifiedRenavePrincipalResolver,
} from "./stock-entry-operations.js";
import {
  PostgresHeldStockExitOperation,
  StockExitOperationError,
  type StockExitMutationRateLimiter,
  type StockExitOperationUseCase,
  type StockExitTemporalGuard,
} from "./stock-exit-operations.js";
import { RateLimitedStockExitPreflight } from "./stock-exit-preflight.js";
import type { PostgresStockQueryUseCase } from "./stock-query-use-case.js";
import {
  destroyStockEntrySecretBundle,
  type StockEntrySecretBundle,
} from "./stock-entry-secret-bundle.js";

const RATE_LIMIT_DOMAIN = "stock-exit-rate-limit-key-v1";

export interface StockExitRuntimeComposition {
  destroy(): void;
  mutationRateLimiter: StockExitMutationRateLimiter;
  operation: StockExitOperationUseCase;
  ready(): Promise<boolean>;
}

function copyKeyring(input: {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}): { activeKeyId: string; keys: Map<string, Buffer> } {
  return {
    activeKeyId: input.activeKeyId,
    keys: new Map(
      Array.from(input.keys, ([keyId, key]) => [keyId, Buffer.from(key)]),
    ),
  };
}

function zeroKeyring(input: { keys: ReadonlyMap<string, Buffer> }): void {
  for (const key of input.keys.values()) key.fill(0);
}

function derivedRateLimitKey(master: Buffer): Buffer {
  return createHmac("sha256", master).update(RATE_LIMIT_DOMAIN).digest();
}

export function createStockExitTemporalGuard(input: {
  certificate: Pick<HomologationMtlsClient, "isCertificateValidAt">;
  clock: Readonly<{ now(): Date }>;
  mfaMaxAgeSeconds: number;
}): StockExitTemporalGuard {
  if (
    !Number.isSafeInteger(input.mfaMaxAgeSeconds) ||
    input.mfaMaxAgeSeconds < 60 ||
    input.mfaMaxAgeSeconds > 900
  ) {
    throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
  }
  return Object.freeze({
    assert(session: AuthenticatedSession): void {
      const now = input.clock.now();
      const timestamp = now.getTime();
      if (
        !Number.isFinite(timestamp) ||
        !Number.isFinite(session.expiresAt) ||
        session.expiresAt <= timestamp ||
        session.mfaVerified !== true ||
        typeof session.mfaVerifiedAt !== "number" ||
        !Number.isFinite(session.mfaVerifiedAt) ||
        session.mfaVerifiedAt > timestamp ||
        timestamp - session.mfaVerifiedAt > input.mfaMaxAgeSeconds * 1_000
      ) {
        throw new StockExitOperationError("MFA_RECENT_REQUIRED");
      }
      if (!input.certificate.isCertificateValidAt(now)) {
        throw new StockExitOperationError("STOCK_EXIT_CERTIFICATE_UNAVAILABLE");
      }
    },
  });
}

/** Compõe apenas GET read-only + persistência HELD_LOCAL; não recebe transporte mutável. */
export function composeStockExitRuntime(input: {
  bundle: StockEntrySecretBundle;
  certificate: Pick<HomologationMtlsClient, "isCertificateValidAt">;
  mfaMaxAgeSeconds: number;
  pool: Pool;
  queryLimiter: ConstructorParameters<
    typeof RateLimitedStockExitPreflight
  >[0]["queryLimiter"];
  runner: TenantActionRunner;
  stockQuery: PostgresStockQueryUseCase;
  clock?: Readonly<{ now(): Date }>;
}): StockExitRuntimeComposition {
  let principalCrypto: RenavePrincipalCrypto | undefined;
  let requestCipher: OperationRequestCipher | undefined;
  let projectionCipher: OperationReconciliationProjectionCipher | undefined;
  let limiter: PostgresStockExitRateLimiter | undefined;
  let operation: PostgresHeldStockExitOperation | undefined;
  const operatorEncryption = copyKeyring(input.bundle.operatorCpf.encryption);
  const operatorHmac = copyKeyring(input.bundle.operatorCpf.hmac);
  const establishmentEncryption = copyKeyring(
    input.bundle.establishmentEmail.encryption,
  );
  const establishmentHmac = copyKeyring(input.bundle.establishmentEmail.hmac);
  const request = copyKeyring(input.bundle.request);
  const projection = copyKeyring(input.bundle.projection);
  const actor = Buffer.from(input.bundle.digests.actor);
  const idempotency = Buffer.from(input.bundle.digests.idempotency);
  const vehicle = Buffer.from(input.bundle.digests.vehicle);
  const limiterKey = derivedRateLimitKey(input.bundle.limiterHmacKey);
  try {
    principalCrypto = new RenavePrincipalCrypto({
      environment: "homologation",
      purposes: {
        "operator-cpf": { encryption: operatorEncryption, hmac: operatorHmac },
        "establishment-email": {
          encryption: establishmentEncryption,
          hmac: establishmentHmac,
        },
      },
    });
    requestCipher = new OperationRequestCipher({
      activeKeyId: request.activeKeyId,
      environment: "homologation",
      keys: request.keys,
    });
    projectionCipher = new OperationReconciliationProjectionCipher({
      activeKeyId: projection.activeKeyId,
      environment: "homologation",
      masterKeys: projection.keys,
    });
    limiter = new PostgresStockExitRateLimiter(input.pool, limiterKey);
    const clock = input.clock ?? { now: () => new Date() };
    operation = new PostgresHeldStockExitOperation({
      digestKeys: { actor, idempotency, vehicle },
      environment: "homologation",
      keyGeneration: {
        fingerprint: input.bundle.digests.fingerprint,
        generationId: input.bundle.digests.generationId,
      },
      keyGenerationChecker: databaseStockEntryRuntimeKeyGenerationChecker,
      municipalityCatalog: new PostgresStockExitMunicipalityCatalog(),
      preflight: new RateLimitedStockExitPreflight({
        onPermitReleaseFailure: () => undefined,
        queryLimiter: input.queryLimiter,
        stockQuery: input.stockQuery,
      }),
      principalCrypto,
      projectionCipher,
      requestCipher,
      resolver: databaseVerifiedRenavePrincipalResolver,
      runner: input.runner,
      temporalGuard: createStockExitTemporalGuard({
        certificate: input.certificate,
        clock,
        mfaMaxAgeSeconds: input.mfaMaxAgeSeconds,
      }),
    });
    let destroyed = false;
    return Object.freeze({
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        operation!.destroy();
        limiter!.destroy();
        principalCrypto!.destroy();
        requestCipher!.destroy();
        projectionCipher!.destroy();
      },
      mutationRateLimiter: {
        acquire: (requestInput: { subject: string; tenantId: string }) =>
          limiter!.acquire(requestInput),
      },
      operation,
      async ready(): Promise<boolean> {
        try {
          const { rows } = await input.pool.query<{ ready: boolean }>(
            "select renave_stock_exit_barriers.municipality_catalog_ready() ready",
          );
          return rows.length === 1 && rows[0]?.ready === true;
        } catch {
          return false;
        }
      },
    });
  } catch (error) {
    operation?.destroy();
    limiter?.destroy();
    principalCrypto?.destroy();
    requestCipher?.destroy();
    projectionCipher?.destroy();
    throw error;
  } finally {
    zeroKeyring(operatorEncryption);
    zeroKeyring(operatorHmac);
    zeroKeyring(establishmentEncryption);
    zeroKeyring(establishmentHmac);
    zeroKeyring(request);
    zeroKeyring(projection);
    actor.fill(0);
    idempotency.fill(0);
    vehicle.fill(0);
    limiterKey.fill(0);
    destroyStockEntrySecretBundle(input.bundle);
  }
}
