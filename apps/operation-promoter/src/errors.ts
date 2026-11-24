export type OperationPromoterErrorCode =
  | "OPERATION_PROMOTER_CONFIG_INVALID"
  | "OPERATION_PROMOTER_DATABASE_REJECTED"
  | "OPERATION_PROMOTER_DECISION_INVALID"
  | "OPERATION_PROMOTER_DENIED"
  | "OPERATION_PROMOTER_FAILED";

export class OperationPromoterError extends Error {
  override name = "OperationPromoterError";

  constructor(
    readonly code: OperationPromoterErrorCode,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super("A promoção operacional não pôde ser concluída.");
  }
}
