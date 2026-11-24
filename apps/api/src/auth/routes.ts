import {
  cookieNames,
  clearCookie,
  readCookie,
  serializeCookie,
  type IdentityService,
} from "@seu-renave/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";

export interface AuthRoutesOptions {
  config: AppConfig;
  identity: IdentityService | undefined;
  loginRateLimiter?: LoginRateLimiter;
  sessionLookupGate?: SessionLookupGate;
}

export interface LoginRateLimiter {
  consume(clientAddress: string): Promise<
    | { allowed: true; retryAfterSeconds: 0 }
    | {
        allowed: false;
        retryAfterSeconds: number;
        scope: "client" | "global";
      }
  >;
}

export interface SessionLookupGate {
  tryAcquire(): (() => void) | undefined;
}

function queryValue(request: FastifyRequest, name: string): unknown {
  const query = request.query;
  if (typeof query !== "object" || query === null) return undefined;
  return (query as Record<string, unknown>)[name];
}

/** Rotas de autenticação do BFF. Nunca registra segredos; só eventos e motivos. */
export function registerAuthRoutes(
  app: FastifyInstance,
  { config, identity, loginRateLimiter, sessionLookupGate }: AuthRoutesOptions,
): void {
  const secure = config.appEnvironment !== "development";
  const names = cookieNames(secure);

  function notConfigured(reply: FastifyReply) {
    return reply.code(503).send({
      code: "AUTH_NOT_CONFIGURED",
      message:
        "O provedor corporativo de identidade ainda não foi configurado.",
    });
  }

  async function publicAuthAllowed(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    if (!loginRateLimiter) return true;
    try {
      const decision = await loginRateLimiter.consume(request.ip);
      if (decision.allowed) return true;
      request.log.warn({
        event: "auth.public.rate_limited",
        scope: decision.scope,
      });
      reply.header("retry-after", String(decision.retryAfterSeconds));
      await reply.code(429).send({ code: "AUTH_RATE_LIMITED" });
      return false;
    } catch {
      request.log.error({ event: "auth.public.rate_limit_unavailable" });
      await reply.code(503).send({ code: "AUTH_RATE_LIMIT_UNAVAILABLE" });
      return false;
    }
  }

  app.get("/api/session", async (request, reply) => {
    const base = {
      authenticated: false,
      authMode: config.authMode,
      environment: config.appEnvironment,
    };
    if (!identity) return base;
    const sessionId = readCookie(request.headers.cookie, names.session);
    if (!sessionId) return base;

    let release: (() => void) | undefined;
    try {
      release = sessionLookupGate?.tryAcquire();
      if (sessionLookupGate && !release) {
        request.log.warn({ event: "identity.session_lookup_saturated" });
        reply.header("retry-after", "1");
        return reply.code(429).send({ ...base, code: "SESSION_LOOKUP_BUSY" });
      }
    } catch {
      request.log.error({ event: "identity.session_lookup_gate_failed" });
      return reply
        .code(503)
        .send({ ...base, code: "SESSION_LOOKUP_UNAVAILABLE" });
    }

    let session;
    try {
      session = await identity.getSession(sessionId);
    } catch {
      request.log.error({ event: "identity.session_lookup_failed" });
      return reply
        .code(503)
        .send({ ...base, code: "SESSION_STORE_UNAVAILABLE" });
    } finally {
      release?.();
    }
    if (!session) return base;
    return {
      ...base,
      authenticated: true,
      user: {
        ...(session.name !== undefined ? { name: session.name } : {}),
        ...(session.email !== undefined ? { email: session.email } : {}),
      },
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  });

  app.get("/api/auth/login", async (request, reply) => {
    if (config.authMode === "disabled" || !identity)
      return notConfigured(reply);

    if (!(await publicAuthAllowed(request, reply))) return;

    let started;
    try {
      started = await identity.startLogin({
        returnTo: queryValue(request, "returnTo"),
      });
    } catch {
      request.log.error({ event: "auth.login.start_failed" });
      return reply.code(502).send({
        code: "IDP_UNAVAILABLE",
        message: "Não foi possível contatar o provedor de identidade.",
      });
    }

    request.log.info({ event: "auth.login.started" });
    reply.header(
      "set-cookie",
      serializeCookie(names.login, started.bindingSecret, {
        maxAgeSeconds: started.bindingMaxAgeSeconds,
        secure,
      }),
    );
    return reply.redirect(started.authorizationUrl, 302);
  });

  app.get("/api/auth/callback", async (request, reply) => {
    if (config.authMode === "disabled" || !identity)
      return notConfigured(reply);

    if (!(await publicAuthAllowed(request, reply))) return;
    const cookieHeader = request.headers.cookie;
    let result;
    try {
      result = await identity.completeLogin({
        state: queryValue(request, "state"),
        code: queryValue(request, "code"),
        providerError: queryValue(request, "error"),
        bindingSecret: readCookie(cookieHeader, names.login),
        previousSessionId: readCookie(cookieHeader, names.session),
      });
    } catch {
      request.log.error({ event: "auth.callback.unavailable" });
      return reply.code(503).send({ code: "AUTH_CALLBACK_UNAVAILABLE" });
    }

    const cookies = [clearCookie(names.login, secure)];

    if (!result.ok) {
      request.log.warn({
        event: "auth.callback.rejected",
        reason: result.reason,
      });
      // O cookie de sessão antigo, se houver, é preservado: um callback
      // inválido não deve deslogar o usuário legítimo.
      reply.header("set-cookie", cookies);
      return reply.redirect(`/?auth_error=${result.reason}`, 302);
    }

    request.log.info({ event: "auth.login.succeeded" });
    cookies.push(
      serializeCookie(names.session, result.sessionId, {
        maxAgeSeconds: result.sessionMaxAgeSeconds,
        secure,
      }),
    );
    reply.header("set-cookie", cookies);
    return reply.redirect(result.returnTo, 302);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (config.authMode === "disabled" || !identity)
      return notConfigured(reply);

    // Defesa CSRF além do SameSite=Lax: exige Origin da própria aplicação.
    if (request.headers.origin !== identity.config.publicOrigin) {
      request.log.warn({ event: "auth.logout.rejected", reason: "origin" });
      return reply.code(403).send({
        code: "CSRF_ORIGIN_MISMATCH",
        message: "Origem da requisição não permitida.",
      });
    }

    try {
      await identity.logout(readCookie(request.headers.cookie, names.session));
    } catch {
      request.log.error({ event: "auth.logout.unavailable" });
      return reply.code(503).send({ code: "SESSION_STORE_UNAVAILABLE" });
    }
    request.log.info({ event: "auth.logout" });
    reply.header("set-cookie", [
      clearCookie(names.session, secure),
      clearCookie(names.login, secure),
    ]);
    const endSessionUrl = await identity.buildEndSessionUrl();
    return reply.send({
      loggedOut: true,
      ...(endSessionUrl ? { endSessionUrl } : {}),
    });
  });
}
