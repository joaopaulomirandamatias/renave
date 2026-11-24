export { bootstrapRoles, type BootstrapOptions } from "./bootstrap.js";
export {
  getAuthorizationContext,
  grantTenantUserAccess,
  TenantAccessInputError,
  type TenantUserAccessGrant,
} from "./authorization.js";
export {
  appendAuditEvent,
  listAuditEvents,
  verifyAuditChain,
  type AppendAuditEventInput,
  type AuditEvent,
  type AuditOutcome,
} from "./audit-events.js";
export {
  computeCnpjCheckDigits,
  isValidNormalizedCnpj,
  normalizeCnpj,
  parseCnpj,
} from "./cnpj.js";
export {
  credentialLinkSources,
  credentialLinkStatuses,
  confirmCredentialLinkFromPreflight,
  getCredentialLink,
  listCredentialLinkHistory,
  rejectCredentialLinkFromPreflight,
  transitionCredentialLink,
  type CredentialLink,
  type CredentialLinkHistoryEntry,
  type CredentialLinkSource,
  type CredentialLinkStatus,
  type TransitionCredentialLinkInput,
} from "./credential-links.js";
export {
  APP_ROLE,
  DEFAULT_MIGRATIONS_DIR,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  MIGRATOR_ROLE,
  OPERATION_WORKER_ROLE,
  PLATFORM_PROVISIONER_ROLE,
  PLATFORM_READER_ROLE,
  PROFILE_PROVISIONER_ROLE,
  PROFILE_READER_ROLE,
  SCHEMA,
  TENANT_SETTING,
  isLoopbackUrl,
  withCredentials,
} from "./config.js";
export {
  acquirePlatformConsolePermit,
  PlatformConsoleRateLimitContractError,
  type PlatformConsoleRateLimitDecision,
} from "./platform-console-rate-limiter.js";
export {
  decodePlatformOperatorHmacKeyBase64,
  derivePlatformActorDigest,
  derivePlatformCursorDigest,
  derivePlatformDecisionTicketDigest,
  derivePlatformReasonDigest,
  derivePlatformTraceDigest,
  PlatformDigestInputError,
} from "./platform-digests.js";
export {
  grantPlatformOperator,
  revokePlatformOperator,
  PlatformOperatorProvisioningInputError,
  type GrantPlatformOperatorInput,
  type PlatformOperatorIdentity,
  type RevokePlatformOperatorInput,
} from "./platform-operator-provisioning.js";
export {
  createEstablishment,
  getEstablishment,
  listEstablishments,
  renameEstablishment,
  type Establishment,
} from "./establishments.js";
export {
  PostgresTenantAdministration,
  TenantAdminAccessDeniedError,
  TenantAdminCnpjConflictError,
  TenantAdminIdempotencyConflictError,
  TenantAdminInputError,
  TenantAdminStorageError,
  type CreateAdminEstablishmentInput,
  type CreateAdminEstablishmentResult,
} from "./tenant-administration.js";
export {
  decodeTenantAdminHmacKeyBase64,
  PostgresTenantAdminRateLimiter,
  TenantAdminRateLimitInputError,
  type TenantAdminRateLimitResult,
  type TenantAdminRateLimitScope,
} from "./tenant-admin-rate-limiter.js";
export {
  evidenceMonitorNeedsAttention,
  getEvidenceMonitorStatus,
  scanStaleProtectedEvidence,
  EvidenceMonitorInputError,
  type EvidenceMonitorResult,
  type EvidenceMonitorStatus,
} from "./evidence-maintenance.js";
export {
  purgeExpiredIdentityBacklog,
  type IdentityPurgeBacklogOptions,
  type IdentityPurgeBacklogResult,
} from "./identity-maintenance.js";
export {
  loadMigrations,
  runMigrations,
  MigrationError,
  type Migration,
  type MigrationResult,
} from "./migrate.js";
export {
  createOrReplayHeldLocalOperation,
  getOperation,
  operationKinds,
  operationMutationFamilies,
  operationStatuses,
  OperationActiveConflictError,
  OperationCredentialLinkNotEnabledError,
  OperationIdempotencyConflictError,
  OperationIdentifierConflictError,
  OperationInputError,
  OperationStorageError,
  type CreateOperationInput,
  type CreateOperationResult,
  type OperationKind,
  type OperationMutationFamily,
  type OperationRecord,
  type OperationStatus,
} from "./operations.js";
export {
  getEstablishmentRenaveProfileStatus,
  getOperatorIdentityProfileStatus,
  resolveVerifiedRenavePrincipals,
  renaveProfileStatuses,
  RenavePrincipalResolutionStorageError,
  RenavePrincipalResolutionUnavailableError,
  RenaveProfileInputError,
  type ResolvedRenavePrincipalEnvelope,
  type ResolvedVerifiedRenavePrincipals,
  type RenaveProfileStatusValue,
} from "./renave-profiles.js";
export {
  assertProfileProvisionerSession,
  assertProfileReaderSession,
  getAdminEstablishmentRenaveProfileStatus,
  getAdminOperatorRenaveProfileStatus,
  stageEstablishmentRenaveProfile,
  stageOperatorRenaveProfile,
  suspendEstablishmentRenaveProfile,
  suspendOperatorRenaveProfile,
  RenaveProfileAdministrationContractError,
  type AdminRenaveProfileStatus,
  type AdminRenaveProfileStatusResult,
  type KeyedDigestInput,
  type ProfileEnvelopeInput,
  type RenaveProfileAdministrationResult,
  type StageEstablishmentRenaveProfileInput,
  type StageOperatorRenaveProfileInput,
  type SuspendEstablishmentRenaveProfileInput,
  type SuspendOperatorRenaveProfileInput,
} from "./renave-profile-administration.js";
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
  type OperationReconciliationProjectionPreflight,
  type OperationReconciliationFence,
  type ReconciliationManualReviewReason,
  type ReconciliationRemoteState,
} from "./operation-reconciliation.js";
export {
  assertRuntimeDatabase,
  RuntimeDatabaseContractError,
  type RuntimeDatabaseGuardOptions,
  type RuntimeDatabaseRole,
} from "./runtime-guard.js";
export {
  decodeLoginRateHmacKeyBase64,
  LoginRateLimitInputError,
  PostgresLoginRateLimiter,
  purgeStaleLoginRateBuckets,
  type LoginRateLimitResult,
  type LoginRateLimitScope,
} from "./login-rate-limiter.js";
export {
  decodeSerproQueryHmacKeyBase64,
  PostgresSerproQueryLimiter,
  SerproQueryLimitInputError,
  type SerproQueryLimitScope,
  type SerproQueryPermit,
  type SerproQueryPermitInput,
  type SerproQueryPermitResult,
} from "./serpro-query-limiter.js";
export {
  assertStockEntryRuntimeKeyGeneration,
  decodeStockEntryRateLimitHmacKeyBase64,
  PostgresStockEntryRateLimiter,
  StockEntryRuntimeKeyGenerationError,
  StockEntryRateLimitInputError,
  type StockEntryRateLimitResult,
  type StockEntryRateLimitScope,
} from "./stock-entry-rate-limiter.js";
export {
  discoverTenants,
  TenantDirectoryInputError,
  type TenantDirectoryEntry,
} from "./tenant-directory.js";
export {
  TenantContextError,
  assertTenantId,
  createPool,
  withTenant,
  type TenantClient,
} from "./tenant-context.js";
export {
  IdentitySessionStoreInputError,
  PostgresIdentitySessionStore,
  type IdentityPurgeResult,
} from "./session-store.js";
export { getCurrentTenant, provisionTenant, type Tenant } from "./tenants.js";
