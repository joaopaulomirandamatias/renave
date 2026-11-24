import {
  authorize,
  type AuthorizationDecision,
  type DomainAction,
} from "@seu-renave/access-control";
import {
  getAuthorizationContext,
  withTenant,
  type TenantClient,
} from "@seu-renave/db/api-runtime";
import {
  cookieNames,
  readCookie,
  type AuthenticatedSession,
  type IdentityService,
} from "@seu-renave/identity";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export interface SessionLookupGate {
  tryAcquire(): (() => void) | undefined;
}

export interface SessionRequirement {
  mfa?: "required";
  /** Idade máxima da prova MFA; ausente aceita toda a sessão autenticada. */
  mfaMaxAgeSeconds?: number;
  required?: boolean;
  responseBase?: Readonly<Record<string, unknown>>;
}

export type SessionLookupResult =
  { ok: true; session: AuthenticatedSession | undefined } | { ok: false };

type RequiredSessionLookupResult =
  { ok: true; session: AuthenticatedSession } | { ok: false };

export interface RequestAccessGuard {
  authenticate<Required extends boolean = true>(
    request: FastifyRequest,
    reply: FastifyReply,
    requirement?: SessionRequirement & { required?: Required },
  ): Promise<
    Required extends false ? SessionLookupResult : RequiredSessionLookupResult
  >;
}

export function createRequestAccessGuard(options: {
  clock?: Readonly<{ now(): number }>;
  identity: IdentityService;
  secure: boolean;
  sessionLookupGate?: SessionLookupGate;
}): RequestAccessGuard {
  const sessionCookie = cookieNames(options.secure).session;
  const clock = options.clock ?? { now: () => Date.now() };

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: SessionRequirement = {},
  ): Promise<SessionLookupResult> => {
    const required = requirement.required ?? true;
    const sessionId = readCookie(request.headers.cookie, sessionCookie);
    if (!sessionId) {
      if (required) {
        await reply.code(401).send({
          ...requirement.responseBase,
          code: "AUTHENTICATION_REQUIRED",
        });
        return { ok: false };
      }
      return { ok: true, session: undefined };
    }

    let release: (() => void) | undefined;
    try {
      release = options.sessionLookupGate?.tryAcquire();
      if (options.sessionLookupGate && !release) {
        request.log.warn({ event: "identity.session_lookup_saturated" });
        reply.header("retry-after", "1");
        await reply
          .code(429)
          .send({ ...requirement.responseBase, code: "SESSION_LOOKUP_BUSY" });
        return { ok: false };
      }
    } catch {
      request.log.error({ event: "identity.session_lookup_gate_failed" });
      await reply.code(503).send({
        ...requirement.responseBase,
        code: "SESSION_LOOKUP_UNAVAILABLE",
      });
      return { ok: false };
    }

    try {
      const session = await options.identity.getSession(sessionId);
      if (!session) {
        if (required) {
          await reply.code(401).send({
            ...requirement.responseBase,
            code: "AUTHENTICATION_REQUIRED",
          });
          return { ok: false };
        }
        return { ok: true, session: undefined };
      }
      if (requirement.mfa === "required" && session.mfaVerified !== true) {
        await reply.code(403).send({ code: "MFA_REQUIRED" });
        return { ok: false };
      }
      const now = clock.now();
      if (
        requirement.mfa === "required" &&
        requirement.mfaMaxAgeSeconds !== undefined &&
        (typeof session.mfaVerifiedAt !== "number" ||
          !Number.isFinite(session.mfaVerifiedAt) ||
          session.mfaVerifiedAt > now ||
          now - session.mfaVerifiedAt > requirement.mfaMaxAgeSeconds * 1_000)
      ) {
        await reply.code(403).send({ code: "MFA_RECENT_REQUIRED" });
        return { ok: false };
      }
      return { ok: true, session };
    } catch {
      request.log.error({
        event: "identity.session_lookup_failed",
        traceId: request.id,
      });
      await reply.code(503).send({
        ...requirement.responseBase,
        code: "SESSION_STORE_UNAVAILABLE",
      });
      return { ok: false };
    } finally {
      release?.();
    }
  };
  return {
    authenticate: authenticate as RequestAccessGuard["authenticate"],
  };
}

type AllowedDecision = Extract<AuthorizationDecision, { allowed: true }>;

export type TenantActionResult<T> =
  | { allowed: true; value: T }
  | {
      allowed: false;
      reason: "ACCESS_DENIED" | "MFA_REQUIRED";
    };

export interface TenantActionRunner {
  run<T>(
    input: {
      action: DomainAction;
      establishmentId?: string;
      mfa?: "required";
      session: AuthenticatedSession;
      tenantId: string;
    },
    work: (context: {
      authorization: AllowedDecision;
      client: TenantClient;
      session: AuthenticatedSession;
    }) => Promise<T>,
  ): Promise<TenantActionResult<T>>;
}

const MFA_REQUIRED_ACTIONS = new Set<DomainAction>([
  "tenant.establishment.manage",
  "tenant.user.manage",
]);

/** Mantém resolução RBAC e trabalho autorizado dentro da mesma transação RLS. */
export function createTenantActionRunner(pool: Pool): TenantActionRunner {
  return {
    async run(input, work) {
      if (
        (input.mfa === "required" || MFA_REQUIRED_ACTIONS.has(input.action)) &&
        input.session.mfaVerified !== true
      ) {
        return { allowed: false, reason: "MFA_REQUIRED" };
      }
      return withTenant(pool, input.tenantId, async (client) => {
        const context = await getAuthorizationContext(
          client,
          input.session.subject,
        );
        if (!context) return { allowed: false, reason: "ACCESS_DENIED" };
        const decision = authorize(context, {
          action: input.action,
          tenantId: input.tenantId,
          ...(input.establishmentId
            ? { establishmentId: input.establishmentId }
            : {}),
        });
        if (!decision.allowed) {
          return { allowed: false, reason: "ACCESS_DENIED" };
        }
        return {
          allowed: true,
          value: await work({
            authorization: decision,
            client,
            session: input.session,
          }),
        };
      });
    },
  };
}
