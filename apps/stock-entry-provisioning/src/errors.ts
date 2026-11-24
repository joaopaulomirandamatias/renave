export type StockEntryProvisioningErrorCode =
  | "BUNDLE_GENERATION_FAILED"
  | "BUNDLE_INPUT_INVALID"
  | "BUNDLE_OUTPUT_EXISTS"
  | "BUNDLE_OUTPUT_INSECURE"
  | "BUNDLE_PUBLISHED_DURABILITY_UNCERTAIN"
  | "DATABASE_CONFIG_INVALID"
  | "DATABASE_ROLE_INVALID"
  | "PIN_CONFIRMATION_INVALID"
  | "PIN_NOT_PROVISIONED"
  | "PIN_PROVISIONING_FAILED"
  | "PIN_STATE_DIVERGENT"
  | "PROFILE_ADMIN_KEY_EXISTS"
  | "PROFILE_ADMIN_KEY_GENERATION_FAILED"
  | "PROFILE_ADMIN_KEY_INVALID"
  | "PROFILE_ADMIN_KEY_PUBLISHED_DURABILITY_UNCERTAIN"
  | "PROFILE_CONFIRMATION_INVALID"
  | "PROFILE_INPUT_INVALID"
  | "PROFILE_PROVISIONING_FAILED"
  | "PROFILE_VERIFICATION_UNAVAILABLE";

export class StockEntryProvisioningError extends Error {
  override name = "StockEntryProvisioningError";

  constructor(readonly code: StockEntryProvisioningErrorCode) {
    super(code);
  }
}

export function provisioningError(
  error: unknown,
  fallback: StockEntryProvisioningErrorCode,
): StockEntryProvisioningError {
  return error instanceof StockEntryProvisioningError
    ? error
    : new StockEntryProvisioningError(fallback);
}
