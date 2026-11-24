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
  | "PIN_STATE_DIVERGENT";

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
