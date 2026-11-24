import { authorize } from "@seu-renave/access-control";
import {
  discoverTenants,
  getAuthorizationContext,
  listEstablishments,
  withTenant,
} from "@seu-renave/db";
import type { Pool } from "pg";

import type { TenantDirectory } from "./routes.js";

/** Adapter PostgreSQL do diretório SaaS, mantendo descoberta global e RBAC separados. */
export function createPostgresTenantDirectory(pool: Pool): TenantDirectory {
  return {
    discover(subject) {
      return discoverTenants(pool, subject);
    },
    listEstablishments: ({ subject, tenantId }) =>
      withTenant(pool, tenantId, async (client) => {
        const context = await getAuthorizationContext(client, subject);
        if (!context) return null;
        const establishments = await listEstablishments(client);
        return establishments
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
          }));
      }),
  };
}
