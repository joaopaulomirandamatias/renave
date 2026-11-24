/** Entrada offline mínima para promover operações locais já seladas. */
export { OPERATION_PROMOTER_ROLE } from "./config.js";
export {
  promoteHeldLocalOperation,
  OperationPromotionDeniedError,
  type PromoteHeldLocalOperationInput,
  type PromoteHeldLocalOperationResult,
} from "./operations.js";
export {
  assertRuntimeDatabase,
  RuntimeDatabaseContractError,
} from "./runtime-guard.js";
export { createPool, withTenant, type TenantClient } from "./tenant-context.js";
