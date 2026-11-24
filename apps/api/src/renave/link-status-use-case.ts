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
} from "@seu-renave/db/api-runtime";
import type { Pool } from "pg";

export type PublicRenaveLinkStatus = "not_started" | CredentialLinkStatus;

export interface RenaveLinkStatusUseCase {
  execute(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<{ status: PublicRenaveLinkStatus }>;
}

export class PostgresRenaveLinkStatusUseCase implements RenaveLinkStatusUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(input: {
    establishmentId: string;
    subject: string;
    tenantId: string;
  }): Promise<{ status: PublicRenaveLinkStatus }> {
    return withTenant(this.pool, input.tenantId, async (client) => {
      const context = await getAuthorizationContext(client, input.subject);
      const decision = authorize(
        context ?? {
          grants: [],
          subject: input.subject,
          tenantId: input.tenantId,
        },
        {
          action: "renave.identity.verify",
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
        // Não distingue ID ausente de loja inativa ou fora do escopo.
        throw new AuthorizationDeniedError("ESTABLISHMENT_SCOPE_DENIED");
      }
      const link = await getCredentialLink(client, input.establishmentId);
      return { status: link?.status ?? "not_started" };
    });
  }
}
