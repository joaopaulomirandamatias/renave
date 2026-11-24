import type { Pool } from "pg";
import { withTenant } from "./tenant-context.js";
import type { TenantClient } from "./tenant-context.js";

export interface Tenant {
  id: string;
  slug: string;
  displayName: string;
  status: "active" | "suspended";
}

interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  status: "active" | "suspended";
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
  };
}

/**
 * Provisiona um tenant. Usa o pool do MIGRATOR (a aplicação não tem INSERT em
 * `tenant`). A RLS continua valendo: a inserção acontece dentro do contexto do
 * próprio novo tenant, cujo UUID é gerado aqui.
 */
export async function provisionTenant(
  migratorPool: Pool,
  input: { slug: string; displayName: string },
): Promise<Tenant> {
  const id = crypto.randomUUID();
  return withTenant(migratorPool, id, async (client) => {
    const { rows } = await client.query<TenantRow>(
      `insert into renave.tenant (id, slug, display_name)
       values ($1, $2, $3)
       returning id, slug, display_name, status`,
      [id, input.slug, input.displayName],
    );
    return toTenant(rows[0]!);
  });
}

/** O tenant ativo da transação (a RLS deixa visível apenas ele). */
export async function getCurrentTenant(
  client: TenantClient,
): Promise<Tenant | null> {
  const { rows } = await client.query<TenantRow>(
    "select id, slug, display_name, status from renave.tenant",
  );
  return rows[0] ? toTenant(rows[0]) : null;
}
