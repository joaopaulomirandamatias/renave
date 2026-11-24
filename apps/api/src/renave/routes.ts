import type { IdentityService } from "@seu-renave/identity";
import type { CrvType, StockSummary } from "@seu-renave/renave-connector";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RequestAccessGuard } from "../auth/request-access-guard.js";
import type { AppConfig } from "../config.js";
import type { RenaveLinkStatusUseCase } from "./link-status-use-case.js";
import type { EligibilityUseCase } from "./use-case.js";
import type { RenaveLinkPreflightUseCase } from "./preflight-use-case.js";
import type { RenaveReadinessUseCase } from "./readiness-use-case.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PLATE = /^[A-Z0-9]{7}$/u;
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);

interface RouteParams {
  establishmentId: string;
  tenantId: string;
}

interface RouteBody {
  crvType: CrvType;
  plate: string;
}

interface StockQueryBody {
  plate: string;
}

export interface StockQueryUseCase {
  authorize(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<void>;
  execute(input: {
    actorIp: string;
    establishmentId: string;
    plate: string;
    subject: string;
    tenantId: string;
    traceId?: string;
  }): Promise<readonly StockSummary[]>;
}

export interface RenaveRoutesOptions {
  accessGuard: RequestAccessGuard;
  config: AppConfig;
  eligibility?: EligibilityUseCase;
  identity: IdentityService;
  linkStatus?: RenaveLinkStatusUseCase;
  preflight?: RenaveLinkPreflightUseCase;
  queryLimiter?: SerproQueryLimiter;
  readiness?: RenaveReadinessUseCase;
  stockQuery?: StockQueryUseCase;
}

export interface SerproQueryPermit {
  release(): Promise<void>;
}

export interface SerproQueryLimiter {
  acquire(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<
    | { allowed: true; permit: SerproQueryPermit }
    | { allowed: false; retryAfterSeconds: number; scope: string }
  >;
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
  ) {
    return error.code;
  }
  return undefined;
}

function safeInput(
  request: FastifyRequest,
): { body: RouteBody; params: RouteParams } | undefined {
  if (
    typeof request.params !== "object" ||
    request.params === null ||
    typeof request.body !== "object" ||
    request.body === null ||
    Array.isArray(request.body)
  ) {
    return undefined;
  }
  const params = request.params as Record<string, unknown>;
  const body = request.body as Record<string, unknown>;
  if (
    typeof params.tenantId !== "string" ||
    typeof params.establishmentId !== "string" ||
    !UUID.test(params.tenantId) ||
    !UUID.test(params.establishmentId) ||
    typeof body.plate !== "string" ||
    typeof body.crvType !== "string" ||
    Object.keys(body).some((key) => key !== "plate" && key !== "crvType")
  ) {
    return undefined;
  }
  const plate = body.plate.trim().toUpperCase();
  if (!PLATE.test(plate) || !CRV_TYPES.has(body.crvType as CrvType)) {
    return undefined;
  }
  return {
    body: { crvType: body.crvType as CrvType, plate },
    params: {
      establishmentId: params.establishmentId.toLowerCase(),
      tenantId: params.tenantId.toLowerCase(),
    },
  };
}

function safeParams(request: FastifyRequest): RouteParams | undefined {
  if (typeof request.params !== "object" || request.params === null) {
    return undefined;
  }
  const params = request.params as Record<string, unknown>;
  if (
    typeof params.tenantId !== "string" ||
    typeof params.establishmentId !== "string" ||
    !UUID.test(params.tenantId) ||
    !UUID.test(params.establishmentId)
  ) {
    return undefined;
  }
  return {
    establishmentId: params.establishmentId.toLowerCase(),
    tenantId: params.tenantId.toLowerCase(),
  };
}

function safeStockQueryInput(
  request: FastifyRequest,
): { body: StockQueryBody; params: RouteParams } | undefined {
  const params = safeParams(request);
  if (
    !params ||
    typeof request.body !== "object" ||
    request.body === null ||
    Array.isArray(request.body)
  ) {
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  if (
    typeof body.plate !== "string" ||
    Object.keys(body).some((key) => key !== "plate")
  ) {
    return undefined;
  }
  const plate = body.plate.trim().toUpperCase();
  if (!PLATE.test(plate)) return undefined;
  return { body: { plate }, params };
}

function mappedStatus(code: string | undefined): number {
  if (
    code === "INVALID_ELIGIBILITY_APPLICATION_INPUT" ||
    code === "INVALID_STOCK_PLATE_QUERY" ||
    code === "INVALID_STOCK_QUERY_APPLICATION_INPUT" ||
    code === "INVALID_VEHICLE_ELIGIBILITY_QUERY"
  )
    return 400;
  if (code === "AUTHORIZATION_DENIED") return 403;
  if (
    code === "ESTABLISHMENT_UNAVAILABLE" ||
    code === "RENAVE_LINK_NOT_READY" ||
    code === "RENAVE_IDENTITY_MISMATCH" ||
    code === "ELIGIBILITY_VERIFIED_IDENTITY_MISMATCH" ||
    code === "STOCK_QUERY_VERIFIED_IDENTITY_MISMATCH"
  )
    return 409;
  if (
    code === "RENAVE_HTTP_ERROR" ||
    code === "RENAVE_PROTOCOL_ERROR" ||
    code === "RENAVE_STOCK_QUERY_RESULT_INVALID" ||
    code === "RENAVE_MTLS_RESPONSE_TOO_LARGE"
  )
    return 502;
  if (
    code === "ELIGIBILITY_EVIDENCE_ERROR" ||
    code === "PROTECTED_EVIDENCE_TRANSITION_REJECTED" ||
    code === "STOCK_QUERY_EVIDENCE_ERROR"
  )
    return 503;
  return 500;
}

export function registerRenaveRoutes(
  app: FastifyInstance,
  options: RenaveRoutesOptions,
): void {
  app.get(
    "/api/tenants/:tenantId/establishments/:establishmentId/renave-readiness",
    async (request, reply) => {
      const sessionResult = await options.accessGuard.authenticate(
        request,
        reply,
      );
      if (!sessionResult.ok) return;
      if (!options.readiness) {
        return reply.code(503).send({ code: "RENAVE_STATUS_NOT_CONFIGURED" });
      }
      const params = safeParams(request);
      if (!params) return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return await options.readiness.execute({
          establishmentId: params.establishmentId,
          subject: sessionResult.session.subject,
          tenantId: params.tenantId,
        });
      } catch (error) {
        const code = errorCode(error);
        const status = mappedStatus(code);
        return reply.code(status).send({
          code: status === 500 ? "INTERNAL_ERROR" : (code ?? "INTERNAL_ERROR"),
        });
      }
    },
  );

  app.get(
    "/api/tenants/:tenantId/establishments/:establishmentId/renave-link",
    async (request, reply) => {
      const sessionResult = await options.accessGuard.authenticate(
        request,
        reply,
      );
      if (!sessionResult.ok) return;
      const { session } = sessionResult;
      if (!options.linkStatus) {
        return reply.code(503).send({ code: "RENAVE_LINK_NOT_CONFIGURED" });
      }
      const params = safeParams(request);
      if (!params) return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await options.linkStatus.execute({
          establishmentId: params.establishmentId,
          subject: session.subject,
          tenantId: params.tenantId,
        });
        return { ...result, preflightAvailable: Boolean(options.preflight) };
      } catch (error) {
        const code = errorCode(error);
        const status = mappedStatus(code);
        return reply.code(status).send({
          code: status === 500 ? "INTERNAL_ERROR" : (code ?? "INTERNAL_ERROR"),
        });
      }
    },
  );

  app.post(
    "/api/tenants/:tenantId/establishments/:establishmentId/renave-link-preflight",
    async (request, reply) => {
      if (request.headers.origin !== options.identity.config.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const sessionResult = await options.accessGuard.authenticate(
        request,
        reply,
      );
      if (!sessionResult.ok) return;
      const { session } = sessionResult;
      if (!options.preflight) {
        return reply.code(503).send({ code: "RENAVE_NOT_CONFIGURED" });
      }
      const params = safeParams(request);
      if (!params) return reply.code(400).send({ code: "INVALID_REQUEST" });
      if (!options.queryLimiter) {
        return reply
          .code(503)
          .send({ code: "RENAVE_QUERY_LIMIT_NOT_CONFIGURED" });
      }
      try {
        await options.preflight.authorize({
          establishmentId: params.establishmentId,
          subject: session.subject,
          tenantId: params.tenantId,
        });
      } catch (error) {
        const code = errorCode(error);
        const status = mappedStatus(code);
        return reply.code(status).send({
          code: status === 500 ? "INTERNAL_ERROR" : (code ?? "INTERNAL_ERROR"),
        });
      }
      let permitDecision;
      try {
        permitDecision = await options.queryLimiter.acquire({
          establishmentId: params.establishmentId,
          subject: session.subject,
          tenantId: params.tenantId,
        });
      } catch {
        return reply.code(503).send({ code: "RENAVE_QUERY_LIMIT_UNAVAILABLE" });
      }
      if (!permitDecision.allowed) {
        reply.header("retry-after", String(permitDecision.retryAfterSeconds));
        return reply.code(429).send({ code: "RENAVE_QUERY_LIMITED" });
      }
      try {
        try {
          return await options.preflight.execute({
            actorIp: request.ip,
            establishmentId: params.establishmentId,
            subject: session.subject,
            tenantId: params.tenantId,
            traceId: request.id,
          });
        } catch (error) {
          const code = errorCode(error);
          const status = mappedStatus(code);
          request.log.error({
            event: "renave.link_preflight.failed",
            errorCode: code ?? "UNEXPECTED_ERROR",
            traceId: request.id,
          });
          return reply.code(status).send({
            code:
              status === 500 ? "INTERNAL_ERROR" : (code ?? "UPSTREAM_ERROR"),
            traceId: request.id,
          });
        }
      } finally {
        try {
          await permitDecision.permit.release();
        } catch {
          request.log.error({
            event: "renave.query_permit_release_failed",
            traceId: request.id,
          });
        }
      }
    },
  );

  app.post(
    "/api/tenants/:tenantId/establishments/:establishmentId/vehicle-eligibility",
    async (request, reply) => {
      if (request.headers.origin !== options.identity.config.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const sessionResult = await options.accessGuard.authenticate(
        request,
        reply,
      );
      if (!sessionResult.ok) return;
      const { session } = sessionResult;
      if (!options.eligibility) {
        return reply.code(503).send({ code: "RENAVE_NOT_CONFIGURED" });
      }
      const input = safeInput(request);
      if (!input) {
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      }

      if (!options.queryLimiter) {
        return reply
          .code(503)
          .send({ code: "RENAVE_QUERY_LIMIT_NOT_CONFIGURED" });
      }
      const executionInput = {
        actorIp: request.ip,
        crvType: input.body.crvType,
        establishmentId: input.params.establishmentId,
        plate: input.body.plate,
        subject: session.subject,
        tenantId: input.params.tenantId,
        traceId: request.id,
      };
      try {
        await options.eligibility.authorize(executionInput);
      } catch (error) {
        const code = errorCode(error);
        const status = mappedStatus(code);
        return reply.code(status).send({
          code: status === 500 ? "INTERNAL_ERROR" : (code ?? "INTERNAL_ERROR"),
        });
      }
      let permitDecision;
      try {
        permitDecision = await options.queryLimiter.acquire({
          establishmentId: input.params.establishmentId,
          subject: session.subject,
          tenantId: input.params.tenantId,
        });
      } catch {
        request.log.error({
          event: "renave.query_limit_unavailable",
          traceId: request.id,
        });
        return reply.code(503).send({ code: "RENAVE_QUERY_LIMIT_UNAVAILABLE" });
      }
      if (!permitDecision.allowed) {
        request.log.warn({
          event: "renave.query_limited",
          scope: permitDecision.scope,
          traceId: request.id,
        });
        reply.header("retry-after", String(permitDecision.retryAfterSeconds));
        return reply.code(429).send({ code: "RENAVE_QUERY_LIMITED" });
      }

      try {
        try {
          return await options.eligibility.execute(executionInput);
        } catch (error) {
          const code = errorCode(error);
          const status = mappedStatus(code);
          request.log.error({
            event: "renave.vehicle_eligibility.failed",
            errorCode: code ?? "UNEXPECTED_ERROR",
            traceId: request.id,
          });
          return reply.code(status).send({
            code:
              status === 500 ? "INTERNAL_ERROR" : (code ?? "UPSTREAM_ERROR"),
            traceId: request.id,
          });
        }
      } finally {
        try {
          await permitDecision.permit.release();
        } catch {
          request.log.error({
            event: "renave.query_permit_release_failed",
            traceId: request.id,
          });
        }
      }
    },
  );

  app.post(
    "/api/tenants/:tenantId/establishments/:establishmentId/stocks/search",
    async (request, reply) => {
      if (request.headers.origin !== options.identity.config.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const sessionResult = await options.accessGuard.authenticate(
        request,
        reply,
      );
      if (!sessionResult.ok) return;
      if (!options.stockQuery) {
        return reply.code(503).send({ code: "RENAVE_NOT_CONFIGURED" });
      }
      const input = safeStockQueryInput(request);
      if (!input) return reply.code(400).send({ code: "INVALID_REQUEST" });
      if (!options.queryLimiter) {
        return reply
          .code(503)
          .send({ code: "RENAVE_QUERY_LIMIT_NOT_CONFIGURED" });
      }
      const executionInput = {
        actorIp: request.ip,
        establishmentId: input.params.establishmentId,
        plate: input.body.plate,
        subject: sessionResult.session.subject,
        tenantId: input.params.tenantId,
        traceId: request.id,
      };
      try {
        await options.stockQuery.authorize(executionInput);
      } catch (error) {
        const code = errorCode(error);
        const status = mappedStatus(code);
        return reply.code(status).send({
          code: status === 500 ? "INTERNAL_ERROR" : (code ?? "INTERNAL_ERROR"),
        });
      }

      let permitDecision;
      try {
        permitDecision = await options.queryLimiter.acquire({
          establishmentId: input.params.establishmentId,
          subject: sessionResult.session.subject,
          tenantId: input.params.tenantId,
        });
      } catch {
        request.log.error({
          event: "renave.query_limit_unavailable",
          traceId: request.id,
        });
        return reply.code(503).send({ code: "RENAVE_QUERY_LIMIT_UNAVAILABLE" });
      }
      if (!permitDecision.allowed) {
        request.log.warn({
          event: "renave.query_limited",
          scope: permitDecision.scope,
          traceId: request.id,
        });
        reply.header("retry-after", String(permitDecision.retryAfterSeconds));
        return reply.code(429).send({ code: "RENAVE_QUERY_LIMITED" });
      }

      try {
        try {
          return await options.stockQuery.execute(executionInput);
        } catch (error) {
          const code = errorCode(error);
          const status = mappedStatus(code);
          request.log.error({
            event: "renave.stock_query.failed",
            errorCode: code ?? "UNEXPECTED_ERROR",
            traceId: request.id,
          });
          return reply.code(status).send({
            code:
              status === 500 ? "INTERNAL_ERROR" : (code ?? "UPSTREAM_ERROR"),
            traceId: request.id,
          });
        }
      } finally {
        try {
          await permitDecision.permit.release();
        } catch {
          request.log.error({
            event: "renave.query_permit_release_failed",
            traceId: request.id,
          });
        }
      }
    },
  );
}
