import { listCredentialLinkQueue } from "@seu-renave/db/api-runtime";
import type { FastifyInstance } from "fastify";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";
import {
  registerTenantEstablishmentAdminRoutes,
  type TenantEstablishmentAdministration,
  type TenantMutationRateLimiter,
} from "./admin-establishments.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface TenantDirectoryEntry {
  displayName: string;
  tenantId: string;
}

export interface TenantEstablishmentEntry {
  id: string;
  tradeName: string;
}

export type EstablishmentManagementCapability =
  "available" | "mfa_required" | "denied";

export interface TenantEstablishmentCollection {
  canManageEstablishments: boolean;
  establishments: readonly TenantEstablishmentEntry[];
}

export interface TenantEstablishmentDetail {
  establishment: TenantEstablishmentEntry;
  renaveLink: {
    status:
      | "not_started"
      | "pending"
      | "confirmed"
      | "enabled"
      | "deactivated"
      | "rejected";
  };
}

export interface TenantDirectory {
  discover(subject: string): Promise<readonly TenantDirectoryEntry[]>;
  getEstablishment(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<TenantEstablishmentDetail | null>;
  listEstablishments(input: {
    subject: string;
    tenantId: string;
  }): Promise<TenantEstablishmentCollection | null>;
}

export interface TenantRoutesOptions {
  accessGuard: RequestAccessGuard;
  administration?: TenantEstablishmentAdministration;
  directory?: TenantDirectory;
  mutationRateLimiter?: TenantMutationRateLimiter;
  publicOrigin: string;
  tenantActionRunner?: TenantActionRunner;
}

export function registerTenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): void {
  registerTenantEstablishmentAdminRoutes(app, options);

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
    if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
      return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
    }

    try {
      const collection = await options.directory.listEstablishments({
        subject: session.subject,
        tenantId: tenantId.toLowerCase(),
      });
      if (collection === null) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      const establishmentManagement: EstablishmentManagementCapability =
        !collection.canManageEstablishments
          ? "denied"
          : session.mfaVerified === true
            ? "available"
            : "mfa_required";
      return {
        capabilities: { establishmentManagement },
        establishments: collection.establishments.map(({ id, tradeName }) => ({
          id,
          tradeName,
        })),
      };
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

  app.get(
    "/api/tenants/:tenantId/renave-link-queue",
    async (request, reply) => {
      const lookup = await options.accessGuard.authenticate(request, reply, {
        mfa: "required",
      });
      if (!lookup.ok) return;
      const tenantId = (request.params as Record<string, unknown>).tenantId;
      if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      if (!options.tenantActionRunner) {
        return reply
          .code(503)
          .send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
      }

      try {
        const result = await options.tenantActionRunner.run(
          {
            action: "tenant.establishment.manage",
            mfa: "required",
            session: lookup.session,
            tenantId: tenantId.toLowerCase(),
          },
          ({ client }) => listCredentialLinkQueue(client),
        );
        if (!result.allowed) {
          return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
        }
        reply.header("cache-control", "no-store");
        return {
          items: result.value.entries.map((item) => ({
            establishment: {
              id: item.establishmentId,
              tradeName: item.tradeName,
            },
            renaveLink: {
              status: item.status,
              ...(item.updatedAt
                ? { updatedAt: item.updatedAt.toISOString() }
                : {}),
            },
          })),
          truncated: result.value.truncated,
        };
      } catch {
        request.log.error({
          event: "tenant.renave_link_queue.failed",
          traceId: request.id,
        });
        return reply.code(503).send({
          code: "TENANT_DIRECTORY_UNAVAILABLE",
          traceId: request.id,
        });
      }
    },
  );

  app.get(
    "/api/tenants/:tenantId/establishments/:establishmentId",
    async (request, reply) => {
      const lookup = await options.accessGuard.authenticate(request, reply);
      if (!lookup.ok) return;
      const session = lookup.session!;
      if (!options.directory) {
        return reply
          .code(503)
          .send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
      }
      const params = request.params as Record<string, unknown>;
      const tenantId = params.tenantId;
      const establishmentId = params.establishmentId;
      if (
        typeof tenantId !== "string" ||
        !UUID_PATTERN.test(tenantId) ||
        typeof establishmentId !== "string" ||
        !UUID_PATTERN.test(establishmentId)
      ) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }

      try {
        const detail = await options.directory.getEstablishment({
          establishmentId: establishmentId.toLowerCase(),
          subject: session.subject,
          tenantId: tenantId.toLowerCase(),
        });
        if (!detail) {
          return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
        }
        return {
          establishment: {
            id: detail.establishment.id,
            tradeName: detail.establishment.tradeName,
          },
          renaveLink: { status: detail.renaveLink.status },
        };
      } catch {
        request.log.error({
          event: "tenant_directory.establishment_failed",
          traceId: request.id,
        });
        return reply.code(503).send({
          code: "TENANT_DIRECTORY_UNAVAILABLE",
          traceId: request.id,
        });
      }
    },
  );
}
