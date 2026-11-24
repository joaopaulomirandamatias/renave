import { createHmac } from "node:crypto";

import type { Pool } from "pg";

type Query = Pool["query"];

interface LimiterState {
  destroyed: boolean;
  readonly hmacKey: Buffer;
  readonly query: Query;
}

interface RateLimitRow {
  allowed: boolean;
  limited_scope: StockEntryRateLimitScope | null;
  retry_after_seconds: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const limiterStates = new WeakMap<
  PostgresStockEntryRateLimiter,
  LimiterState
>();

export type StockEntryRateLimitScope = "actor" | "global" | "tenant";
export type StockEntryRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      scope: StockEntryRateLimitScope;
    };

export class StockEntryRateLimitInputError extends Error {
  override name = "StockEntryRateLimitInputError";
}

export class StockEntryRuntimeKeyGenerationError extends Error {
  override name = "StockEntryRuntimeKeyGenerationError";

  constructor() {
    super("A geração dos digests de entrada de estoque não está provisionada.");
  }
}

/**
 * Confirma que esta réplica usa a geração provisionada dos peppers e da chave
 * do limitador. O runtime não recebe privilégios para criar ou trocar o pin.
 */
export async function assertStockEntryRuntimeKeyGeneration(
  pool: Pick<Pool, "query">,
  input: { fingerprint: Uint8Array; generationId: string },
): Promise<void> {
  if (
    !pool ||
    typeof pool.query !== "function" ||
    typeof input?.generationId !== "string" ||
    !GENERATION_ID.test(input.generationId) ||
    !(input.fingerprint instanceof Uint8Array) ||
    input.fingerprint.byteLength !== 32
  ) {
    throw new StockEntryRuntimeKeyGenerationError();
  }
  const fingerprint = Buffer.from(input.fingerprint);
  try {
    const { rows } = await pool.query<{ matches: boolean }>(
      `select renave_runtime.matches_stock_entry_runtime_key_generation($1, $2)
         as matches`,
      [input.generationId, fingerprint],
    );
    if (rows.length !== 1 || rows[0]?.matches !== true) {
      throw new StockEntryRuntimeKeyGenerationError();
    }
  } catch (error) {
    if (error instanceof StockEntryRuntimeKeyGenerationError) throw error;
    throw new StockEntryRuntimeKeyGenerationError();
  } finally {
    fingerprint.fill(0);
  }
}

export function decodeStockEntryRateLimitHmacKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new StockEntryRateLimitInputError(
      "STOCK_ENTRY_RATE_LIMIT_HMAC_KEY_BASE64 deve ser base64 canônico.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new StockEntryRateLimitInputError(
      "STOCK_ENTRY_RATE_LIMIT_HMAC_KEY_BASE64 deve conter ao menos 32 bytes.",
    );
  }
  return key;
}

function subject(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StockEntryRateLimitInputError("subject inválido.");
  }
  return value;
}

function tenantId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new StockEntryRateLimitInputError("tenantId inválido.");
  }
  return value.toLowerCase();
}

function digest(
  key: Buffer,
  domain: string,
  values: readonly string[],
): Buffer {
  const result = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) result.update("\0", "utf8").update(value, "utf8");
  return result.digest();
}

function validScope(value: string | null): value is StockEntryRateLimitScope {
  return value === "actor" || value === "global" || value === "tenant";
}

export class PostgresStockEntryRateLimiter {
  constructor(pool: Pool, hmacKey: Buffer) {
    let query: Pool["query"] | undefined;
    try {
      query = pool?.query;
    } catch {
      throw new StockEntryRateLimitInputError(
        "Configuração do limite de entrada de estoque inválida.",
      );
    }
    if (
      typeof query !== "function" ||
      !Buffer.isBuffer(hmacKey) ||
      hmacKey.length < 32
    ) {
      throw new StockEntryRateLimitInputError(
        "Configuração do limite de entrada de estoque inválida.",
      );
    }
    limiterStates.set(this, {
      destroyed: false,
      hmacKey: Buffer.from(hmacKey),
      query: query.bind(pool),
    });
    Object.freeze(this);
  }

  async acquire(input: {
    subject: string;
    tenantId: string;
  }): Promise<StockEntryRateLimitResult> {
    const state = limiterStates.get(this);
    if (!state || state.destroyed) {
      throw new StockEntryRateLimitInputError(
        "Limitador de entrada de estoque indisponível.",
      );
    }
    let subjectValue: unknown;
    let tenantIdValue: unknown;
    try {
      subjectValue = input?.subject;
      tenantIdValue = input?.tenantId;
    } catch {
      throw new StockEntryRateLimitInputError(
        "Entrada do limite de entrada de estoque inválida.",
      );
    }
    const normalizedSubject = subject(subjectValue);
    const normalizedTenantId = tenantId(tenantIdValue);
    const tenantKey = digest(state.hmacKey, "stock-entry-limit-tenant-v1", [
      normalizedTenantId,
    ]);
    const actorKey = digest(state.hmacKey, "stock-entry-limit-actor-v1", [
      normalizedTenantId,
      normalizedSubject,
    ]);
    try {
      const { rows } = await state.query<RateLimitRow>(
        `select allowed, limited_scope, retry_after_seconds
           from renave_runtime.consume_stock_entry_rate_limit($1, $2)`,
        [tenantKey, actorKey],
      );
      const row = rows[0];
      if (!row) {
        throw new Error(
          "O limite de entrada de estoque não retornou resultado.",
        );
      }
      if (row.allowed) {
        if (row.limited_scope !== null || row.retry_after_seconds !== 0) {
          throw new Error(
            "O limite de entrada de estoque retornou decisão inválida.",
          );
        }
        return { allowed: true };
      }
      if (
        !validScope(row.limited_scope) ||
        !Number.isInteger(row.retry_after_seconds) ||
        row.retry_after_seconds < 1
      ) {
        throw new Error(
          "O limite de entrada de estoque retornou decisão inválida.",
        );
      }
      return {
        allowed: false,
        retryAfterSeconds: row.retry_after_seconds,
        scope: row.limited_scope,
      };
    } finally {
      tenantKey.fill(0);
      actorKey.fill(0);
    }
  }

  destroy(): void {
    const state = limiterStates.get(this);
    if (!state || state.destroyed) return;
    state.hmacKey.fill(0);
    state.destroyed = true;
  }
}

Object.freeze(PostgresStockEntryRateLimiter.prototype);
Object.freeze(PostgresStockEntryRateLimiter);
