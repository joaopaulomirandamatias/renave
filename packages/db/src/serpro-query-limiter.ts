import { createHmac, randomUUID } from "node:crypto";

import type { Pool } from "pg";

type Query = Pool["query"];

interface LimiterState {
  destroyed: boolean;
  readonly hmacKey: Buffer;
  readonly query: Query;
}

const limiterState = new WeakMap<PostgresSerproQueryLimiter, LimiterState>();

export type SerproQueryLimitScope =
  | "global_rate"
  | "tenant_rate"
  | "actor_rate"
  | "global_concurrency"
  | "tenant_concurrency"
  | "actor_concurrency";

export type SerproQueryPermitResult =
  | { allowed: true; permit: SerproQueryPermit }
  | {
      allowed: false;
      retryAfterSeconds: number;
      scope: SerproQueryLimitScope;
    };

export interface SerproQueryPermit {
  release(): Promise<void>;
}

export interface SerproQueryPermitInput {
  establishmentId: string;
  subject: string;
  tenantId: string;
}

interface PermitRow {
  allowed: boolean;
  limited_scope: SerproQueryLimitScope | null;
  retry_after_seconds: number;
}

export class SerproQueryLimitInputError extends Error {
  override name = "SerproQueryLimitInputError";
}

export function decodeSerproQueryHmacKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new SerproQueryLimitInputError(
      "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64 deve ser base64 canônico.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new SerproQueryLimitInputError(
      "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64 deve conter ao menos 32 bytes.",
    );
  }
  return key;
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 255
  ) {
    throw new SerproQueryLimitInputError(`${field} inválido.`);
  }
  return value;
}

function digest(
  key: Buffer,
  domain: string,
  values: readonly string[],
): Buffer {
  const hmac = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) hmac.update("\0", "utf8").update(value, "utf8");
  return hmac.digest();
}

function validScope(value: string | null): value is SerproQueryLimitScope {
  return (
    value === "global_rate" ||
    value === "tenant_rate" ||
    value === "actor_rate" ||
    value === "global_concurrency" ||
    value === "tenant_concurrency" ||
    value === "actor_concurrency"
  );
}

/**
 * Adquire um lease em transação curta. O lease é liberado por outra transação;
 * nenhuma conexão permanece ocupada enquanto o SERPRO é chamado.
 */
export class PostgresSerproQueryLimiter {
  constructor(pool: Pool, hmacKey: Buffer) {
    if (new.target !== PostgresSerproQueryLimiter) {
      throw new SerproQueryLimitInputError("Limitador SERPRO inválido.");
    }
    let query: Pool["query"] | undefined;
    try {
      query = pool?.query;
    } catch {
      throw new SerproQueryLimitInputError(
        "Configuração do limite SERPRO inválida.",
      );
    }
    if (typeof query !== "function" || !Buffer.isBuffer(hmacKey)) {
      throw new SerproQueryLimitInputError(
        "Configuração do limite SERPRO inválida.",
      );
    }
    if (hmacKey.length < 32) {
      throw new SerproQueryLimitInputError(
        "A chave HMAC do limite SERPRO deve ter ao menos 32 bytes.",
      );
    }
    limiterState.set(this, {
      destroyed: false,
      hmacKey: Buffer.from(hmacKey),
      query: query.bind(pool),
    });
    Object.freeze(this);
  }

  async acquire(
    input: SerproQueryPermitInput,
  ): Promise<SerproQueryPermitResult> {
    const state = limiterState.get(this);
    if (!state || state.destroyed) {
      throw new SerproQueryLimitInputError("Limitador SERPRO indisponível.");
    }
    let subjectValue: unknown;
    let tenantIdValue: unknown;
    let establishmentIdValue: unknown;
    try {
      subjectValue = input?.subject;
      tenantIdValue = input?.tenantId;
      establishmentIdValue = input?.establishmentId;
    } catch {
      throw new SerproQueryLimitInputError(
        "Entrada do limite SERPRO inválida.",
      );
    }
    const subject = requiredText(subjectValue, "subject");
    const tenantId = requiredText(tenantIdValue, "tenantId");
    const establishmentId = requiredText(
      establishmentIdValue,
      "establishmentId",
    );
    const tenantKey = digest(state.hmacKey, "serpro-query-tenant-v1", [
      tenantId,
    ]);
    const actorKey = digest(state.hmacKey, "serpro-query-actor-v1", [
      subject,
      tenantId,
      establishmentId,
    ]);
    const leaseId = randomUUID();
    let rows: PermitRow[];
    try {
      ({ rows } = await state.query<PermitRow>(
        `select allowed, limited_scope, retry_after_seconds
           from renave_runtime.acquire_serpro_query_permit($1, $2, $3)`,
        [leaseId, tenantKey, actorKey],
      ));
    } catch (error) {
      actorKey.fill(0);
      throw error;
    } finally {
      tenantKey.fill(0);
    }
    const result = rows[0];
    if (!result) {
      actorKey.fill(0);
      throw new Error("O limite SERPRO não retornou resultado.");
    }
    if (!result.allowed) {
      actorKey.fill(0);
      if (
        !validScope(result.limited_scope) ||
        !Number.isInteger(result.retry_after_seconds) ||
        result.retry_after_seconds < 1
      ) {
        throw new Error("O limite SERPRO retornou decisão inválida.");
      }
      return {
        allowed: false,
        retryAfterSeconds: result.retry_after_seconds,
        scope: result.limited_scope,
      };
    }

    let released = false;
    const queryPermit = state.query;
    return {
      allowed: true,
      permit: {
        release: async () => {
          if (released) return;
          const releasedResult = await queryPermit<{ released: boolean }>(
            `select renave_runtime.release_serpro_query_permit($1, $2) as released`,
            [leaseId, actorKey],
          );
          if (releasedResult.rows[0]?.released !== true) {
            throw new Error("O lease SERPRO não pôde ser liberado.");
          }
          released = true;
          actorKey.fill(0);
        },
      },
    };
  }

  destroy(): void {
    const state = limiterState.get(this);
    if (!state || state.destroyed) return;
    state.hmacKey.fill(0);
    state.destroyed = true;
  }
}

Object.freeze(PostgresSerproQueryLimiter.prototype);
Object.freeze(PostgresSerproQueryLimiter);
