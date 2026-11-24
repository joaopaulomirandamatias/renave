import { randomUUID } from "node:crypto";

import type {
  CreateHeldLocalOperationInput,
  OperationKind,
  OperationMutationFamily,
} from "@seu-renave/db/api-runtime";
import {
  encryptOperationReconciliationProjection,
  encryptOperationRequest,
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  prepareOperationReconciliationProjection,
  type EncryptedOperationReconciliationProjection,
  type EncryptedOperationRequest,
  type OperationRequestBinding,
} from "@seu-renave/protected-evidence";
import type {
  PreparedRenaveMutation,
  RenaveEnvironment,
  RenaveMutationOperation,
} from "@seu-renave/renave-connector";
import { readPreparedRenaveMutation } from "@seu-renave/renave-connector";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface OperationDefinition {
  kind: OperationKind;
  mutationFamily: OperationMutationFamily;
  reconciliationProjectionKind: CreateHeldLocalOperationInput["reconciliationProjectionKind"];
  requestSchemaVersion: number;
}

const operationDefinitions = {
  "request-stock-entry": {
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    reconciliationProjectionKind: "STOCK_ENTRY_RECONCILIATION",
    requestSchemaVersion: 1,
  },
  "request-stock-exit": {
    kind: "USED_STOCK_EXIT",
    mutationFamily: "STOCK_EXIT",
    reconciliationProjectionKind: "STOCK_EXIT_RECONCILIATION",
    requestSchemaVersion: 1,
  },
} as const satisfies Record<RenaveMutationOperation, OperationDefinition>;

export interface BuildCreateOperationInput {
  actorSubjectHash: Uint8Array;
  correlationId: string;
  environment: RenaveEnvironment;
  establishmentId: string;
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  idempotencyKeyDigest: Uint8Array;
  /**
   * Recurso de uso único cujo ownership é transferido ao builder. A chamada
   * sempre o destrói antes de retornar ou lançar; o chamador não pode reutilizá-lo.
   */
  prepared: PreparedRenaveMutation;
  operatorProfileId: string;
  operatorProfileVersion: string;
  subject: string;
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
  prepared: {
    byteLength: number;
    operation: RenaveMutationOperation;
    requestSha256: string;
  },
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

function assertEncryptedProjection(
  encrypted: EncryptedOperationReconciliationProjection,
  operationId: string,
  definition: OperationDefinition,
): void {
  if (
    encrypted.projectionKind !== definition.reconciliationProjectionKind ||
    encrypted.projectionSchemaVersion !== 1 ||
    encrypted.generation !== 1 ||
    !KEY_ID_PATTERN.test(encrypted.keyId) ||
    !(encrypted.nonce instanceof Uint8Array) ||
    encrypted.nonce.byteLength !== 12 ||
    !(encrypted.authTag instanceof Uint8Array) ||
    encrypted.authTag.byteLength !== 16 ||
    !(encrypted.ciphertext instanceof Uint8Array) ||
    encrypted.projectionByteLength !== encrypted.ciphertext.byteLength ||
    encrypted.projectionByteLength < 1 ||
    encrypted.projectionByteLength > 4096 ||
    !UUID_PATTERN.test(operationId)
  ) {
    throw new OperationRequestBuilderError();
  }
}

/**
 * Monta de forma atômica o envelope coerente esperado pelo repositório.
 * Não persiste, não consulta identidade e não conhece transporte HTTP.
 * Consome e destrói `input.prepared` no sucesso e em qualquer falha.
 */
export function buildCreateOperationInput(
  requestCipher: OperationRequestCipher,
  projectionCipher: OperationReconciliationProjectionCipher,
  input: BuildCreateOperationInput,
): CreateHeldLocalOperationInput {
  let actorSubjectHash: Buffer | undefined;
  let idempotencyKeyDigest: Buffer | undefined;
  let vehicleKeyDigest: Buffer | undefined;
  let encryptedRequest: EncryptedOperationRequest | undefined;
  let encryptedProjection:
    EncryptedOperationReconciliationProjection | undefined;
  let preparedProjection:
    ReturnType<typeof prepareOperationReconciliationProjection> | undefined;
  let prepared: PreparedRenaveMutation | undefined;
  try {
    prepared = input.prepared;
    const captured = {
      actorSubjectHash: input.actorSubjectHash,
      correlationId: input.correlationId,
      environment: input.environment,
      establishmentId: input.establishmentId,
      establishmentProfileId: input.establishmentProfileId,
      establishmentProfileVersion: input.establishmentProfileVersion,
      idempotencyKeyDigest: input.idempotencyKeyDigest,
      operatorProfileId: input.operatorProfileId,
      operatorProfileVersion: input.operatorProfileVersion,
      prepared,
      subject: input.subject,
      tenantId: input.tenantId,
      vehicleKeyDigest: input.vehicleKeyDigest,
    };
    const tenantId = uuid(captured.tenantId);
    const establishmentId = uuid(captured.establishmentId);
    const correlationId = uuid(captured.correlationId);
    const operatorProfileId = uuid(captured.operatorProfileId);
    const establishmentProfileId = uuid(captured.establishmentProfileId);
    if (
      typeof captured.subject !== "string" ||
      captured.subject.trim() !== captured.subject ||
      captured.subject.length < 1 ||
      captured.subject.length > 255 ||
      !/^[1-9][0-9]*$/u.test(captured.operatorProfileVersion) ||
      !/^[1-9][0-9]*$/u.test(captured.establishmentProfileVersion)
    ) {
      throw new OperationRequestBuilderError();
    }
    actorSubjectHash = digest(captured.actorSubjectHash);
    idempotencyKeyDigest = digest(captured.idempotencyKeyDigest);
    vehicleKeyDigest = digest(captured.vehicleKeyDigest);
    const trustedPrepared = readPreparedRenaveMutation(captured.prepared);
    trustedPrepared.body.fill(0);
    const definition = definitionFor(trustedPrepared.operation);
    if (
      (captured.environment !== "homologation" &&
        captured.environment !== "production") ||
      !SHA256_PATTERN.test(trustedPrepared.requestSha256)
    ) {
      throw new OperationRequestBuilderError();
    }
    const operationId = randomUUID();
    const requestBinding: OperationRequestBinding = {
      actorSubjectHash,
      correlationId,
      environment: captured.environment,
      establishmentId,
      idempotencyKeyDigest,
      kind: definition.kind,
      mutationFamily: definition.mutationFamily,
      requestSchemaVersion: definition.requestSchemaVersion,
      tenantId,
      vehicleKeyDigest,
    };
    encryptedRequest = encryptOperationRequest(
      requestCipher,
      captured.prepared,
      requestBinding,
    );
    assertEncryptedOperation(encryptedRequest, trustedPrepared);

    preparedProjection = prepareOperationReconciliationProjection(
      captured.prepared,
    );
    encryptedProjection = encryptOperationReconciliationProjection(
      projectionCipher,
      preparedProjection,
      {
        environment: captured.environment,
        establishmentId,
        generation: 1,
        kind: definition.kind,
        mutationFamily: definition.mutationFamily,
        operationId,
        requestSchemaVersion: definition.requestSchemaVersion,
        sourceRequestSha256: trustedPrepared.requestSha256,
        tenantId,
      },
    );
    assertEncryptedProjection(encryptedProjection, operationId, definition);

    return {
      actorSubjectHash: Buffer.from(actorSubjectHash),
      correlationId,
      establishmentId,
      establishmentProfileId,
      establishmentProfileVersion: captured.establishmentProfileVersion,
      idempotencyKeyDigest: Buffer.from(idempotencyKeyDigest),
      kind: definition.kind,
      mutationFamily: definition.mutationFamily,
      operationId,
      operatorProfileId,
      operatorProfileVersion: captured.operatorProfileVersion,
      reconciliationProjectionAuthTag: Buffer.from(encryptedProjection.authTag),
      reconciliationProjectionByteLength:
        encryptedProjection.projectionByteLength,
      reconciliationProjectionCiphertext: Buffer.from(
        encryptedProjection.ciphertext,
      ),
      reconciliationProjectionGeneration: encryptedProjection.generation,
      reconciliationProjectionKeyId: encryptedProjection.keyId,
      reconciliationProjectionKind: encryptedProjection.projectionKind,
      reconciliationProjectionNonce: Buffer.from(encryptedProjection.nonce),
      reconciliationProjectionSchemaVersion:
        encryptedProjection.projectionSchemaVersion,
      requestAuthTag: Buffer.from(encryptedRequest.authTag),
      requestCiphertext: Buffer.from(encryptedRequest.ciphertext),
      requestKeyId: encryptedRequest.keyId,
      requestNonce: Buffer.from(encryptedRequest.nonce),
      requestSchemaVersion: definition.requestSchemaVersion,
      requestSha256: Buffer.from(encryptedRequest.requestSha256, "hex"),
      subject: captured.subject,
      vehicleKeyDigest: Buffer.from(vehicleKeyDigest),
    };
  } catch {
    throw new OperationRequestBuilderError();
  } finally {
    actorSubjectHash?.fill(0);
    idempotencyKeyDigest?.fill(0);
    vehicleKeyDigest?.fill(0);
    preparedProjection?.destroy();
    encryptedRequest?.authTag.fill(0);
    encryptedRequest?.ciphertext.fill(0);
    encryptedRequest?.nonce.fill(0);
    encryptedProjection?.authTag.fill(0);
    encryptedProjection?.ciphertext.fill(0);
    encryptedProjection?.nonce.fill(0);
    prepared?.destroy();
  }
}
