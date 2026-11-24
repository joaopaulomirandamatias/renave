import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import type { Pool } from "pg";

type Query = Pool["query"];

interface LoginRateLimiterState {
  destroyed: boolean;
  readonly hmacKey: Buffer;
  readonly query: Query;
}

const loginRateLimiterState = new WeakMap<
  PostgresLoginRateLimiter,
  LoginRateLimiterState
>();

export type LoginRateLimitScope = "client" | "global";

export type LoginRateLimitResult =
  | { allowed: true; retryAfterSeconds: 0 }
  | {
      allowed: false;
      retryAfterSeconds: number;
      scope: LoginRateLimitScope;
    };

interface LoginRateLimitRow {
  allowed: boolean;
  limited_scope: LoginRateLimitScope | null;
  retry_after_seconds: number;
}

export class LoginRateLimitInputError extends Error {
  override name = "LoginRateLimitInputError";
}

export function decodeLoginRateHmacKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new LoginRateLimitInputError(
      "LOGIN_RATE_LIMIT_HMAC_KEY_BASE64 deve ser base64 canônico.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new LoginRateLimitInputError(
      "LOGIN_RATE_LIMIT_HMAC_KEY_BASE64 deve conter ao menos 32 bytes.",
    );
  }
  return key;
}

function normalizeClientAddress(value: string): string {
  const address = value.trim();
  const version = isIP(address);
  if (version === 0) {
    throw new LoginRateLimitInputError("Endereço do cliente inválido.");
  }
  if (version === 4) return address;
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

/**
 * Limitador distribuído. O endereço vem de `request.ip` com `trustProxy=false`
 * e é transformado por HMAC antes de sair do processo da API.
 */
export class PostgresLoginRateLimiter {
  constructor(pool: Pool, hmacKey: Buffer) {
    let query: Query | undefined;
    try {
      query = pool?.query;
    } catch {
      throw new LoginRateLimitInputError(
        "Configuração do rate limit inválida.",
      );
    }
    if (typeof query !== "function" || !Buffer.isBuffer(hmacKey)) {
      throw new LoginRateLimitInputError(
        "Configuração do rate limit inválida.",
      );
    }
    if (hmacKey.length < 32) {
      throw new LoginRateLimitInputError(
        "A chave HMAC do rate limit deve ter ao menos 32 bytes.",
      );
    }
    loginRateLimiterState.set(this, {
      destroyed: false,
      hmacKey: Buffer.from(hmacKey),
      query: query.bind(pool),
    });
    Object.freeze(this);
  }

  async consume(clientAddress: string): Promise<LoginRateLimitResult> {
    const state = loginRateLimiterState.get(this);
    if (!state || state.destroyed) {
      throw new LoginRateLimitInputError("Limitador de login indisponível.");
    }
    const normalized = normalizeClientAddress(clientAddress);
    const clientKey = createHmac("sha256", state.hmacKey)
      .update(normalized, "utf8")
      .digest();
    try {
      const { rows } = await state.query<LoginRateLimitRow>(
        `select allowed, limited_scope, retry_after_seconds
           from renave_identity.consume_login_rate_limit($1)`,
        [clientKey],
      );
      const result = rows[0];
      if (!result) throw new Error("O rate limit não retornou resultado.");
      if (result.allowed) return { allowed: true, retryAfterSeconds: 0 };
      if (
        (result.limited_scope !== "client" &&
          result.limited_scope !== "global") ||
        !Number.isInteger(result.retry_after_seconds) ||
        result.retry_after_seconds < 1
      ) {
        throw new Error("O rate limit retornou uma decisão inválida.");
      }
      return {
        allowed: false,
        retryAfterSeconds: result.retry_after_seconds,
        scope: result.limited_scope,
      };
    } finally {
      clientKey.fill(0);
    }
  }

  destroy(): void {
    const state = loginRateLimiterState.get(this);
    if (!state || state.destroyed) return;
    state.destroyed = true;
    state.hmacKey.fill(0);
  }
}

export async function purgeStaleLoginRateBuckets(
  pool: Pool,
  batchSize = 1_000,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new LoginRateLimitInputError(
      "batchSize deve ser um inteiro entre 1 e 10000.",
    );
  }
  const { rows } = await pool.query<{ deleted: number }>(
    `select renave_identity.purge_stale_login_rate_buckets($1) as deleted`,
    [batchSize],
  );
  const deleted = rows[0]?.deleted;
  if (!Number.isInteger(deleted) || deleted! < 0) {
    throw new Error("A limpeza dos buckets não retornou resultado válido.");
  }
  return deleted!;
}
