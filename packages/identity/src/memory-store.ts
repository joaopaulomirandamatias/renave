import type { LoginAttempt, SessionRecord, SessionStore } from "./ports.js";

export interface InMemorySessionStoreOptions {
  /** Ambiente da aplicação; `production` é recusado. */
  environment: string;
  maxLoginAttempts?: number;
  maxSessions?: number;
}

/**
 * Armazenamento em memória: SOMENTE desenvolvimento e testes. Não sobrevive a
 * reinício, não é compartilhado entre instâncias e por isso é recusado em
 * produção. Produção deve injetar uma implementação de `SessionStore` em Redis
 * ou Postgres.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #attempts = new Map<string, LoginAttempt>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #maxAttempts: number;
  readonly #maxSessions: number;

  constructor(options: InMemorySessionStoreOptions) {
    if (options.environment.trim().toLowerCase() === "production") {
      throw new Error(
        "InMemorySessionStore é proibido em produção; injete um SessionStore persistente (Redis/Postgres).",
      );
    }
    this.#maxAttempts = options.maxLoginAttempts ?? 5_000;
    this.#maxSessions = options.maxSessions ?? 10_000;
  }

  async saveLoginAttempt(key: string, attempt: LoginAttempt): Promise<void> {
    this.#attempts.delete(key);
    this.#attempts.set(key, attempt);
    this.#evict(this.#attempts, this.#maxAttempts, attempt.createdAt);
  }

  async consumeLoginAttempt(
    key: string,
    now: number,
  ): Promise<LoginAttempt | undefined> {
    // Leitura e remoção no mesmo tick: atômico em um único processo.
    const attempt = this.#attempts.get(key);
    this.#attempts.delete(key);
    if (!attempt || attempt.expiresAt <= now) return undefined;
    return attempt;
  }

  async saveSession(key: string, session: SessionRecord): Promise<void> {
    const isNew = !this.#sessions.has(key);
    this.#sessions.set(key, session);
    if (isNew)
      this.#evict(this.#sessions, this.#maxSessions, session.lastSeenAt);
  }

  async getSession(
    key: string,
    now: number,
  ): Promise<SessionRecord | undefined> {
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      this.#sessions.delete(key);
      return undefined;
    }
    return session;
  }

  async touchSession(
    key: string,
    lastSeenAt: number,
    idleExpiresAt: number,
  ): Promise<void> {
    const session = this.#sessions.get(key);
    if (session)
      this.#sessions.set(key, { ...session, lastSeenAt, idleExpiresAt });
  }

  async deleteSession(key: string): Promise<void> {
    this.#sessions.delete(key);
  }

  /** Limita memória: descarta expirados e, se preciso, os mais antigos. */
  #evict<T extends { expiresAt: number } | { idleExpiresAt: number }>(
    map: Map<string, T>,
    max: number,
    now: number,
  ): void {
    if (map.size <= max) return;
    for (const [key, value] of map) {
      const expiresAt =
        "expiresAt" in value ? value.expiresAt : value.idleExpiresAt;
      if (expiresAt <= now) map.delete(key);
    }
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
}
