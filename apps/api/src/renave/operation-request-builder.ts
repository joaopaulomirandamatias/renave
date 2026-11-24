import type {
  CreateOperationInput,
  OperationKind,
  OperationMutationFamily,
} from "@seu-renave/db";
import {
  encryptOperationRequest,
  OperationRequestCipher,
  type EncryptedOperationRequest,
  type OperationRequestBinding,
} from "@seu-renave/protected-evidence";
import type {
  PreparedRenaveMutation,
  RenaveEnvironment,
  RenaveMutationOperation,
} from "@seu-renave/renave-connector";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface OperationDefinition {
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  requestSchemaVersion: number;
}

const operationDefinitions = {
  "request-stock-entry": {
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestSchemaVersion: 1,
  },
} as const satisfies Record<RenaveMutationOperation, OperationDefinition>;

export interface BuildCreateOperationInput {
  actorSubjectHash: Uint8Array;
  correlationId: string;
  environment: RenaveEnvironment;
  establishmentId: string;
  idempotencyKeyDigest: Uint8Array;
  prepared: PreparedRenaveMutation;
  tenantId: string;
  vehicleKeyDigest: Uint8Array;
}

export class OperationRequestBuilderError extends Error {
  override name = "OperationRequestBuilderError";

  constructor() {
    super("A operação RENAVE não pôde ser montada.");
  }
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OperationRequestBuilderError();
  }
  return value.toLowerCase();
}

function digest(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new OperationRequestBuilderError();
  }
  return Buffer.from(value);
}

function definitionFor(
  operation: RenaveMutationOperation,
): OperationDefinition {
  const definition = operationDefinitions[operation];
  if (!definition) throw new OperationRequestBuilderError();
  return definition;
}

function assertEncryptedOperation(
  encrypted: EncryptedOperationRequest,
  prepared: PreparedRenaveMutation,
): void {
  if (
    encrypted.operation !== prepared.operation ||
    encrypted.requestSha256 !== prepared.requestSha256 ||
    encrypted.requestByteLength !== prepared.byteLength ||
    !KEY_ID_PATTERN.test(encrypted.keyId) ||
    !(encrypted.nonce instanceof Uint8Array) ||
    encrypted.nonce.byteLength !== 12 ||
    !(encrypted.authTag instanceof Uint8Array) ||
    encrypted.authTag.byteLength !== 16 ||
    !(encrypted.ciphertext instanceof Uint8Array) ||
    encrypted.ciphertext.byteLength !== prepared.byteLength
  ) {
    throw new OperationRequestBuilderError();
  }
}

/**
 * Monta de forma atômica o envelope coerente esperado pelo repositório.
 * Não persiste, não consulta identidade e não conhece transporte HTTP.
 */
export function buildCreateOperationInput(
  cipher: OperationRequestCipher,
  input: BuildCreateOperationInput,
): CreateOperationInput {
  const tenantId = uuid(input.tenantId);
  const establishmentId = uuid(input.establishmentId);
  const correlationId = uuid(input.correlationId);
  const actorSubjectHash = digest(input.actorSubjectHash);
  const idempotencyKeyDigest = digest(input.idempotencyKeyDigest);
  const vehicleKeyDigest = digest(input.vehicleKeyDigest);
  const definition = definitionFor(input.prepared.operation);
  if (
    (input.environment !== "homologation" &&
      input.environment !== "production") ||
    !SHA256_PATTERN.test(input.prepared.requestSha256)
  ) {
    throw new OperationRequestBuilderError();
  }

  const binding: OperationRequestBinding = {
    actorSubjectHash,
    correlationId,
    environment: input.environment,
    establishmentId,
    idempotencyKeyDigest,
    kind: definition.kind,
    mutationFamily: definition.mutationFamily,
    requestSchemaVersion: definition.requestSchemaVersion,
    tenantId,
    vehicleKeyDigest,
  };
  const encrypted = encryptOperationRequest(cipher, input.prepared, binding);
  assertEncryptedOperation(encrypted, input.prepared);

  return {
    actorSubjectHash: Buffer.from(actorSubjectHash),
    correlationId,
    establishmentId,
    idempotencyKeyDigest: Buffer.from(idempotencyKeyDigest),
    kind: definition.kind,
    mutationFamily: definition.mutationFamily,
    requestAuthTag: Buffer.from(encrypted.authTag),
    requestCiphertext: Buffer.from(encrypted.ciphertext),
    requestKeyId: encrypted.keyId,
    requestNonce: Buffer.from(encrypted.nonce),
    requestSchemaVersion: definition.requestSchemaVersion,
    requestSha256: Buffer.from(encrypted.requestSha256, "hex"),
    vehicleKeyDigest: Buffer.from(vehicleKeyDigest),
  };
}
