import { parseCnpj, type TenantClient } from "@seu-renave/db";
import type { FastifyInstance } from "fastify";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;

export interface TenantEstablishmentAdministration {
  create(
    client: TenantClient,
    input: {
      actorIp: string;
      actorSubject: string;
      cnpj: string;
      idempotencyKey: string;
      traceId: string;
      tradeName: string;
    },
  ): Promise<{
    establishment: { id: string; tradeName: string };
    replayed: boolean;
  }>;
}

export type TenantMutationRateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface TenantMutationRateLimiter {
  acquire(input: {
    subject: string;
    tenantId: string;
  }): Promise<TenantMutationRateLimitResult>;
}

export interface TenantEstablishmentAdminRoutesOptions {
  accessGuard: RequestAccessGuard;
  administration?: TenantEstablishmentAdministration;
  mutationRateLimiter?: TenantMutationRateLimiter;
  publicOrigin: string;
  tenantActionRunner?: TenantActionRunner;
}

function validateInput(
  value: unknown,
): { cnpj: string; tradeName: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "cnpj" || keys[1] !== "tradeName") {
    return undefined;
  }
  const { cnpj, tradeName } = record;
  if (
    typeof cnpj !== "string" ||
    cnpj.length > 32 ||
    typeof tradeName !== "string"
  ) {
    return undefined;
  }
  const normalizedTradeName = tradeName.trim();
  if (
    normalizedTradeName.length === 0 ||
    normalizedTradeName.length > 160 ||
    CONTROL_CHARACTER_PATTERN.test(normalizedTradeName)
  ) {
    return undefined;
  }
  try {
    return { cnpj: parseCnpj(cnpj), tradeName: normalizedTradeName };
  } catch {
    return undefined;
  }
}

function safeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return undefined;
}

function mapAdministrationError(code: string | undefined): {
  responseCode: string;
  status: 400 | 404 | 409 | 500 | 503;
} {
  switch (code) {
    case "TenantAdminInputError":
    case "INVALID_ESTABLISHMENT_INPUT":
      return { responseCode: "INVALID_ESTABLISHMENT_INPUT", status: 400 };
    case "TenantAdminCnpjConflictError":
    case "ESTABLISHMENT_CNPJ_CONFLICT":
      return { responseCode: "ESTABLISHMENT_CNPJ_CONFLICT", status: 409 };
    case "TenantAdminIdempotencyConflictError":
    case "IDEMPOTENCY_KEY_REUSED":
      return { responseCode: "IDEMPOTENCY_KEY_REUSED", status: 409 };
    case "TenantAdminAccessDeniedError":
    case "TENANT_ADMIN_ACCESS_DENIED":
      return { responseCode: "TENANT_RESOURCE_NOT_FOUND", status: 404 };
    case "TenantAdminStorageError":
    case "TENANT_ADMINISTRATION_UNAVAILABLE":
      return { responseCode: "TENANT_ADMINISTRATION_UNAVAILABLE", status: 503 };
    default:
      return { responseCode: "INTERNAL_ERROR", status: 500 };
  }
}

export function registerTenantEstablishmentAdminRoutes(
  app: FastifyInstance,
  options: TenantEstablishmentAdminRoutesOptions,
): void {
  app.post(
    "/api/tenants/:tenantId/establishments",
    {
      bodyLimit: 8 * 1024,
      errorHandler(error, request, reply) {
        const code = safeErrorCode(error);
        if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({ code: "REQUEST_BODY_TOO_LARGE" });
        }
        if (error.statusCode === 400) {
          return reply.code(400).send({ code: "INVALID_ESTABLISHMENT_INPUT" });
        }
        request.log.error({
          errorCode: "INTERNAL_ERROR",
          event: "tenant.establishment_create.unhandled",
          traceId: request.id,
        });
        return reply
          .code(500)
          .send({ code: "INTERNAL_ERROR", traceId: request.id });
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== options.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const lookup = await options.accessGuard.authenticate(request, reply, {
        mfa: "required",
      });
      if (!lookup.ok) return;
      const { session } = lookup;

      const tenantId = (request.params as Record<string, unknown>).tenantId;
      if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
        return reply.code(404).send({ code: "TENANT_RESOURCE_NOT_FOUND" });
      }
      const normalizedTenantId = tenantId.toLowerCase();
      const idempotencyKey = request.headers["idempotency-key"];
      if (
        typeof idempotencyKey !== "string" ||
        !UUID_PATTERN.test(idempotencyKey)
      ) {
        return reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY" });
      }
      const input = validateInput(request.body);
      if (!input) {
        return reply.code(400).send({ code: "INVALID_ESTABLISHMENT_INPUT" });
      }
      if (
        !options.administration ||
        !options.mutationRateLimiter ||
        !options.tenantActionRunner
      ) {
        return reply
          .code(503)
          .send({ code: "TENANT_ADMINISTRATION_NOT_CONFIGURED" });
      }

      // O limitador compartilhado só pode ser consumido por quem já possui o
      // papel administrativo. A escrita repete a autorização em outra
      // transação, mantendo a decisão e o trabalho atômicos mesmo após esta
      // pré-autorização.
      try {
        const preauthorization = await options.tenantActionRunner.run(
          {
            action: "tenant.establishment.manage",
            session,
            tenantId: normalizedTenantId,
          },
          async () => undefined,
        );
        if (!preauthorization.allowed) {
          const mfaRequired = preauthorization.reason === "MFA_REQUIRED";
          return reply.code(mfaRequired ? 403 : 404).send({
            code: mfaRequired ? "MFA_REQUIRED" : "TENANT_RESOURCE_NOT_FOUND",
          });
        }
      } catch {
        request.log.error({
          event: "tenant.establishment_create.authorization_failed",
          traceId: request.id,
        });
        return reply
          .code(503)
          .send({ code: "TENANT_ADMINISTRATION_UNAVAILABLE" });
      }

      let rateLimit: TenantMutationRateLimitResult;
      try {
        rateLimit = await options.mutationRateLimiter.acquire({
          subject: session.subject,
          tenantId: normalizedTenantId,
        });
      } catch {
        return reply
          .code(503)
          .send({ code: "TENANT_MUTATION_LIMIT_UNAVAILABLE" });
      }
      if (!rateLimit.allowed) {
        if (
          !Number.isInteger(rateLimit.retryAfterSeconds) ||
          rateLimit.retryAfterSeconds < 1
        ) {
          return reply
            .code(503)
            .send({ code: "TENANT_MUTATION_LIMIT_UNAVAILABLE" });
        }
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ code: "TENANT_MUTATION_RATE_LIMITED" });
      }

      try {
        const result = await options.tenantActionRunner.run(
          {
            action: "tenant.establishment.manage",
            session,
            tenantId: normalizedTenantId,
          },
          async ({ client }) =>
            options.administration!.create(client, {
              actorIp: request.ip,
              actorSubject: session.subject,
              cnpj: input.cnpj,
              idempotencyKey: idempotencyKey.toLowerCase(),
              traceId: request.id,
              tradeName: input.tradeName,
            }),
        );
        if (!result.allowed) {
          const mfaRequired = result.reason === "MFA_REQUIRED";
          return reply.code(mfaRequired ? 403 : 404).send({
            code: mfaRequired ? "MFA_REQUIRED" : "TENANT_RESOURCE_NOT_FOUND",
          });
        }

        const { establishment, replayed } = result.value;
        reply.header(
          "location",
          `/api/tenants/${normalizedTenantId}/establishments/${establishment.id}`,
        );
        if (replayed) reply.header("idempotency-replayed", "true");
        return reply.code(201).send({
          establishment: {
            id: establishment.id,
            tradeName: establishment.tradeName,
          },
          renaveLink: { status: "not_started" },
        });
      } catch (error) {
        const mapped = mapAdministrationError(safeErrorCode(error));
        request.log.error({
          errorCode: mapped.responseCode,
          event: "tenant.establishment_create.failed",
          traceId: request.id,
        });
        return reply.code(mapped.status).send({
          code: mapped.responseCode,
          traceId: request.id,
        });
      }
    },
  );
}
