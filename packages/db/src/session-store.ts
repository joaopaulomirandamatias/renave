import type {
  LoginAttempt,
  SessionRecord,
  SessionStore,
} from "@seu-renave/identity";
import type { Pool } from "pg";

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const MAX_EPOCH_MS = 8_640_000_000_000_000;

interface LoginAttemptRow {
  binding_hash: string;
  code_verifier: string;
  created_at_ms: string;
  expires_at_ms: string;
  nonce_hash: string;
  return_to: string;
}

interface SessionRow {
  absolute_expires_at_ms: string;
  authentication_context: string | null;
  created_at_ms: string;
  display_name: string | null;
  email: string | null;
  idle_expires_at_ms: string;
  last_seen_at_ms: string;
  mfa_verified_at_login: boolean;
  roles: string[];
  subject: string;
}

export class IdentitySessionStoreInputError extends Error {
  override name = "IdentitySessionStoreInputError";
}

export interface IdentityPurgeResult {
  loginAttemptsDeleted: number;
  sessionsDeleted: number;
}

function assertHash(value: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new IdentitySessionStoreInputError(
      "Chave de identidade inválida: esperado SHA-256 em base64url.",
    );
  }
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_EPOCH_MS) {
    throw new IdentitySessionStoreInputError(`${field} inválido.`);
  }
}

function assertLoginAttempt(attempt: LoginAttempt): void {
  if (!VERIFIER_PATTERN.test(attempt.codeVerifier)) {
    throw new IdentitySessionStoreInputError("codeVerifier PKCE inválido.");
  }
  assertHash(attempt.nonceHash);
  assertHash(attempt.bindingHash);
  if (
    attempt.returnTo.length === 0 ||
    attempt.returnTo.length > 512 ||
    !attempt.returnTo.startsWith("/") ||
    attempt.returnTo.startsWith("//") ||
    attempt.returnTo.includes("\\")
  ) {
    throw new IdentitySessionStoreInputError("returnTo inválido.");
  }
  assertEpoch(attempt.createdAt, "createdAt");
  assertEpoch(attempt.expiresAt, "expiresAt");
  if (attempt.expiresAt <= attempt.createdAt) {
    throw new IdentitySessionStoreInputError(
      "expiresAt deve ser posterior a createdAt.",
    );
  }
}

function assertSession(session: SessionRecord): void {
  if (
    session.subject.trim() !== session.subject ||
    session.subject.length === 0 ||
    session.subject.length > 255
  ) {
    throw new IdentitySessionStoreInputError("subject inválido.");
  }
  for (const [field, value] of [
    ["name", session.name],
    ["email", session.email],
  ] as const) {
    if (value !== undefined && (value.length === 0 || value.length > 512)) {
      throw new IdentitySessionStoreInputError(`${field} inválido.`);
    }
  }
  if (
    session.authenticationContext !== undefined &&
    !/^[\u0021-\u007e]{1,512}$/u.test(session.authenticationContext)
  ) {
    throw new IdentitySessionStoreInputError("authenticationContext inválido.");
  }
  if (typeof session.mfaVerifiedAtLogin !== "boolean") {
    throw new IdentitySessionStoreInputError("mfaVerifiedAtLogin inválido.");
  }
  if (
    session.mfaVerifiedAtLogin &&
    session.authenticationContext === undefined
  ) {
    throw new IdentitySessionStoreInputError(
      "mfaVerifiedAtLogin exige authenticationContext.",
    );
  }
  if (
    session.roles.length > 100 ||
    session.roles.some(
      (role) =>
        role.length === 0 ||
        role.length > 128 ||
        role.trim() !== role ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(role),
    )
  ) {
    throw new IdentitySessionStoreInputError("roles inválidos.");
  }
  for (const [field, value] of [
    ["createdAt", session.createdAt],
    ["lastSeenAt", session.lastSeenAt],
    ["idleExpiresAt", session.idleExpiresAt],
    ["absoluteExpiresAt", session.absoluteExpiresAt],
  ] as const) {
    assertEpoch(value, field);
  }
  if (
    session.lastSeenAt < session.createdAt ||
    session.idleExpiresAt <= session.lastSeenAt ||
    session.absoluteExpiresAt <= session.createdAt ||
    session.idleExpiresAt > session.absoluteExpiresAt
  ) {
    throw new IdentitySessionStoreInputError("Janela da sessão inválida.");
  }
}

function toNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Timestamp de identidade fora da faixa segura.");
  }
  return parsed;
}

function toLoginAttempt(row: LoginAttemptRow): LoginAttempt {
  return {
    bindingHash: row.binding_hash,
    codeVerifier: row.code_verifier,
    createdAt: toNumber(row.created_at_ms),
    expiresAt: toNumber(row.expires_at_ms),
    nonceHash: row.nonce_hash,
    returnTo: row.return_to,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    absoluteExpiresAt: toNumber(row.absolute_expires_at_ms),
    createdAt: toNumber(row.created_at_ms),
    idleExpiresAt: toNumber(row.idle_expires_at_ms),
    lastSeenAt: toNumber(row.last_seen_at_ms),
    mfaVerifiedAtLogin: row.mfa_verified_at_login,
    roles: row.roles,
    subject: row.subject,
    ...(row.authentication_context === null
      ? {}
      : { authenticationContext: row.authentication_context }),
    ...(row.display_name === null ? {} : { name: row.display_name }),
    ...(row.email === null ? {} : { email: row.email }),
  };
}

/**
 * SessionStore global e persistente. As chaves são hashes dos segredos do
 * navegador; esta classe nunca recebe nem persiste cookie ou token OIDC bruto.
 */
export class PostgresIdentitySessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async saveLoginAttempt(key: string, attempt: LoginAttempt): Promise<void> {
    assertHash(key);
    assertLoginAttempt(attempt);
    await this.pool.query(
      `select renave_identity.save_login_attempt(
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        key,
        attempt.codeVerifier,
        attempt.nonceHash,
        attempt.bindingHash,
        attempt.returnTo,
        attempt.createdAt,
        attempt.expiresAt,
      ],
    );
  }

  async consumeLoginAttempt(
    key: string,
    now: number,
  ): Promise<LoginAttempt | undefined> {
    assertHash(key);
    assertEpoch(now, "now");
    // A função executa DELETE ... RETURNING como fronteira atômica anti-replay.
    // A linha expirada também é removida, mas nunca devolvida ao serviço.
    const { rows } = await this.pool.query<LoginAttemptRow>(
      `select code_verifier, nonce_hash, binding_hash, return_to,
              created_at_ms::text, expires_at_ms::text
         from renave_identity.consume_login_attempt($1, $2)`,
      [key, now],
    );
    const row = rows[0];
    if (!row) return undefined;
    return toLoginAttempt(row);
  }

  async saveSession(key: string, session: SessionRecord): Promise<void> {
    assertHash(key);
    assertSession(session);
    await this.pool.query(
      `select renave_identity.save_auth_session(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )`,
      [
        key,
        session.subject,
        session.name ?? null,
        session.email ?? null,
        [...session.roles],
        session.authenticationContext ?? null,
        session.mfaVerifiedAtLogin,
        session.createdAt,
        session.lastSeenAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
      ],
    );
  }

  async getSession(
    key: string,
    now: number,
  ): Promise<SessionRecord | undefined> {
    assertHash(key);
    assertEpoch(now, "now");
    const { rows } = await this.pool.query<SessionRow>(
      `select subject, display_name, email, roles, authentication_context,
              mfa_verified_at_login, created_at_ms::text,
              last_seen_at_ms::text, idle_expires_at_ms::text,
              absolute_expires_at_ms::text
         from renave_identity.get_auth_session($1, $2)`,
      [key, now],
    );
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async touchSession(
    key: string,
    lastSeenAt: number,
    idleExpiresAt: number,
  ): Promise<void> {
    assertHash(key);
    assertEpoch(lastSeenAt, "lastSeenAt");
    assertEpoch(idleExpiresAt, "idleExpiresAt");
    if (idleExpiresAt <= lastSeenAt) {
      throw new IdentitySessionStoreInputError(
        "idleExpiresAt deve ser posterior a lastSeenAt.",
      );
    }
    await this.pool.query(
      `select renave_identity.touch_auth_session($1, $2, $3)`,
      [key, lastSeenAt, idleExpiresAt],
    );
  }

  async deleteSession(key: string): Promise<void> {
    assertHash(key);
    await this.pool.query("select renave_identity.delete_auth_session($1)", [
      key,
    ]);
  }

  /**
   * Remove tentativas e sessões expiradas sem formar uma transação longa.
   * O chamador deve repetir periodicamente enquanto os contadores atingirem
   * o tamanho do lote e publicar métricas, sem incluir claims nos logs.
   */
  async purgeExpiredRecords(batchSize = 1_000): Promise<IdentityPurgeResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new IdentitySessionStoreInputError(
        "batchSize deve ser um inteiro entre 1 e 10000.",
      );
    }
    const { rows } = await this.pool.query<{
      login_attempts_deleted: number;
      sessions_deleted: number;
    }>(
      `select login_attempts_deleted, sessions_deleted
         from renave_identity.purge_expired_identity_records($1)`,
      [batchSize],
    );
    const result = rows[0];
    if (!result)
      throw new Error("A limpeza de identidade não retornou resultado.");
    return {
      loginAttemptsDeleted: result.login_attempts_deleted,
      sessionsDeleted: result.sessions_deleted,
    };
  }
}
