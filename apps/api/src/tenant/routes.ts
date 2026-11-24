import {
  cookieNames,
  readCookie,
  type IdentityService,
} from "@seu-renave/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionLookupGate } from "../auth/routes.js";
import type { AppConfig } from "../config.js";

export interface TenantDirectoryEntry {
  displayName: string;
  tenantId: string;
}

export interface TenantEstablishmentEntry {
  id: string;
  tradeName: string;
}

export interface TenantDirectory {
  discover(subject: string): Promise<readonly TenantDirectoryEntry[]>;
  listEstablishments(input: {
    subject: string;
    tenantId: string;
  }): Promise<readonly TenantEstablishmentEntry[] | null>;
}

export interface TenantRoutesOptions {
  config: AppConfig;
  directory?: TenantDirectory;
  identity: IdentityService;
  sessionLookupGate?: SessionLookupGate;
}

export function registerTenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): void {
  const secure = options.config.appEnvironment !== "development";
  const sessionCookie = cookieNames(secure).session;

  async function sessionSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ ok: true; subject: string | undefined } | { ok: false }> {
    const sessionId = readCookie(request.headers.cookie, sessionCookie);
    if (!sessionId) return { ok: true, subject: undefined };
    let release: (() => void) | undefined;
    try {
      release = options.sessionLookupGate?.tryAcquire();
      if (options.sessionLookupGate && !release) {
        reply.header("retry-after", "1");
        await reply.code(429).send({ code: "SESSION_LOOKUP_BUSY" });
        return { ok: false };
      }
    } catch {
      await reply.code(503).send({ code: "SESSION_LOOKUP_UNAVAILABLE" });
      return { ok: false };
    }
    try {
      const session = await options.identity.getSession(sessionId);
      return { ok: true, subject: session?.subject };
    } catch {
      request.log.error({
        event: "identity.session_lookup_failed",
        traceId: request.id,
      });
      await reply.code(503).send({ code: "SESSION_STORE_UNAVAILABLE" });
      return { ok: false };
    } finally {
      release?.();
    }
  }

  app.get("/api/tenants", async (request, reply) => {
    const lookup = await sessionSubject(request, reply);
    if (!lookup.ok) return;
    if (!lookup.subject) {
      return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    }
    if (!options.directory) {
      return reply.code(503).send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
    }

    try {
      const tenants = await options.directory.discover(lookup.subject);
      return { tenants };
    } catch {
      request.log.error({
        event: "tenant_directory.discovery_failed",
        traceId: request.id,
      });
      return reply.code(503).send({
        code: "TENANT_DIRECTORY_UNAVAILABLE",
        traceId: request.id,
      });
    }
  });

  app.get("/api/tenants/:tenantId/establishments", async (request, reply) => {
    const lookup = await sessionSubject(request, reply);
    if (!lookup.ok) return;
    if (!lookup.subject) {
      return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    }
    if (!options.directory) {
      return reply.code(503).send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
    }
    const params = request.params as Record<string, unknown>;
    const tenantId = params.tenantId;
    if (
      typeof tenantId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        tenantId,
      )
    ) {
      return reply.code(403).send({ code: "TENANT_ACCESS_DENIED" });
    }

    try {
      const establishments = await options.directory.listEstablishments({
        subject: lookup.subject,
        tenantId: tenantId.toLowerCase(),
      });
      if (establishments === null) {
        return reply.code(403).send({ code: "TENANT_ACCESS_DENIED" });
      }
      return { establishments };
    } catch {
      request.log.error({
        event: "tenant_directory.establishments_failed",
        traceId: request.id,
      });
      return reply.code(503).send({
        code: "TENANT_DIRECTORY_UNAVAILABLE",
        traceId: request.id,
      });
    }
  });
}
