/** Entry point fechado para o worker de reconciliação. Sem CLI/admin/migrations. */
export { OPERATION_WORKER_ROLE } from "./config.js";
export {
  beginOperationReconciliation,
  claimOperationReconciliations,
  completeOperationReconciliationConfirmed,
  completeOperationReconciliationManualReview,
  listPendingOperationReconciliationProjectionKeyIds,
  preflightPendingOperationReconciliationProjectionSamples,
  reconciliationManualReviewReasons,
  releaseOperationReconciliationLease,
  renewOperationReconciliationLease,
  OperationReconciliationInputError,
  OperationReconciliationStorageError,
  type OperationReconciliationBegin,
  type OperationReconciliationClaim,
  type OperationReconciliationCompletion,
  type OperationReconciliationFence,
  type OperationReconciliationProjectionPreflight,
  type ReconciliationManualReviewReason,
  type ReconciliationRemoteState,
} from "./operation-reconciliation.js";
export type { OperationKind, OperationMutationFamily } from "./operations.js";
export {
  assertRuntimeDatabase,
  RuntimeDatabaseContractError,
  type RuntimeDatabaseGuardOptions,
  type RuntimeDatabaseRole,
} from "./runtime-guard.js";
export {
  decodeSerproQueryHmacKeyBase64,
  PostgresSerproQueryLimiter,
  SerproQueryLimitInputError,
  type SerproQueryLimitScope,
  type SerproQueryPermit,
  type SerproQueryPermitInput,
  type SerproQueryPermitResult,
} from "./serpro-query-limiter.js";
export { createPool, withTenant, type TenantClient } from "./tenant-context.js";
