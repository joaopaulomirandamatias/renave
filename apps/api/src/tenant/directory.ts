import { authorize } from "@seu-renave/access-control";
import {
  discoverTenants,
  getAuthorizationContext,
  getCredentialLink,
  getEstablishment,
  listEstablishments,
  withTenant,
} from "@seu-renave/db/api-runtime";
import type { Pool } from "pg";

import type { TenantDirectory } from "./routes.js";

/** Adapter PostgreSQL do diretório SaaS, mantendo descoberta global e RBAC separados. */
export function createPostgresTenantDirectory(pool: Pool): TenantDirectory {
  return {
    discover(subject) {
      return discoverTenants(pool, subject);
    },
    getEstablishment: ({ establishmentId, subject, tenantId }) =>
      withTenant(pool, tenantId, async (client) => {
        const context = await getAuthorizationContext(client, subject);
        if (!context) return null;
        const decision = authorize(context, {
          action: "renave.identity.verify",
          establishmentId,
          tenantId,
        });
        if (!decision.allowed) return null;
        const establishment = await getEstablishment(client, establishmentId);
        if (!establishment || establishment.status !== "active") return null;
        const link = await getCredentialLink(client, establishmentId);
        return {
          establishment: {
            id: establishment.id,
            tradeName: establishment.tradeName,
          },
          renaveLink: { status: link?.status ?? "not_started" },
        };
      }),
    listEstablishments: ({ subject, tenantId }) =>
      withTenant(pool, tenantId, async (client) => {
        const context = await getAuthorizationContext(client, subject);
        if (!context) return null;
        const establishments = await listEstablishments(client);
        return {
          canManageEstablishments: authorize(context, {
            action: "tenant.establishment.manage",
            tenantId,
          }).allowed,
          establishments: establishments
            .filter(
              (establishment) =>
                establishment.status === "active" &&
                authorize(context, {
                  action: "renave.vehicle.eligibility.read",
                  establishmentId: establishment.id,
                  tenantId,
                }).allowed,
            )
            .map((establishment) => ({
              id: establishment.id,
              tradeName: establishment.tradeName,
            })),
        };
      }),
  };
}
