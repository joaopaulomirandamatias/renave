import type { OidcConfig } from "./config.js";
import {
  codeChallengeS256,
  createCodeVerifier,
  randomToken,
  safeEqual,
  sha256Base64Url,
} from "./pkce.js";
import type {
  Clock,
  OidcClient,
  SessionRecord,
  SessionStore,
} from "./ports.js";
import { sanitizeReturnTo } from "./return-to.js";

export type LoginFailureReason =
  | "invalid_request"
  | "invalid_state"
  | "binding_mismatch"
  | "provider_error"
  | "exchange_failed"
  | "nonce_mismatch";

export interface StartLoginResult {
  authorizationUrl: string;
  /** Segredo do cookie de vínculo da tentativa ao navegador que a iniciou. */
  bindingSecret: string;
  bindingMaxAgeSeconds: number;
}

export interface CompleteLoginInput {
  state: unknown;
  code: unknown;
  /** Parâmetro `error` devolvido pelo IdP (usuário negou, etc.). */
  providerError?: unknown;
  /** Valor do cookie de vínculo enviado pelo navegador. */
  bindingSecret: string | undefined;
  /** Sessão eventualmente já presente no navegador; é invalidada (rotação). */
  previousSessionId?: string | undefined;
}

export type CompleteLoginResult =
  | {
      ok: true;
      sessionId: string;
      sessionMaxAgeSeconds: number;
      returnTo: string;
    }
  | { ok: false; reason: LoginFailureReason };

export interface AuthenticatedSession {
  /** Identificador estável interno. A rota pública não deve serializá-lo. */
  subject: string;
  name?: string;
  email?: string;
  roles: readonly string[];
  expiresAt: number;
}

export interface IdentityService {
  startLogin(input: { returnTo?: unknown }): Promise<StartLoginResult>;
  completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult>;
  getSession(
    sessionId: string | undefined,
  ): Promise<AuthenticatedSession | undefined>;
  logout(sessionId: string | undefined): Promise<void>;
  buildEndSessionUrl(): Promise<string | undefined>;
  readonly config: Pick<OidcConfig, "publicOrigin">;
}

export interface IdentityServiceOptions {
  oidc: OidcClient;
  store: SessionStore;
  config: OidcConfig;
  clock?: Clock;
}

const TOKEN = /^[A-Za-z0-9._~-]{1,2048}$/u;
const MAX_CODE_LENGTH = 4096;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/u;

function tokenParam(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

export function createIdentityService(
  options: IdentityServiceOptions,
): IdentityService {
  const { oidc, store, config } = options;
  const clock = options.clock ?? { now: () => Date.now() };

  async function startLogin(input: {
    returnTo?: unknown;
  }): Promise<StartLoginResult> {
    const state = randomToken();
    const nonce = randomToken();
    const bindingSecret = randomToken();
    const codeVerifier = createCodeVerifier();
    const now = clock.now();

    // Gera a URL antes de gravar: se o IdP estiver indisponível não sobra
    // tentativa órfã no armazenamento.
    const authorizationUrl = await oidc.buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge: codeChallengeS256(codeVerifier),
      redirectUri: config.redirectUri,
    });

    await store.saveLoginAttempt(sha256Base64Url(state), {
      codeVerifier,
      nonceHash: sha256Base64Url(nonce),
      bindingHash: sha256Base64Url(bindingSecret),
      returnTo: sanitizeReturnTo(input.returnTo),
      createdAt: now,
      expiresAt: now + config.loginAttemptTtlSeconds * 1000,
    });

    return {
      authorizationUrl,
      bindingSecret,
      bindingMaxAgeSeconds: config.loginAttemptTtlSeconds,
    };
  }

  async function completeLogin(
    input: CompleteLoginInput,
  ): Promise<CompleteLoginResult> {
    const state = tokenParam(input.state);
    if (!state) return { ok: false, reason: "invalid_state" };

    // A tentativa é consumida ANTES de qualquer outra checagem: um state só
    // vale uma vez, qualquer que seja o resultado (anti-replay).
    const attempt = await store.consumeLoginAttempt(
      sha256Base64Url(state),
      clock.now(),
    );
    if (!attempt) return { ok: false, reason: "invalid_state" };

    if (
      !input.bindingSecret ||
      !safeEqual(sha256Base64Url(input.bindingSecret), attempt.bindingHash)
    ) {
      return { ok: false, reason: "binding_mismatch" };
    }

    if (input.providerError !== undefined) {
      return { ok: false, reason: "provider_error" };
    }

    const code = input.code;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      code.length > MAX_CODE_LENGTH
    ) {
      return { ok: false, reason: "invalid_request" };
    }

    let identity;
    try {
      identity = await oidc.exchangeCode({
        code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: config.redirectUri,
      });
    } catch {
      // O motivo detalhado é descartado de propósito: mensagens de erro de
      // clientes HTTP podem carregar fragmentos de requisição.
      return { ok: false, reason: "exchange_failed" };
    }

    if (
      !identity.nonce ||
      !safeEqual(sha256Base64Url(identity.nonce), attempt.nonceHash)
    ) {
      return { ok: false, reason: "nonce_mismatch" };
    }

    // Rotação: o identificador é sempre novo e o anterior (se houver) morre.
    if (input.previousSessionId && SESSION_ID.test(input.previousSessionId)) {
      await store.deleteSession(sha256Base64Url(input.previousSessionId));
    }

    const now = clock.now();
    const sessionId = randomToken();
    const record: SessionRecord = {
      subject: identity.subject,
      roles: identity.roles,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + config.sessionIdleTtlSeconds * 1000,
      absoluteExpiresAt: now + config.sessionAbsoluteTtlSeconds * 1000,
      ...(identity.name !== undefined ? { name: identity.name } : {}),
      ...(identity.email !== undefined ? { email: identity.email } : {}),
    };
    await store.saveSession(sha256Base64Url(sessionId), record);

    return {
      ok: true,
      sessionId,
      sessionMaxAgeSeconds: config.sessionAbsoluteTtlSeconds,
      returnTo: sanitizeReturnTo(attempt.returnTo),
    };
  }

  async function getSession(
    sessionId: string | undefined,
  ): Promise<AuthenticatedSession | undefined> {
    if (!sessionId || !SESSION_ID.test(sessionId)) return undefined;
    const key = sha256Base64Url(sessionId);
    const now = clock.now();
    const record = await store.getSession(key, now);
    if (!record) return undefined;

    // Expiração por inatividade deslizante, limitada ao teto absoluto.
    const idleExpiresAt = Math.min(
      now + config.sessionIdleTtlSeconds * 1000,
      record.absoluteExpiresAt,
    );
    await store.touchSession(key, now, idleExpiresAt);

    return {
      subject: record.subject,
      roles: record.roles,
      expiresAt: idleExpiresAt,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.email !== undefined ? { email: record.email } : {}),
    };
  }

  async function logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !SESSION_ID.test(sessionId)) return;
    await store.deleteSession(sha256Base64Url(sessionId));
  }

  async function buildEndSessionUrl(): Promise<string | undefined> {
    try {
      return await oidc.buildEndSessionUrl?.();
    } catch {
      return undefined;
    }
  }

  return {
    startLogin,
    completeLogin,
    getSession,
    logout,
    buildEndSessionUrl,
    config: { publicOrigin: config.publicOrigin },
  };
}
