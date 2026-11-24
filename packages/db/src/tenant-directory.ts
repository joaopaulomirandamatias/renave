import { createHash } from "node:crypto";

import type { Pool } from "pg";

export interface TenantDirectoryEntry {
  displayName: string;
  tenantId: string;
}

interface TenantDirectoryRow {
  display_name: string;
  tenant_id: string;
}

export class TenantDirectoryInputError extends Error {
  override name = "TenantDirectoryInputError";
}

export async function discoverTenants(
  pool: Pool,
  subject: string,
): Promise<TenantDirectoryEntry[]> {
  if (
    subject.trim() !== subject ||
    subject.length === 0 ||
    subject.length > 255
  ) {
    throw new TenantDirectoryInputError("Subject OIDC inválido.");
  }
  const subjectHash = createHash("sha256").update(subject, "utf8").digest();
  const { rows } = await pool.query<TenantDirectoryRow>(
    `select tenant_id, display_name
       from renave_directory.discover_tenants($1)`,
    [subjectHash],
  );
  return rows.map((row) => ({
    displayName: row.display_name,
    tenantId: row.tenant_id,
  }));
}
