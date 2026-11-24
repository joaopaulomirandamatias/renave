import { describe, expect, it } from "vitest";

import * as operationWorker from "@seu-renave/db/operation-worker";

describe("entrypoint fechado do operation worker", () => {
  it("expõe somente capacidades de tenant, reconciliação, guard e limiter", () => {
    expect(Object.keys(operationWorker).sort()).toEqual([
      "OPERATION_WORKER_ROLE",
      "OperationReconciliationInputError",
      "OperationReconciliationStorageError",
      "PostgresSerproQueryLimiter",
      "RuntimeDatabaseContractError",
      "SerproQueryLimitInputError",
      "assertRuntimeDatabase",
      "beginOperationReconciliation",
      "claimOperationReconciliations",
      "completeOperationReconciliationConfirmed",
      "completeOperationReconciliationManualReview",
      "createPool",
      "decodeSerproQueryHmacKeyBase64",
      "listPendingOperationReconciliationProjectionKeyIds",
      "preflightPendingOperationReconciliationProjectionSamples",
      "reconciliationManualReviewReasons",
      "releaseOperationReconciliationLease",
      "renewOperationReconciliationLease",
      "withTenant",
    ]);
    expect(operationWorker).not.toHaveProperty("bootstrapRoles");
    expect(operationWorker).not.toHaveProperty("runMigrations");
    expect(operationWorker).not.toHaveProperty("LOCAL_DEFAULTS");
  });
});
