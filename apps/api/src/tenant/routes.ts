import type { FastifyInstance } from "fastify";

import type { RequestAccessGuard } from "../auth/request-access-guard.js";

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
  accessGuard: RequestAccessGuard;
  directory?: TenantDirectory;
}

export function registerTenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): void {
  app.get("/api/tenants", async (request, reply) => {
    const lookup = await options.accessGuard.authenticate(request, reply);
    if (!lookup.ok) return;
    const session = lookup.session!;
    if (!options.directory) {
      return reply.code(503).send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
    }

    try {
      const tenants = await options.directory.discover(session.subject);
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
    const lookup = await options.accessGuard.authenticate(request, reply);
    if (!lookup.ok) return;
    const session = lookup.session!;
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
        subject: session.subject,
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
