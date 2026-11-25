import {
  getPendingOperationDetail,
  listPendingOperations,
  type PendingOperationDetail,
  type PendingOperationPage,
  type TenantClient,
} from "@seu-renave/db/api-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_INTEGER = /^[1-9]\d?$/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const PUBLIC_REASON_CODES = new Set<string>([
  "CREATED",
  "HELD_LOCAL_CREATED",
  "REGULATORY_AUTHORIZATION_REVALIDATED",
  "DISPATCH_BEGUN",
  "SEND_LEASE_EXPIRED",
  "RENAVE_CONFIRMED",
  "RENAVE_REJECTED",
  "RENAVE_MUTATION_OUTCOME_UNKNOWN",
  "RENAVE_RECONCILIATION_CONFIRMED",
  "RENAVE_RECONCILIATION_AMBIGUOUS",
  "RENAVE_RECONCILIATION_WINDOW_EXPIRED",
  "RENAVE_RECONCILIATION_UNRECOVERABLE",
]);

export type PendingOperationSummaryProjection =
  PendingOperationPage["items"][number];
export type PendingOperationDetailProjection = PendingOperationDetail;

export interface OperationPendingReader {
  get(
    client: TenantClient,
    input: { establishmentId: string; operationId: string },
  ): Promise<PendingOperationDetailProjection | null>;
  list(
    client: TenantClient,
    input: { establishmentId: string; limit: number },
  ): Promise<PendingOperationPage>;
}

export const databaseOperationPendingReader: OperationPendingReader = {
  get: getPendingOperationDetail,
  list: listPendingOperations,
};

interface RouteParams {
  establishmentId: string;
  tenantId: string;
}

interface DetailRouteParams extends RouteParams {
  operationId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function routeParams(request: FastifyRequest): RouteParams | undefined {
  const params = record(request.params);
  if (
    typeof params?.tenantId !== "string" ||
    !UUID.test(params.tenantId) ||
    typeof params.establishmentId !== "string" ||
    !UUID.test(params.establishmentId)
  ) {
    return undefined;
  }
  return {
    establishmentId: params.establishmentId.toLowerCase(),
    tenantId: params.tenantId.toLowerCase(),
  };
}

function detailRouteParams(
  request: FastifyRequest,
): DetailRouteParams | undefined {
  const common = routeParams(request);
  const params = record(request.params);
  if (
    !common ||
    typeof params?.operationId !== "string" ||
    !UUID.test(params.operationId)
  ) {
    return undefined;
  }
  return { ...common, operationId: params.operationId.toLowerCase() };
}

function listLimit(request: FastifyRequest): number | undefined {
  const query = record(request.query);
  if (!query || Object.keys(query).some((key) => key !== "limit")) {
    return undefined;
  }
  if (query.limit === undefined) return DEFAULT_LIMIT;
  if (typeof query.limit !== "string" || !POSITIVE_INTEGER.test(query.limit)) {
    return undefined;
  }
  const limit = Number(query.limit);
  return limit <= MAX_LIMIT ? limit : undefined;
}

function emptyQuery(request: FastifyRequest): boolean {
  const query = record(request.query);
  return query !== undefined && Object.keys(query).length === 0;
}

function iso(value: Date): string {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("invalid operation date");
  return value.toISOString();
}

function publicReasonCode(value: string | null): string | null {
  return value !== null && PUBLIC_REASON_CODES.has(value) ? value : null;
}

type SummaryPresentationInput = Pick<
  PendingOperationDetail["operation"],
  | "operationId"
  | "kind"
  | "status"
  | "reasonCode"
  | "correlationId"
  | "sentAt"
  | "createdAt"
  | "updatedAt"
>;

function presentSummary(value: SummaryPresentationInput) {
  return {
    operationId: value.operationId,
    kind: value.kind,
    status: value.status,
    reasonCode: publicReasonCode(value.reasonCode),
    correlationId: value.correlationId,
    sentAt: value.sentAt ? iso(value.sentAt) : null,
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function presentDetail(value: PendingOperationDetailProjection) {
  return {
    operation: {
      ...presentSummary(value.operation),
      version: value.operation.version,
      remoteRecordId: value.operation.remoteRecordId,
      remoteState: value.operation.remoteState,
      finalizedAt: value.operation.finalizedAt
        ? iso(value.operation.finalizedAt)
        : null,
    },
    timeline: value.timeline.map((item) => ({
      version: item.version,
      previousStatus: item.previousStatus,
      status: item.status,
      reasonCode: publicReasonCode(item.reasonCode),
      changedAt: iso(item.changedAt),
    })),
  };
}

export interface OperationPendingRoutesOptions {
  accessGuard: RequestAccessGuard;
  reader?: OperationPendingReader;
  tenantActionRunner?: TenantActionRunner;
}

export function registerOperationPendingRoutes(
  app: FastifyInstance,
  options: OperationPendingRoutesOptions,
): void {
  const reader = options.reader ?? databaseOperationPendingReader;

  app.get(
    "/api/tenants/:tenantId/establishments/:establishmentId/pending-operations",
    async (request, reply) => {
      const lookup = await options.accessGuard.authenticate(request, reply);
      if (!lookup.ok) return;
      const params = routeParams(request);
      if (!params) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      const limit = listLimit(request);
      if (limit === undefined) {
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      }
      if (!options.tenantActionRunner) {
        return reply.code(503).send({ code: "OPERATION_READER_UNAVAILABLE" });
      }

      try {
        const result = await options.tenantActionRunner.run(
          {
            action: "renave.operation.read",
            establishmentId: params.establishmentId,
            session: lookup.session,
            tenantId: params.tenantId,
          },
          ({ client }) =>
            reader.list(client, {
              establishmentId: params.establishmentId,
              limit,
            }),
        );
        if (!result.allowed) {
          return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
        }
        return {
          items: result.value.items.map(presentSummary),
          truncated: result.value.truncated,
        };
      } catch {
        request.log.error({
          event: "tenant.pending_operations.failed",
          traceId: request.id,
        });
        return reply.code(503).send({
          code: "OPERATION_READER_UNAVAILABLE",
          traceId: request.id,
        });
      }
    },
  );

  app.get(
    "/api/tenants/:tenantId/establishments/:establishmentId/operations/:operationId",
    async (request, reply) => {
      const lookup = await options.accessGuard.authenticate(request, reply);
      if (!lookup.ok) return;
      const params = detailRouteParams(request);
      if (!params) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      if (!emptyQuery(request)) {
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      }
      if (!options.tenantActionRunner) {
        return reply.code(503).send({ code: "OPERATION_READER_UNAVAILABLE" });
      }

      try {
        const result = await options.tenantActionRunner.run(
          {
            action: "renave.operation.read",
            establishmentId: params.establishmentId,
            session: lookup.session,
            tenantId: params.tenantId,
          },
          ({ client }) =>
            reader.get(client, {
              establishmentId: params.establishmentId,
              operationId: params.operationId,
            }),
        );
        if (!result.allowed || result.value === null) {
          return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
        }
        return presentDetail(result.value);
      } catch {
        request.log.error({
          event: "tenant.operation_detail.failed",
          traceId: request.id,
        });
        return reply.code(503).send({
          code: "OPERATION_READER_UNAVAILABLE",
          traceId: request.id,
        });
      }
    },
  );
}
