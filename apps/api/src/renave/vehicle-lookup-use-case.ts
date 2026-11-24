import {
  authorize,
  AuthorizationDeniedError,
} from "@seu-renave/access-control";
import {
  appendAuditEvent,
  getAuthorizationContext,
  getCredentialLink,
  getCredentialServiceScope,
  getEstablishment,
  withTenant,
} from "@seu-renave/db/api-runtime";
import {
  EvidenceCipher,
  PostgresProtectedEvidenceStore,
} from "@seu-renave/protected-evidence";
import {
  VehicleLookupService,
  type VehicleLookupAuditRecord,
  type VehicleLookupInput,
} from "@seu-renave/renave-application";
import type {
  RenaveQueryConnector,
  RenaveVehicle,
  RenaveVehicleLookupConnector,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import { RenaveLinkNotReadyError } from "./stock-query-use-case.js";
import { ESTABLISHMENT_SERVICE_NATURE } from "./service-scope.js";

const ACTION = "renave.vehicle.read" as const;

export interface PostgresVehicleLookupUseCaseOptions {
  certificateThumbprintSha256: string;
  cipher: EvidenceCipher;
  integratorCnpj: string;
  pool: Pool;
  stockConnector: Pick<RenaveQueryConnector, "getStocksByPlate">;
  vehicleConnector: Pick<RenaveVehicleLookupConnector, "getVehicleByPlate">;
}

function auditInput(record: VehicleLookupAuditRecord) {
  return {
    action: record.action,
    actorIp: record.actorIp,
    actorSubject: record.actorSubject,
    certificateThumbprintSha256: record.certificateThumbprintSha256,
    cnpjSent: record.cnpjSent,
    establishmentId: record.establishmentId,
    outcome: record.outcome,
    payloadReference: record.payloadReference,
    requestSha256: record.requestSha256,
    ...(record.cnpjConfirmed === undefined
      ? {}
      : { cnpjConfirmed: record.cnpjConfirmed }),
    ...(record.integratorCnpjConfirmed === undefined
      ? {}
      : { integratorCnpjConfirmed: record.integratorCnpjConfirmed }),
    ...(record.responseSha256 === undefined
      ? {}
      : { responseSha256: record.responseSha256 }),
    ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
  };
}

export class PostgresVehicleLookupUseCase {
  constructor(private readonly options: PostgresVehicleLookupUseCaseOptions) {}

  async authorize(
    input: Pick<VehicleLookupInput, "establishmentId" | "subject" | "tenantId">,
  ): Promise<void> {
    await withTenant(this.options.pool, input.tenantId, async (client) => {
      const context = await getAuthorizationContext(client, input.subject);
      const decision = authorize(
        context ?? {
          grants: [],
          subject: input.subject,
          tenantId: input.tenantId,
        },
        {
          action: ACTION,
          establishmentId: input.establishmentId,
          tenantId: input.tenantId,
        },
      );
      if (!decision.allowed) {
        throw new AuthorizationDeniedError(decision.reason);
      }
      const [establishment, link, serviceScope] = await Promise.all([
        getEstablishment(client, input.establishmentId),
        getCredentialLink(client, input.establishmentId),
        getCredentialServiceScope(
          client,
          input.establishmentId,
          ESTABLISHMENT_SERVICE_NATURE,
        ),
      ]);
      if (!establishment || establishment.status !== "active") {
        throw Object.assign(new Error("Estabelecimento indisponível"), {
          code: "ESTABLISHMENT_UNAVAILABLE",
        });
      }
      if (
        (link?.status !== "confirmed" && link?.status !== "enabled") ||
        serviceScope === null
      ) {
        throw new RenaveLinkNotReadyError();
      }
    });
  }

  async execute(input: VehicleLookupInput): Promise<RenaveVehicle> {
    await this.authorize(input);
    const { pool } = this.options;
    const evidence = new PostgresProtectedEvidenceStore(
      pool,
      this.options.cipher,
      {
        action: ACTION,
        establishmentId: input.establishmentId,
        tenantId: input.tenantId,
      },
    );
    const service = new VehicleLookupService(
      {
        audit: {
          append: async (record) => {
            await withTenant(pool, record.tenantId, (client) =>
              appendAuditEvent(client, auditInput(record)),
            );
          },
        },
        authorizationContexts: {
          load: ({ subject, tenantId }) =>
            withTenant(pool, tenantId, (client) =>
              getAuthorizationContext(client, subject),
            ),
        },
        connector: {
          getStocksByPlate: (context, plate) =>
            this.options.stockConnector.getStocksByPlate(context, plate),
          getVehicleByPlate: (context, plate) =>
            this.options.vehicleConnector.getVehicleByPlate(context, plate),
        },
        establishments: {
          load: ({ establishmentId, tenantId }) =>
            withTenant(pool, tenantId, async (client) => {
              const establishment = await getEstablishment(
                client,
                establishmentId,
              );
              return establishment === null
                ? null
                : {
                    cnpj: establishment.cnpj,
                    id: establishment.id,
                    status: establishment.status,
                    tenantId: establishment.tenantId,
                  };
            }),
        },
        finalization: {
          fail: async ({ audit, errorCode, payloadReference }) => {
            await withTenant(pool, audit.tenantId, async (client) => {
              await evidence.failWithClient(client, {
                errorCode,
                payloadReference,
              });
              await appendAuditEvent(client, auditInput(audit));
            });
          },
          succeed: async ({ audit, evidenceResponse, payloadReference }) => {
            await withTenant(pool, audit.tenantId, async (client) => {
              await evidence.completeWithClient(client, {
                payloadReference,
                response: evidenceResponse,
              });
              await appendAuditEvent(client, auditInput(audit));
            });
          },
        },
        protectedEvidence: evidence,
      },
      {
        certificateThumbprintSha256: this.options.certificateThumbprintSha256,
        integratorCnpj: this.options.integratorCnpj,
      },
    );
    return service.execute(input);
  }
}
