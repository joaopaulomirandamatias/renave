import { createHmac } from "node:crypto";

import type { Pool } from "pg";

interface RateLimitRow {
  allowed: boolean;
  limited_scope: StockExitRateLimitScope | null;
  retry_after_seconds: number;
}

interface State {
  destroyed: boolean;
  hmacKey: Buffer;
  query: Pool["query"];
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const states = new WeakMap<PostgresStockExitRateLimiter, State>();

export type StockExitRateLimitScope = "global" | "subject" | "tenant";
export type StockExitRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      scope: StockExitRateLimitScope;
    };

export class StockExitRateLimitInputError extends Error {
  override name = "StockExitRateLimitInputError";
}

export function decodeStockExitRateLimitHmacKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new StockExitRateLimitInputError();
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new StockExitRateLimitInputError();
  }
  return key;
}

function normalizeSubject(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StockExitRateLimitInputError();
  }
  return value;
}

function normalizeTenant(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new StockExitRateLimitInputError();
  }
  return value.toLowerCase();
}

function digest(
  key: Buffer,
  domain: string,
  values: readonly string[],
): Buffer {
  const output = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) output.update("\0", "utf8").update(value, "utf8");
  return output.digest();
}

function validScope(value: string | null): value is StockExitRateLimitScope {
  return value === "global" || value === "tenant" || value === "subject";
}

export class PostgresStockExitRateLimiter {
  constructor(pool: Pool, hmacKey: Buffer) {
    let query: Pool["query"] | undefined;
    try {
      query = pool?.query;
    } catch {
      throw new StockExitRateLimitInputError();
    }
    if (
      typeof query !== "function" ||
      !Buffer.isBuffer(hmacKey) ||
      hmacKey.length < 32
    ) {
      throw new StockExitRateLimitInputError();
    }
    states.set(this, {
      destroyed: false,
      hmacKey: Buffer.from(hmacKey),
      query: query.bind(pool),
    });
    Object.freeze(this);
  }

  async acquire(input: {
    subject: string;
    tenantId: string;
  }): Promise<StockExitRateLimitResult> {
    const state = states.get(this);
    if (!state || state.destroyed) throw new StockExitRateLimitInputError();
    let subject: string;
    let tenant: string;
    try {
      subject = normalizeSubject(input?.subject);
      tenant = normalizeTenant(input?.tenantId);
    } catch {
      throw new StockExitRateLimitInputError();
    }
    const tenantKey = digest(state.hmacKey, "stock-exit-limit-tenant-v1", [
      tenant,
    ]);
    const subjectKey = digest(state.hmacKey, "stock-exit-limit-subject-v1", [
      tenant,
      subject,
    ]);
    try {
      const { rows } = await state.query<RateLimitRow>(
        `select allowed, limited_scope, retry_after_seconds
           from renave_stock_exit_barriers.consume_rate_limit($1, $2)`,
        [tenantKey, subjectKey],
      );
      const row = rows[0];
      if (rows.length !== 1 || !row) {
        throw new StockExitRateLimitInputError();
      }
      if (row.allowed) {
        if (row.limited_scope !== null || row.retry_after_seconds !== 0) {
          throw new StockExitRateLimitInputError();
        }
        return { allowed: true };
      }
      if (
        !validScope(row.limited_scope) ||
        !Number.isInteger(row.retry_after_seconds) ||
        row.retry_after_seconds < 1
      ) {
        throw new StockExitRateLimitInputError();
      }
      return {
        allowed: false,
        retryAfterSeconds: row.retry_after_seconds,
        scope: row.limited_scope,
      };
    } catch (error) {
      if (error instanceof StockExitRateLimitInputError) throw error;
      throw new StockExitRateLimitInputError();
    } finally {
      tenantKey.fill(0);
      subjectKey.fill(0);
    }
  }

  destroy(): void {
    const state = states.get(this);
    if (!state || state.destroyed) return;
    state.hmacKey.fill(0);
    state.destroyed = true;
  }
}

Object.freeze(PostgresStockExitRateLimiter.prototype);
Object.freeze(PostgresStockExitRateLimiter);
