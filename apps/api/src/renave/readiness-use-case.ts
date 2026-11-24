import {
  authorize,
  AuthorizationDeniedError,
} from "@seu-renave/access-control";
import {
  getAuthorizationContext,
  getCredentialLink,
  getEstablishment,
  withTenant,
  type CredentialLinkStatus,
} from "@seu-renave/db";
import type { MtlsCertificateTemporalStatus } from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import type { PublicRenaveLinkStatus } from "./link-status-use-case.js";

const ACTION = "renave.identity.verify" as const;
const READY_LINK_STATUSES = new Set<CredentialLinkStatus>([
  "confirmed",
  "enabled",
]);

export type PublicCertificateReadiness =
  "ready" | "warning" | "blocked" | "unavailable";

export interface RenaveHomologationReadiness {
  certificate: PublicCertificateReadiness;
  environment: "homologation";
  integration: "configured" | "disabled";
  link: PublicRenaveLinkStatus;
  mutations: "blocked";
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
  integrationConfigured: boolean;
  link: PublicRenaveLinkStatus;
  queryLimiterConfigured: boolean;
}): RenaveHomologationReadiness {
  const certificate = publicCertificateReadiness(
    input.integrationConfigured,
    input.certificateStatus,
  );
  const queriesReady =
    input.integrationConfigured &&
    input.queryLimiterConfigured &&
    (certificate === "ready" || certificate === "warning") &&
    READY_LINK_STATUSES.has(input.link as CredentialLinkStatus);

  return {
    certificate,
    environment: "homologation",
    integration: input.integrationConfigured ? "configured" : "disabled",
    link: input.link,
    mutations: "blocked",
    queries: queriesReady ? "ready" : "blocked",
  };
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
    const link = await withTenant(
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
        return await getCredentialLink(client, input.establishmentId);
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
      integrationConfigured: this.options.integrationConfigured,
      link: link?.status ?? "not_started",
      queryLimiterConfigured: this.options.queryLimiterConfigured,
    });
  }
}
