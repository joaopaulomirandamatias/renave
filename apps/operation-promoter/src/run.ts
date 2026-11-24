import { createHash, timingSafeEqual } from "node:crypto";

import {
  OperationPromotionDecisionConfigurationError,
  OperationPromotionDecisionInvalidError,
  OperationPromotionDecisionVerifier,
  parseOperationPromotionKeyring,
} from "@seu-renave/operation-promotion-decision";

import { OperationPromoterError } from "./errors.js";
import {
  createPostgresOperationPromotionPort,
  type OperationPromotionPort,
} from "./port.js";
import {
  readOperationPromoterFiles,
  type OperationPromoterFiles,
} from "./secret-files.js";
import {
  parseOperationPromoterTarget,
  validateDatabaseConfig,
  type ValidatedDatabaseConfig,
} from "./target.js";

const MAX_DECISION_TTL_MS = 10 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30_000;

export interface OperationPromoterResult {
  outcome: "promoted" | "replayed";
  promotedAt: string;
}

export interface OperationPromoterDependencies {
  clock?: () => Date;
  createPort?: (config: ValidatedDatabaseConfig) => OperationPromotionPort;
  readFiles?: () => Promise<OperationPromoterFiles>;
}

function zeroPromotionInput(input: {
  artifactDigest: Buffer;
  authorizationBindingDigest: Buffer;
  changedByDigest: Buffer;
  evidenceManifestDigest: Buffer;
  executorWorkloadDigest: Buffer;
}): void {
  input.artifactDigest.fill(0);
  input.authorizationBindingDigest.fill(0);
  input.changedByDigest.fill(0);
  input.evidenceManifestDigest.fill(0);
  input.executorWorkloadDigest.fill(0);
}

export async function runOperationPromoter(
  dependencies: OperationPromoterDependencies = {},
): Promise<OperationPromoterResult> {
  const readFiles = dependencies.readFiles ?? readOperationPromoterFiles;
  const createPort =
    dependencies.createPort ?? createPostgresOperationPromotionPort;
  let files: OperationPromoterFiles | undefined;
  let port: OperationPromotionPort | undefined;
  let verifier: OperationPromotionDecisionVerifier | undefined;
  let decision:
    ReturnType<OperationPromotionDecisionVerifier["verify"]> | undefined;
  let promotionInput:
    | ReturnType<
        ReturnType<
          OperationPromotionDecisionVerifier["verify"]
        >["promotionInput"]
      >
    | undefined;
  try {
    files = await readFiles();
    const target = parseOperationPromoterTarget(files.target);
    try {
      const database = validateDatabaseConfig({
        caBytes: files.ca,
        databaseUrlBytes: files.databaseUrl,
        target,
      });
      port = createPort(database);
      await port.attest();
      const keyringDigest = createHash("sha256").update(files.keyring).digest();
      try {
        if (
          keyringDigest.byteLength !==
            target.decisionKeyringDigest.byteLength ||
          !timingSafeEqual(keyringDigest, target.decisionKeyringDigest)
        ) {
          throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
        }
      } finally {
        keyringDigest.fill(0);
      }
      const keyring = parseOperationPromotionKeyring(files.keyring);
      verifier = new OperationPromotionDecisionVerifier({
        ...(dependencies.clock === undefined
          ? {}
          : { clock: dependencies.clock }),
        environment: target.environment,
        keyring,
        logicalDatabaseId: target.logicalDatabaseId,
        maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
        maxTtlMs: MAX_DECISION_TTL_MS,
      });
      decision = verifier.verify(files.decision);
      promotionInput = decision.promotionInput();
      if (
        promotionInput.executorWorkloadDigest.byteLength !==
          target.executorWorkloadDigest.byteLength ||
        !timingSafeEqual(
          promotionInput.executorWorkloadDigest,
          target.executorWorkloadDigest,
        )
      ) {
        throw new OperationPromoterError("OPERATION_PROMOTER_DECISION_INVALID");
      }
      const receipt = await port.promote(decision.tenantId, promotionInput);
      if (
        receipt.operationId !== decision.operationId ||
        !(receipt.promotedAt instanceof Date) ||
        !Number.isFinite(receipt.promotedAt.getTime()) ||
        typeof receipt.replayed !== "boolean"
      ) {
        throw new OperationPromoterError("OPERATION_PROMOTER_FAILED");
      }
      return Object.freeze({
        outcome: receipt.replayed ? "replayed" : "promoted",
        promotedAt: receipt.promotedAt.toISOString(),
      });
    } finally {
      target.decisionKeyringDigest.fill(0);
      target.executorWorkloadDigest.fill(0);
    }
  } catch (error) {
    if (error instanceof OperationPromoterError) throw error;
    if (error instanceof OperationPromotionDecisionInvalidError) {
      throw new OperationPromoterError("OPERATION_PROMOTER_DECISION_INVALID");
    }
    if (error instanceof OperationPromotionDecisionConfigurationError) {
      throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
    }
    throw new OperationPromoterError("OPERATION_PROMOTER_FAILED");
  } finally {
    if (promotionInput) zeroPromotionInput(promotionInput);
    decision?.destroy();
    verifier?.destroy();
    let closeError: unknown;
    try {
      await port?.close();
    } catch (error) {
      closeError = error;
    }
    files?.destroy();
    if (closeError) throw closeError;
  }
}
