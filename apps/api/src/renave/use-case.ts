import {
  authorize,
  AuthorizationDeniedError,
} from "@seu-renave/access-control";
import {
  appendAuditEvent,
  getAuthorizationContext,
  getEstablishment,
  withTenant,
} from "@seu-renave/db";
import { PostgresProtectedEvidenceStore } from "@seu-renave/protected-evidence";
import {
  VehicleEligibilityService,
  type EligibilityAuditRecord,
  type VehicleEligibilityInput,
} from "@seu-renave/renave-application";
import type {
  RenaveConnector,
  VehicleEligibilityResponse,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import type { EvidenceCipher } from "@seu-renave/protected-evidence";

export interface EligibilityUseCase {
  authorize(input: VehicleEligibilityInput): Promise<void>;
  execute(input: VehicleEligibilityInput): Promise<VehicleEligibilityResponse>;
}

export interface PostgresEligibilityUseCaseOptions {
  certificateThumbprintSha256: string;
  cipher: EvidenceCipher;
  connector: RenaveConnector;
  integratorCnpj: string;
  pool: Pool;
}

function auditInput(record: EligibilityAuditRecord) {
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

/**
 * Composição por request. Cada adapter abre sua própria transação curta; a
 * chamada ao SERPRO nunca mantém conexão PostgreSQL presa.
 */
export class PostgresVehicleEligibilityUseCase implements EligibilityUseCase {
  constructor(private readonly options: PostgresEligibilityUseCaseOptions) {}

  async authorize(input: VehicleEligibilityInput): Promise<void> {
    const context = await withTenant(
      this.options.pool,
      input.tenantId,
      (client) => getAuthorizationContext(client, input.subject),
    );
    const decision = authorize(
      context ?? {
        grants: [],
        subject: input.subject,
        tenantId: input.tenantId,
      },
      {
        action: "renave.vehicle.eligibility.read",
        establishmentId: input.establishmentId,
        tenantId: input.tenantId,
      },
    );
    if (!decision.allowed) throw new AuthorizationDeniedError(decision.reason);
    const establishment = await withTenant(
      this.options.pool,
      input.tenantId,
      (client) => getEstablishment(client, input.establishmentId),
    );
    if (!establishment || establishment.status !== "active") {
      throw Object.assign(new Error("Estabelecimento indisponível"), {
        code: "ESTABLISHMENT_UNAVAILABLE",
      });
    }
  }

  async execute(
    input: VehicleEligibilityInput,
  ): Promise<VehicleEligibilityResponse> {
    const { pool } = this.options;
    const evidence = new PostgresProtectedEvidenceStore(
      pool,
      this.options.cipher,
      {
        action: "renave.vehicle.eligibility.read",
        establishmentId: input.establishmentId,
        tenantId: input.tenantId,
      },
    );
    const service = new VehicleEligibilityService(
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
        connector: this.options.connector,
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
