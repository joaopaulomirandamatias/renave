import {
  AUDIT_OUTCOMES,
  getAuthorizationContext,
  listCredentialLinkQueue,
  listTenantAuditEvents,
  listTenantMembers,
  type AuditOutcome,
} from "@seu-renave/db/api-runtime";
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
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d{0,15}$/u;
const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{2,99}$/u;
const AUDIT_OUTCOME_SET = new Set<string>(AUDIT_OUTCOMES);
const ALLOWED_AUDIT_QUERY_KEYS = new Set([
  "action",
  "beforeSequence",
  "establishmentId",
  "limit",
  "outcome",
]);

interface ParsedAuditQuery {
  action?: string;
  beforeSequence?: number;
  establishmentId?: string;
  limit?: number;
  outcome?: AuditOutcome;
}

function parseAuditQuery(raw: unknown): ParsedAuditQuery | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUDIT_QUERY_KEYS.has(key)) return null;
  }

  const parsed: ParsedAuditQuery = {};
  if (record.limit !== undefined) {
    if (
      typeof record.limit !== "string" ||
      !POSITIVE_INTEGER_PATTERN.test(record.limit)
    ) {
      return null;
    }
    const limit = Number(record.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
    parsed.limit = limit;
  }

  if (record.beforeSequence !== undefined) {
    if (
      typeof record.beforeSequence !== "string" ||
      !POSITIVE_INTEGER_PATTERN.test(record.beforeSequence)
    ) {
      return null;
    }
    const beforeSequence = Number(record.beforeSequence);
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0) {
      return null;
    }
    parsed.beforeSequence = beforeSequence;
  }

  if (record.establishmentId !== undefined) {
    if (
      typeof record.establishmentId !== "string" ||
      !UUID_PATTERN.test(record.establishmentId)
    ) {
      return null;
    }
    parsed.establishmentId = record.establishmentId.toLowerCase();
  }

  if (record.action !== undefined) {
    if (
      typeof record.action !== "string" ||
      !AUDIT_ACTION_PATTERN.test(record.action)
    ) {
      return null;
    }
    parsed.action = record.action;
  }

  if (record.outcome !== undefined) {
    if (
      typeof record.outcome !== "string" ||
      !AUDIT_OUTCOME_SET.has(record.outcome)
    ) {
      return null;
    }
    parsed.outcome = record.outcome as AuditOutcome;
  }

  return parsed;
}

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

  app.get("/api/tenants/:tenantId/audit-events", async (request, reply) => {
    const lookup = await options.accessGuard.authenticate(request, reply);
    if (!lookup.ok) return;
    const tenantId = (request.params as Record<string, unknown>).tenantId;
    if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
      return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
    }
    const query = parseAuditQuery(request.query);
    if (query === null) {
      return reply.code(400).send({ code: "INVALID_AUDIT_QUERY" });
    }
    if (!options.tenantActionRunner) {
      return reply.code(503).send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
    }

    try {
      const result = await options.tenantActionRunner.run(
        {
          action: "audit.read",
          session: lookup.session,
          tenantId: tenantId.toLowerCase(),
        },
        async ({ client, session }) => {
          const context = await getAuthorizationContext(
            client,
            session.subject,
          );
          if (!context) return { allowed: false as const };
          const eligibleGrants = context.grants.filter(
            (grant) =>
              grant.role === "tenant_admin" ||
              grant.role === "compliance_auditor",
          );
          if (eligibleGrants.length === 0) {
            return { allowed: false as const };
          }
          const hasTenantWideScope = eligibleGrants.some(
            (grant) =>
              grant.role === "tenant_admin" || grant.establishmentIds === "*",
          );
          let allowedEstablishmentIds: string[] | undefined;
          if (!hasTenantWideScope) {
            allowedEstablishmentIds = [
              ...new Set(
                eligibleGrants.flatMap((grant) =>
                  grant.establishmentIds === "*" ? [] : grant.establishmentIds,
                ),
              ),
            ];
            if (allowedEstablishmentIds.length === 0) {
              return { allowed: false as const };
            }
            if (
              query.establishmentId !== undefined &&
              !allowedEstablishmentIds.includes(query.establishmentId)
            ) {
              return { allowed: false as const };
            }
          }
          const page = await listTenantAuditEvents(client, {
            ...query,
            ...(allowedEstablishmentIds === undefined
              ? {}
              : { allowedEstablishmentIds }),
          });
          return { allowed: true as const, page };
        },
      );
      if (!result.allowed || !result.value.allowed) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      reply.header("cache-control", "no-store");
      const { page } = result.value;
      return {
        hasMore: page.hasMore,
        items: page.items.map((item) => ({
          action: item.action,
          entityType: item.entityType,
          establishmentId: item.establishmentId,
          eventHashPrefix: item.eventHashPrefix,
          occurredAt: item.occurredAt,
          outcome: item.outcome,
          sequence: item.sequence,
          traceId: item.traceId,
        })),
        ...(page.nextBeforeSequence === undefined
          ? {}
          : { nextBeforeSequence: page.nextBeforeSequence }),
      };
    } catch {
      request.log.error({
        event: "tenant.audit_events.failed",
        traceId: request.id,
      });
      return reply.code(503).send({
        code: "TENANT_AUDIT_UNAVAILABLE",
        traceId: request.id,
      });
    }
  });

  app.get("/api/tenants/:tenantId/users", async (request, reply) => {
    const lookup = await options.accessGuard.authenticate(request, reply, {
      mfa: "required",
    });
    if (!lookup.ok) return;
    const tenantId = (request.params as Record<string, unknown>).tenantId;
    if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
      return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
    }
    if (!options.tenantActionRunner) {
      return reply.code(503).send({ code: "TENANT_DIRECTORY_NOT_CONFIGURED" });
    }

    try {
      const result = await options.tenantActionRunner.run(
        {
          action: "tenant.user.manage",
          mfa: "required",
          session: lookup.session,
          tenantId: tenantId.toLowerCase(),
        },
        ({ client }) => listTenantMembers(client),
      );
      if (!result.allowed) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      reply.header("cache-control", "no-store");
      return {
        items: result.value.map((item) => ({
          active: item.active,
          createdAt: item.createdAt,
          establishmentIds: [...item.establishmentIds],
          memberId: item.memberId,
          role: item.role,
          status: item.status,
        })),
      };
    } catch {
      request.log.error({
        event: "tenant.users.failed",
        traceId: request.id,
      });
      return reply.code(503).send({
        code: "TENANT_DIRECTORY_UNAVAILABLE",
        traceId: request.id,
      });
    }
  });
}
