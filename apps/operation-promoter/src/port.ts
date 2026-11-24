import {
  OPERATION_PROMOTER_ROLE,
  OperationPromotionDeniedError,
  RuntimeDatabaseContractError,
  assertRuntimeDatabase,
  createPool,
  promoteHeldLocalOperation,
  withTenant,
  type PromoteHeldLocalOperationInput,
} from "@seu-renave/db/operation-promoter";
import type { Pool } from "pg";

import { OperationPromoterError } from "./errors.js";
import type { ValidatedDatabaseConfig } from "./target.js";

export interface OperationPromotionReceipt {
  operationId: string;
  promotedAt: Date;
  replayed: boolean;
}

export interface OperationPromotionPort {
  attest(): Promise<void>;
  close(): Promise<void>;
  promote(
    tenantId: string,
    input: PromoteHeldLocalOperationInput,
  ): Promise<OperationPromotionReceipt>;
}

class PostgresOperationPromotionPort implements OperationPromotionPort {
  constructor(private readonly pool: Pool) {}

  async attest(): Promise<void> {
    try {
      await assertRuntimeDatabase(this.pool, {
        expectedRole: OPERATION_PROMOTER_ROLE,
      });
    } catch (error) {
      if (error instanceof RuntimeDatabaseContractError) {
        throw new OperationPromoterError(
          "OPERATION_PROMOTER_DATABASE_REJECTED",
        );
      }
      throw new OperationPromoterError("OPERATION_PROMOTER_DATABASE_REJECTED");
    }
  }

  async promote(
    tenantId: string,
    input: PromoteHeldLocalOperationInput,
  ): Promise<OperationPromotionReceipt> {
    try {
      const receipt = await withTenant(this.pool, tenantId, (client) =>
        promoteHeldLocalOperation(client, input),
      );
      return Object.freeze({
        operationId: receipt.operationId,
        promotedAt: new Date(receipt.promotedAt),
        replayed: receipt.replayed,
      });
    } catch (error) {
      if (error instanceof OperationPromotionDeniedError) {
        throw new OperationPromoterError("OPERATION_PROMOTER_DENIED", 2);
      }
      if (error instanceof OperationPromoterError) throw error;
      throw new OperationPromoterError("OPERATION_PROMOTER_FAILED");
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      throw new OperationPromoterError("OPERATION_PROMOTER_FAILED");
    }
  }
}

export function createPostgresOperationPromotionPort(
  config: ValidatedDatabaseConfig,
): OperationPromotionPort {
  const pool = createPool(config.connectionString, {
    allowExitOnIdle: true,
    application_name: "seu-renave-operation-promoter",
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 60_000,
    lock_timeout: 30_000,
    max: 1,
    query_timeout: 65_000,
    ssl: {
      ca: config.ca,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: config.servername,
    },
    statement_timeout: 60_000,
  });
  return new PostgresOperationPromotionPort(pool);
}
