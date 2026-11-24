import { createHmac } from "node:crypto";

import type { Pool } from "pg";

export type TenantAdminRateLimitScope = "actor" | "global" | "tenant";
export type TenantAdminRateLimitResult =
  | { allowed: true; retryAfterSeconds: 0 }
  | {
      allowed: false;
      retryAfterSeconds: number;
      scope: TenantAdminRateLimitScope;
    };

interface RateLimitRow {
  allowed: boolean;
  limited_scope: TenantAdminRateLimitScope | null;
  retry_after_seconds: number;
}

export class TenantAdminRateLimitInputError extends Error {
  override name = "TenantAdminRateLimitInputError";
}

export function decodeTenantAdminHmacKeyBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new TenantAdminRateLimitInputError(
      "TENANT_ADMIN_HMAC_KEY_BASE64 deve ser base64 canônico.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new TenantAdminRateLimitInputError(
      "TENANT_ADMIN_HMAC_KEY_BASE64 deve conter ao menos 32 bytes.",
    );
  }
  return key;
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255
  ) {
    throw new TenantAdminRateLimitInputError(`${field} inválido.`);
  }
  return value;
}

function hmac(key: Buffer, domain: string, values: readonly string[]): Buffer {
  const result = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) result.update("\0", "utf8").update(value, "utf8");
  return result.digest();
}

export class PostgresTenantAdminRateLimiter {
  private readonly hmacKey: Buffer;

  constructor(
    private readonly pool: Pool,
    hmacKey: Buffer,
  ) {
    if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
      throw new TenantAdminRateLimitInputError(
        "A chave HMAC administrativa deve ter ao menos 32 bytes.",
      );
    }
    this.hmacKey = Buffer.from(hmacKey);
  }

  async consume(input: {
    subject: string;
    tenantId: string;
  }): Promise<TenantAdminRateLimitResult> {
    const subject = requiredText(input?.subject, "subject");
    const tenantId = requiredText(input?.tenantId, "tenantId");
    const tenantKey = hmac(this.hmacKey, "tenant-admin-tenant-v1", [tenantId]);
    const actorKey = hmac(this.hmacKey, "tenant-admin-actor-v1", [
      tenantId,
      subject,
    ]);
    try {
      const { rows } = await this.pool.query<RateLimitRow>(
        `select allowed, limited_scope, retry_after_seconds
           from renave_runtime.consume_tenant_admin_rate_limit($1, $2)`,
        [tenantKey, actorKey],
      );
      const row = rows[0];
      if (!row)
        throw new Error("O limite administrativo não retornou resultado.");
      if (row.allowed) return { allowed: true, retryAfterSeconds: 0 };
      if (
        (row.limited_scope !== "actor" &&
          row.limited_scope !== "global" &&
          row.limited_scope !== "tenant") ||
        !Number.isInteger(row.retry_after_seconds) ||
        row.retry_after_seconds < 1
      ) {
        throw new Error("O limite administrativo retornou decisão inválida.");
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
    this.hmacKey.fill(0);
  }
}
