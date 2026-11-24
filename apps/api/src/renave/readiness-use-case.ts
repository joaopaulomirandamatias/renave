import {
  authorize,
  AuthorizationDeniedError,
} from "@seu-renave/access-control";
import {
  getAuthorizationContext,
  getCredentialLink,
  getCredentialServiceScope,
  getEstablishment,
  getEstablishmentRenaveProfileStatus,
  getOperatorIdentityProfileStatus,
  withTenant,
  type CredentialLinkStatus,
  type RenaveProfileStatusValue,
  type TenantClient,
} from "@seu-renave/db/api-runtime";
import type { MtlsCertificateTemporalStatus } from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import type { PublicRenaveLinkStatus } from "./link-status-use-case.js";
import { ESTABLISHMENT_SERVICE_NATURE } from "./service-scope.js";

const ACTION = "renave.identity.verify" as const;
const READY_LINK_STATUSES = new Set<CredentialLinkStatus>([
  "confirmed",
  "enabled",
]);

export type PublicCertificateReadiness =
  "ready" | "warning" | "blocked" | "unavailable";
export type PublicPrincipalReadiness =
  "missing" | "pending" | "verified" | "suspended" | "unavailable";

export interface RenaveHomologationReadiness {
  certificate: PublicCertificateReadiness;
  environment: "homologation";
  establishmentContact: PublicPrincipalReadiness;
  integration: "configured" | "disabled";
  link: PublicRenaveLinkStatus;
  mutations: "blocked";
  operatorIdentity: PublicPrincipalReadiness;
  queries: "ready" | "blocked";
}

export interface RenaveReadinessUseCase {
  execute(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<RenaveHomologationReadiness>;
}

export function publicCertificateReadiness(
  configured: boolean,
  status?: MtlsCertificateTemporalStatus,
): PublicCertificateReadiness {
  if (!configured) return "unavailable";
  if (status === "healthy") return "ready";
  if (status?.startsWith("expiring_")) return "warning";
  return "blocked";
}

export function summarizeRenaveReadiness(input: {
  certificateStatus?: MtlsCertificateTemporalStatus;
  establishmentContact: PublicPrincipalReadiness;
  integrationConfigured: boolean;
  link: PublicRenaveLinkStatus;
  operatorIdentity: PublicPrincipalReadiness;
  queryLimiterConfigured: boolean;
  serviceScopeActive: boolean;
}): RenaveHomologationReadiness {
  const certificate = publicCertificateReadiness(
    input.integrationConfigured,
    input.certificateStatus,
  );
  const queriesReady =
    input.integrationConfigured &&
    input.queryLimiterConfigured &&
    (certificate === "ready" || certificate === "warning") &&
    READY_LINK_STATUSES.has(input.link as CredentialLinkStatus) &&
    input.serviceScopeActive;

  return {
    certificate,
    environment: "homologation",
    establishmentContact: input.establishmentContact,
    integration: input.integrationConfigured ? "configured" : "disabled",
    link: input.link,
    mutations: "blocked",
    operatorIdentity: input.operatorIdentity,
    queries: queriesReady ? "ready" : "blocked",
  };
}

function publicPrincipalReadiness(
  status: RenaveProfileStatusValue | null,
): PublicPrincipalReadiness {
  if (status === null) return "missing";
  if (status === "pending" || status === "verified" || status === "suspended") {
    return status;
  }
  throw new Error("Estado de perfil RENAVE inválido.");
}

async function readProfileWithinSavepoint(
  client: TenantClient,
  savepoint: "renave_readiness_establishment" | "renave_readiness_operator",
  read: () => Promise<RenaveProfileStatusValue | null>,
): Promise<PublicPrincipalReadiness> {
  await client.query(`savepoint ${savepoint}`);
  try {
    const status = publicPrincipalReadiness(await read());
    await client.query(`release savepoint ${savepoint}`);
    return status;
  } catch {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    return "unavailable";
  }
}

export class PostgresRenaveReadinessUseCase implements RenaveReadinessUseCase {
  constructor(
    private readonly options: {
      certificateTemporalStatus?: () => MtlsCertificateTemporalStatus;
      integrationConfigured: boolean;
      pool: Pool;
      queryLimiterConfigured: boolean;
    },
  ) {}

  async execute(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<RenaveHomologationReadiness> {
    const localState = await withTenant(
      this.options.pool,
      input.tenantId,
      async (client) => {
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
        const establishment = await getEstablishment(
          client,
          input.establishmentId,
        );
        if (!establishment || establishment.status !== "active") {
          throw new AuthorizationDeniedError("ESTABLISHMENT_SCOPE_DENIED");
        }
        const link = await getCredentialLink(client, input.establishmentId);
        const serviceScope = await getCredentialServiceScope(
          client,
          input.establishmentId,
          ESTABLISHMENT_SERVICE_NATURE,
        );
        const operatorIdentity = await readProfileWithinSavepoint(
          client,
          "renave_readiness_operator",
          async () =>
            await getOperatorIdentityProfileStatus(client, input.subject),
        );
        const establishmentContact = await readProfileWithinSavepoint(
          client,
          "renave_readiness_establishment",
          async () =>
            await getEstablishmentRenaveProfileStatus(
              client,
              input.establishmentId,
            ),
        );
        return { establishmentContact, link, operatorIdentity, serviceScope };
      },
    );

    let certificateStatus: MtlsCertificateTemporalStatus | undefined;
    try {
      certificateStatus = this.options.certificateTemporalStatus?.();
    } catch {
      certificateStatus = "invalid_clock";
    }

    return summarizeRenaveReadiness({
      ...(certificateStatus ? { certificateStatus } : {}),
      establishmentContact: localState.establishmentContact,
      integrationConfigured: this.options.integrationConfigured,
      link: localState.link?.status ?? "not_started",
      operatorIdentity: localState.operatorIdentity,
      queryLimiterConfigured: this.options.queryLimiterConfigured,
      serviceScopeActive: localState.serviceScope !== null,
    });
  }
}
