import { isIP } from "node:net";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RequestAccessGuard } from "../auth/request-access-guard.js";
import { PlatformConsoleInputError, type PlatformConsole } from "./console.js";

const REASON_TICKET = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u;
const LOCAL_GLOBAL_CONCURRENCY = 2;

class PlatformLocalRequestGate {
  #active = 0;
  readonly #actors = new Set<string>();

  tryAcquire(actor: string): (() => void) | null {
    if (this.#active >= LOCAL_GLOBAL_CONCURRENCY || this.#actors.has(actor)) {
      return null;
    }
    this.#active += 1;
    this.#actors.add(actor);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#actors.delete(actor);
    };
  }
}

export interface PlatformRoutesOptions {
  accessGuard: RequestAccessGuard;
  console: PlatformConsole;
  mfaMaxAgeSeconds: number;
}

function singleHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["x-renave-reason-ticket"];
  return typeof value === "string" && REASON_TICKET.test(value)
    ? value
    : undefined;
}

function query(
  request: FastifyRequest,
): { cursor?: string; limit: number } | null {
  if (typeof request.query !== "object" || request.query === null) {
    return { limit: 50 };
  }
  const values = request.query as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "cursor" && key !== "limit")) {
    return null;
  }
  const cursor = values.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length > 512)
  ) {
    return null;
  }
  const rawLimit = values.limit;
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { limit, ...(cursor ? { cursor } : {}) };
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  options: PlatformRoutesOptions,
): void {
  const localGate = new PlatformLocalRequestGate();
  app.get("/api/platform/renave-link-queue", async (request, reply) => {
    const lookup = await options.accessGuard.authenticate(request, reply, {
      mfa: "required",
      mfaMaxAgeSeconds: options.mfaMaxAgeSeconds,
    });
    if (!lookup.ok) return;
    const reasonTicket = singleHeader(request);
    const pagination = query(request);
    if (!reasonTicket || !pagination || isIP(request.ip) === 0) {
      request.log.warn({ event: "platform.queue.input_rejected" });
      return reply.code(400).send({ code: "INVALID_PLATFORM_REQUEST" });
    }
    const session = lookup.session;
    if (!session.issuer) {
      return reply.code(403).send({ code: "ACCESS_DENIED" });
    }
    const release = localGate.tryAcquire(
      `${session.issuer}\0${session.subject}`,
    );
    if (!release) {
      return reply
        .header("retry-after", "1")
        .code(429)
        .send({ code: "PLATFORM_CONSOLE_RATE_LIMITED" });
    }

    try {
      const permit = await options.console.acquire({
        issuer: session.issuer,
        subject: session.subject,
      });
      if (!permit.allowed) {
        return reply
          .header("retry-after", String(permit.retryAfterSeconds))
          .code(429)
          .send({ code: "PLATFORM_CONSOLE_RATE_LIMITED" });
      }
      const result = await options.console.list({
        actorIp: request.ip,
        ...pagination,
        issuer: session.issuer,
        reasonTicket,
        subject: session.subject,
        traceId: request.id,
      });
      if (!result.authorized) {
        return reply.code(403).send({ code: "ACCESS_DENIED" });
      }
      return {
        items: result.entries.map((entry) => ({
          tenant: {
            id: entry.tenantId,
            displayName: entry.tenantDisplayName,
          },
          establishment: {
            id: entry.establishmentId,
            tradeName: entry.tradeName,
          },
          renaveLink: {
            status: entry.linkStatus,
            updatedAt: entry.updatedAt.toISOString(),
          },
        })),
        truncated: result.truncated,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    } catch (error) {
      if (error instanceof PlatformConsoleInputError) {
        return reply.code(400).send({ code: "INVALID_PLATFORM_REQUEST" });
      }
      request.log.error({
        event: "platform.queue.unavailable",
        traceId: request.id,
      });
      return reply
        .code(503)
        .send({ code: "PLATFORM_CONSOLE_UNAVAILABLE", traceId: request.id });
    } finally {
      release();
    }
  });
}
