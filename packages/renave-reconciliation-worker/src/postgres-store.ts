import {
  beginOperationReconciliation,
  claimOperationReconciliations,
  completeOperationReconciliationConfirmed,
  completeOperationReconciliationManualReview,
  listPendingOperationReconciliationProjectionKeyIds,
  preflightPendingOperationReconciliationProjectionSamples,
  assertRuntimeDatabase,
  OPERATION_WORKER_ROLE,
  releaseOperationReconciliationLease,
  renewOperationReconciliationLease,
  withTenant,
} from "@seu-renave/db";
import type { Pool } from "pg";

import type {
  ReconciliationDatabaseFence,
  ReconciliationDatabasePort,
} from "./worker.js";

const DATABASE_TOKEN = Symbol("PostgresReconciliationDatabase");
const databasePools = new WeakMap<PostgresReconciliationDatabase, Pool>();

function databasePool(database: PostgresReconciliationDatabase): Pool {
  const pool = databasePools.get(database);
  if (!pool) throw new TypeError("Adapter PostgreSQL inválido");
  return pool;
}

function withoutTenant(input: ReconciliationDatabaseFence) {
  return {
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    operationVersion: input.operationVersion,
    outboxId: input.outboxId,
  };
}

/** Adapter sem discovery; o pool deve usar exclusivamente o papel worker. */
export class PostgresReconciliationDatabase implements ReconciliationDatabasePort {
  private constructor(token: symbol, pool: Pool) {
    if (
      token !== DATABASE_TOKEN ||
      new.target !== PostgresReconciliationDatabase
    ) {
      throw new TypeError("Adapter PostgreSQL inválido");
    }
    databasePools.set(this, pool);
    Object.freeze(this);
  }

  static async create(pool: Pool): Promise<PostgresReconciliationDatabase> {
    await assertRuntimeDatabase(pool, {
      expectedRole: OPERATION_WORKER_ROLE,
    });
    return new PostgresReconciliationDatabase(DATABASE_TOKEN, pool);
  }

  begin(input: Parameters<ReconciliationDatabasePort["begin"]>[0]) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      beginOperationReconciliation(client, withoutTenant(input)),
    );
  }

  claim(input: Parameters<ReconciliationDatabasePort["claim"]>[0]) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      claimOperationReconciliations(client, input.leaseOwner, input.limit),
    );
  }

  completeConfirmed(
    input: Parameters<ReconciliationDatabasePort["completeConfirmed"]>[0],
  ) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      completeOperationReconciliationConfirmed(client, {
        ...withoutTenant(input),
        remoteRecordId: input.remoteRecordId,
        remoteState: input.remoteState,
      }),
    );
  }

  completeManual(
    input: Parameters<ReconciliationDatabasePort["completeManual"]>[0],
  ) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      completeOperationReconciliationManualReview(client, {
        ...withoutTenant(input),
        reason: input.reason,
      }),
    );
  }

  release(input: Parameters<ReconciliationDatabasePort["release"]>[0]) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      releaseOperationReconciliationLease(client, {
        ...withoutTenant(input),
        retryDelaySeconds: input.retryDelaySeconds,
      }),
    );
  }

  renew(input: Parameters<ReconciliationDatabasePort["renew"]>[0]) {
    return withTenant(databasePool(this), input.tenantId, (client) =>
      renewOperationReconciliationLease(client, withoutTenant(input)),
    );
  }

  listPendingProjectionKeyIds(tenantId: string) {
    return withTenant(databasePool(this), tenantId, (client) =>
      listPendingOperationReconciliationProjectionKeyIds(client),
    );
  }

  preflightPendingProjectionSamples(tenantId: string) {
    return withTenant(databasePool(this), tenantId, (client) =>
      preflightPendingOperationReconciliationProjectionSamples(client),
    );
  }
}

Object.freeze(PostgresReconciliationDatabase.prototype);
Object.freeze(PostgresReconciliationDatabase);
