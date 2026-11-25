import type {
  AuthorizationContext,
  RoleGrant,
  TenantRole,
} from "@seu-renave/access-control";

import type { TenantClient } from "./tenant-context.js";

interface AuthorizationRow {
  establishment_id: string | null;
  role: TenantRole;
  subject: string;
  tenant_id: string;
}

export interface TenantUserAccessGrant {
  establishmentIds?: readonly string[];
  role: TenantRole;
}

export class TenantAccessInputError extends Error {
  override name = "TenantAccessInputError";
}

export async function grantTenantUserAccess(
  client: TenantClient,
  subject: string,
  grants: readonly TenantUserAccessGrant[],
): Promise<void> {
  if (
    subject.trim() !== subject ||
    subject.length === 0 ||
    subject.length > 255
  ) {
    throw new TenantAccessInputError("Subject OIDC inválido.");
  }
  if (grants.length === 0) {
    throw new TenantAccessInputError("Informe pelo menos um papel.");
  }

  await client.query(
    `insert into renave.tenant_user (tenant_id, subject)
     values (renave.current_tenant_id(), $1)
     on conflict (tenant_id, subject) do update set status = 'active'`,
    [subject],
  );

  for (const grant of grants) {
    const establishmentIds = [...new Set(grant.establishmentIds ?? [])];
    if (grant.role === "renave_operator" && establishmentIds.length === 0) {
      throw new TenantAccessInputError(
        "Operador RENAVE precisa de ao menos um estabelecimento.",
      );
    }
    if (grant.role !== "renave_operator" && establishmentIds.length > 0) {
      throw new TenantAccessInputError(
        "Somente o operador RENAVE recebe escopo de estabelecimento.",
      );
    }

    await client.query(
      `insert into renave.tenant_role_grant (tenant_id, subject, role)
       values (renave.current_tenant_id(), $1, $2)
       on conflict do nothing`,
      [subject, grant.role],
    );
    for (const establishmentId of establishmentIds) {
      await client.query(
        `insert into renave.establishment_role_scope (
           tenant_id, subject, role, establishment_id
         ) values (renave.current_tenant_id(), $1, $2, $3)
         on conflict do nothing`,
        [subject, grant.role, establishmentId],
      );
    }
  }
}

export async function getAuthorizationContext(
  client: TenantClient,
  subject: string,
): Promise<AuthorizationContext | null> {
  const { rows } = await client.query<AuthorizationRow>(
    `select u.tenant_id, u.subject, g.role, s.establishment_id
       from renave.tenant_user u
       join renave.tenant t
         on t.id = u.tenant_id and t.status = 'active'
       join renave.tenant_role_grant g
         on g.tenant_id = u.tenant_id and g.subject = u.subject
       left join renave.establishment_role_scope s
         on s.tenant_id = g.tenant_id
        and s.subject = g.subject
        and s.role = g.role
      where u.subject = $1 and u.status = 'active'
      order by g.role, s.establishment_id`,
    [subject],
  );
  if (rows.length === 0) return null;

  const grants = new Map<TenantRole, Set<string>>();
  for (const row of rows) {
    const scoped = grants.get(row.role) ?? new Set<string>();
    if (row.establishment_id !== null) scoped.add(row.establishment_id);
    grants.set(row.role, scoped);
  }

  const roleGrants: RoleGrant[] = [...grants].map(([role, ids]) => ({
    establishmentIds:
      role === "renave_operator" ? [...ids].sort() : ("*" as const),
    role,
  }));

  return {
    grants: roleGrants,
    subject: rows[0]!.subject,
    tenantId: rows[0]!.tenant_id,
  };
}

export type TenantUserStatus = "active" | "suspended";

export interface TenantMemberRoleSummary {
  active: boolean;
  createdAt: string;
  establishmentIds: readonly string[];
  memberId: string;
  role: TenantRole;
  status: TenantUserStatus;
}

interface TenantMemberRow {
  created_at: Date | string;
  establishment_id: string | null;
  member_digest: string;
  role: TenantRole;
  status: TenantUserStatus;
}

function digestToOpaqueUuid(hexDigest: string): string {
  const hex = hexDigest.toLowerCase().slice(0, 32).padEnd(32, "0");
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13, 16)}`;
  const variantNibble = (parseInt(hex[16]!, 16) & 0x3) | 0x8;
  const variant = variantNibble.toString(16);
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Lista vínculos de papéis do tenant atual sob FORCE RLS sem selecionar ou
 * expor `subject`, e-mail, CPF ou qualquer identificador do IdP.
 */
export async function listTenantMembers(
  client: TenantClient,
): Promise<readonly TenantMemberRoleSummary[]> {
  const { rows } = await client.query<TenantMemberRow>(
    `select
       pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(
             'renave.tenant_member.v1:' || u.tenant_id::text || ':' || u.subject,
             'UTF8'
           )
         ),
         'hex'
       ) as member_digest,
       g.role,
       u.status,
       g.created_at,
       s.establishment_id
     from renave.tenant_user u
     join renave.tenant_role_grant g
       on g.tenant_id = u.tenant_id and g.subject = u.subject
     left join renave.establishment_role_scope s
       on s.tenant_id = g.tenant_id
      and s.subject = g.subject
      and s.role = g.role
     order by g.created_at asc, member_digest asc, g.role asc, s.establishment_id asc`,
  );

  const grouped = new Map<
    string,
    {
      createdAt: string;
      establishmentIds: Set<string>;
      memberId: string;
      role: TenantRole;
      status: TenantUserStatus;
    }
  >();

  for (const row of rows) {
    const memberId = digestToOpaqueUuid(row.member_digest);
    const key = `${memberId}:${row.role}`;
    let entry = grouped.get(key);
    if (!entry) {
      const createdAt =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
      entry = {
        createdAt,
        establishmentIds: new Set<string>(),
        memberId,
        role: row.role,
        status: row.status,
      };
      grouped.set(key, entry);
    }
    if (row.establishment_id !== null) {
      entry.establishmentIds.add(row.establishment_id);
    }
  }

  return [...grouped.values()].map((entry) => ({
    active: entry.status === "active",
    createdAt: entry.createdAt,
    establishmentIds: [...entry.establishmentIds].sort(),
    memberId: entry.memberId,
    role: entry.role,
    status: entry.status,
  }));
}
