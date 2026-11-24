import type { TenantClient } from "./tenant-context.js";

export interface Establishment {
  id: string;
  tenantId: string;
  cnpj: string;
  cnpjRoot: string;
  cnpjBranch: string;
  tradeName: string;
  status: "active" | "inactive";
}

interface EstablishmentRow {
  id: string;
  tenant_id: string;
  cnpj: string;
  cnpj_root: string;
  cnpj_branch: string;
  trade_name: string;
  status: "active" | "inactive";
}

const COLUMNS =
  "id, tenant_id, cnpj, cnpj_root, cnpj_branch, trade_name, status";

function toEstablishment(row: EstablishmentRow): Establishment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cnpj: row.cnpj,
    cnpjRoot: row.cnpj_root,
    cnpjBranch: row.cnpj_branch,
    tradeName: row.trade_name,
    status: row.status,
  };
}

/**
 * Cria um estabelecimento no tenant ativo da transação. O `tenant_id` nunca
 * vem do chamador: é o da transação (`renave.current_tenant_id()`); sem tenant
 * ativo o INSERT é recusado pela RLS. O CNPJ pode vir com máscara e é
 * normalizado e validado pelo banco.
 */
export async function createEstablishment(
  client: TenantClient,
  input: { cnpj: string; tradeName: string },
): Promise<Establishment> {
  const { rows } = await client.query<EstablishmentRow>(
    `insert into renave.establishment (tenant_id, cnpj, trade_name)
     values (renave.current_tenant_id(), $1, $2)
     returning ${COLUMNS}`,
    [input.cnpj, input.tradeName],
  );
  return toEstablishment(rows[0]!);
}

export async function listEstablishments(
  client: TenantClient,
): Promise<Establishment[]> {
  const { rows } = await client.query<EstablishmentRow>(
    `select ${COLUMNS} from renave.establishment order by cnpj`,
  );
  return rows.map(toEstablishment);
}

export async function getEstablishment(
  client: TenantClient,
  id: string,
): Promise<Establishment | null> {
  const { rows } = await client.query<EstablishmentRow>(
    `select ${COLUMNS} from renave.establishment where id = $1`,
    [id],
  );
  return rows[0] ? toEstablishment(rows[0]) : null;
}

/** Renomeia; devolve `null` se a linha não existe no tenant ativo. */
export async function renameEstablishment(
  client: TenantClient,
  id: string,
  tradeName: string,
): Promise<Establishment | null> {
  const { rows } = await client.query<EstablishmentRow>(
    `update renave.establishment set trade_name = $2 where id = $1 returning ${COLUMNS}`,
    [id, tradeName],
  );
  return rows[0] ? toEstablishment(rows[0]) : null;
}
