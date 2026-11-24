export { InvalidCnpjError, normalizeCnpj } from "./cnpj.js";
export {
  HttpRenaveTransport,
  RenaveHttpError,
  RenaveMutationOutcomeUnknownError,
  RenaveProtocolError,
  type HttpRenaveTransportOptions,
  type RenaveHttpRequest,
} from "./http-transport.js";
export {
  createHomologationPemMtlsClient,
  InvalidPemMtlsMaterialError,
  PemMtlsProductionBlockedError,
  RenaveMtlsOriginError,
  RenaveMtlsResponseTooLargeError,
  readBoundedResponseBody,
  type HomologationMtlsClient,
  type PemMtlsClientOptions,
  type PemMtlsMaterial,
  type PemMtlsValidationCode,
} from "./mtls-request.js";
export {
  renaveMutationRoutes,
  type CrvType,
  type OwnerDocumentType,
  type RenaveMutationOperation,
  type RenaveStockState,
  type StockEntryRequest,
  type StockEntryResponse,
  type StockEntryVehicle,
  type VehicleEligibilityDiagnosis,
  type VehicleEligibilityDebtInformation,
  type VehicleEligibilityQuery,
  type VehicleEligibilityResponse,
  type VehicleEligibilityTransferAuthorization,
  type VehicleEligibilityVehicle,
} from "./operations.js";
export {
  InvalidVehicleEligibilityQueryError,
  RenaveConnector,
  RenaveEnvironmentMismatchError,
  RenaveIdentityMismatchError,
  RenaveProductionBlockedError,
  type AuthenticatedClientIdentity,
  type EstablishmentHeaders,
  type IdentityMismatchReason,
  type MutationResult,
  type RenaveEnvironment,
  type RenaveServerContext,
  type RenaveTransport,
  type VerifiedRenaveIdentity,
} from "./connector.js";
export {
  InvalidStockEntryReconciliationError,
  reconcileStockEntry,
  type RenaveStockRecord,
  type StockEntryReconciliation,
  type StockEntryReconciliationWindow,
} from "./reconciliation.js";
