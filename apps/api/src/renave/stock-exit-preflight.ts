import type {
  StockExitPreflightConfirmation,
  StockExitPreflightQueryInput,
} from "@seu-renave/renave-application";

import type { StockExitPreflightPort } from "./stock-exit-operations.js";

export interface StockExitPreflightQueryUseCase {
  authorize(
    input: Pick<
      StockExitPreflightQueryInput,
      "establishmentId" | "subject" | "tenantId"
    >,
  ): Promise<void>;
  executeStockExitPreflight(
    input: StockExitPreflightQueryInput,
  ): Promise<StockExitPreflightConfirmation>;
}

export interface StockExitPreflightQueryPermit {
  release(): Promise<void>;
}

export interface StockExitPreflightQueryLimiter {
  acquire(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<
    | { allowed: true; permit: StockExitPreflightQueryPermit }
    | { allowed: false; retryAfterSeconds: number; scope: string }
  >;
}

export class StockExitPreflightLimitedError extends Error {
  readonly code = "STOCK_EXIT_PREFLIGHT_LIMITED";

  constructor(readonly retryAfterSeconds: number) {
    super("A consulta de preflight da saída está temporariamente limitada.");
    this.name = "StockExitPreflightLimitedError";
  }
}

export class StockExitPreflightUnavailableError extends Error {
  readonly code = "STOCK_EXIT_PREFLIGHT_UNAVAILABLE";

  constructor() {
    super("A consulta de preflight da saída está indisponível.");
    this.name = "StockExitPreflightUnavailableError";
  }
}

export interface RateLimitedStockExitPreflightOptions {
  onPermitReleaseFailure: (input: { traceId: string }) => Promise<void> | void;
  queryLimiter: StockExitPreflightQueryLimiter;
  stockQuery: StockExitPreflightQueryUseCase;
}

export class RateLimitedStockExitPreflight implements StockExitPreflightPort {
  private readonly acquirePermit: StockExitPreflightQueryLimiter["acquire"];
  private readonly authorizeQuery: StockExitPreflightQueryUseCase["authorize"];
  private readonly executeQuery: StockExitPreflightQueryUseCase["executeStockExitPreflight"];
  private readonly reportPermitReleaseFailure: RateLimitedStockExitPreflightOptions["onPermitReleaseFailure"];

  constructor(options: RateLimitedStockExitPreflightOptions) {
    if (
      typeof options?.queryLimiter?.acquire !== "function" ||
      typeof options?.stockQuery?.authorize !== "function" ||
      typeof options?.stockQuery?.executeStockExitPreflight !== "function" ||
      typeof options?.onPermitReleaseFailure !== "function"
    ) {
      throw new StockExitPreflightUnavailableError();
    }
    this.acquirePermit = options.queryLimiter.acquire.bind(
      options.queryLimiter,
    );
    this.authorizeQuery = options.stockQuery.authorize.bind(options.stockQuery);
    this.executeQuery = options.stockQuery.executeStockExitPreflight.bind(
      options.stockQuery,
    );
    this.reportPermitReleaseFailure = options.onPermitReleaseFailure;
    Object.freeze(this);
  }

  async verify(
    input: Parameters<StockExitPreflightPort["verify"]>[0],
  ): Promise<StockExitPreflightConfirmation> {
    await this.authorizeQuery({
      establishmentId: input.establishmentId,
      subject: input.subject,
      tenantId: input.tenantId,
    });

    let decision: Awaited<
      ReturnType<StockExitPreflightQueryLimiter["acquire"]>
    >;
    try {
      decision = await this.acquirePermit({
        establishmentId: input.establishmentId,
        subject: input.subject,
        tenantId: input.tenantId,
      });
    } catch {
      throw new StockExitPreflightUnavailableError();
    }
    if (!decision.allowed) {
      if (
        !Number.isSafeInteger(decision.retryAfterSeconds) ||
        decision.retryAfterSeconds < 1
      ) {
        throw new StockExitPreflightUnavailableError();
      }
      throw new StockExitPreflightLimitedError(decision.retryAfterSeconds);
    }

    try {
      return await this.executeQuery({
        actorIp: input.actorIp,
        establishmentId: input.establishmentId,
        stockId: input.stockId,
        subject: input.subject,
        tenantId: input.tenantId,
        traceId: input.traceId,
        vehicle: { ...input.vehicle },
      });
    } finally {
      try {
        await decision.permit.release();
      } catch {
        try {
          await this.reportPermitReleaseFailure({
            traceId: input.traceId,
          });
        } catch {
          // Observabilidade secundária não pode alterar o desfecho do preflight.
        }
      }
    }
  }
}

Object.freeze(RateLimitedStockExitPreflight.prototype);
Object.freeze(RateLimitedStockExitPreflight);
