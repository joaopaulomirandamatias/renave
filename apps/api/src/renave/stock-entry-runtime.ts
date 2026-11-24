import { PostgresStockEntryRateLimiter } from "@seu-renave/db/api-runtime";
import {
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import type { Pool } from "pg";

import type { TenantActionRunner } from "../auth/request-access-guard.js";
import {
  databaseStockEntryRuntimeKeyGenerationChecker,
  databaseVerifiedRenavePrincipalResolver,
  PostgresHeldStockEntryOperation,
  type StockEntryMutationRateLimiter,
  type StockEntryOperationUseCase,
} from "./stock-entry-operations.js";
import {
  destroyStockEntrySecretBundle,
  type StockEntrySecretBundle,
} from "./stock-entry-secret-bundle.js";

export interface StockEntryRuntimeComposition {
  destroy(): void;
  mutationRateLimiter: StockEntryMutationRateLimiter;
  operation: StockEntryOperationUseCase;
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

/**
 * Compõe somente a retenção local. Não recebe conector, mTLS, outbox ou sender,
 * tornando impossível ampliar acidentalmente o efeito deste runtime.
 */
export function composeStockEntryRuntime(input: {
  bundle: StockEntrySecretBundle;
  pool: Pool;
  runner: TenantActionRunner;
}): StockEntryRuntimeComposition {
  let principalCrypto: RenavePrincipalCrypto | undefined;
  let requestCipher: OperationRequestCipher | undefined;
  let projectionCipher: OperationReconciliationProjectionCipher | undefined;
  let limiter: PostgresStockEntryRateLimiter | undefined;
  let operation: PostgresHeldStockEntryOperation | undefined;
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
  const limiterKey = Buffer.from(input.bundle.limiterHmacKey);
  try {
    principalCrypto = new RenavePrincipalCrypto({
      environment: "homologation",
      purposes: {
        "operator-cpf": {
          encryption: operatorEncryption,
          hmac: operatorHmac,
        },
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
    limiter = new PostgresStockEntryRateLimiter(input.pool, limiterKey);
    operation = new PostgresHeldStockEntryOperation({
      digestKeys: { actor, idempotency, vehicle },
      environment: "homologation",
      keyGeneration: {
        fingerprint: input.bundle.digests.fingerprint,
        generationId: input.bundle.digests.generationId,
      },
      keyGenerationChecker: databaseStockEntryRuntimeKeyGenerationChecker,
      principalCrypto,
      projectionCipher,
      requestCipher,
      resolver: databaseVerifiedRenavePrincipalResolver,
      runner: input.runner,
    });
    let destroyed = false;
    const result = {
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
    } satisfies StockEntryRuntimeComposition;
    return Object.freeze(result);
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
