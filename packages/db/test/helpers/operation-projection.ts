import { randomBytes, randomUUID } from "node:crypto";

import type { CreateOperationInput } from "../../src/operations.js";

type ProjectionFields = Pick<
  CreateOperationInput,
  | "operationId"
  | "reconciliationProjectionAuthTag"
  | "reconciliationProjectionByteLength"
  | "reconciliationProjectionCiphertext"
  | "reconciliationProjectionGeneration"
  | "reconciliationProjectionKeyId"
  | "reconciliationProjectionKind"
  | "reconciliationProjectionNonce"
  | "reconciliationProjectionSchemaVersion"
>;

export function operationProjectionFields(
  label: string,
  kind: ProjectionFields["reconciliationProjectionKind"] = "STOCK_ENTRY_RECONCILIATION",
): ProjectionFields {
  const ciphertext = Buffer.from(`projection:${label}`, "utf8");
  return {
    operationId: randomUUID(),
    reconciliationProjectionAuthTag: randomBytes(16),
    reconciliationProjectionByteLength: ciphertext.byteLength,
    reconciliationProjectionCiphertext: ciphertext,
    reconciliationProjectionGeneration: 1,
    reconciliationProjectionKeyId: "test-projection-key-v1",
    reconciliationProjectionKind: kind,
    reconciliationProjectionNonce: randomBytes(12),
    reconciliationProjectionSchemaVersion: 1,
  };
}
