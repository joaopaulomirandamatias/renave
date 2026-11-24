import { Pool, type PoolClient, type PoolConfig } from "pg";
import { TENANT_SETTING } from "./config.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  override name = "TenantContextError";
}

/** Cliente já dentro de uma transação com o tenant ativo definido. */
export type TenantClient = PoolClient;

export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    throw new TenantContextError(
      "Tenant ativo ausente ou inválido: esperado um UUID.",
    );
  }
}

export function createPool(
  connectionString: string,
  options: PoolConfig = {},
): Pool {
  return new Pool({ connectionString, ...options });
}

/**
 * Executa `work` numa transação com o tenant ativo definido por
 * `set_config(..., is_local = true)`. O valor é descartado no COMMIT/ROLLBACK,
 * portanto uma conexão devolvida ao pool nunca carrega o tenant anterior.
 *
 * Sem UUID válido a função falha antes de abrir conexão (fail closed). Dentro
 * do banco, ausência de tenant já resulta em zero linhas e escrita recusada.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  work: (client: TenantClient) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    await client.query("select set_config($1, $2, true)", [
      TENANT_SETTING,
      tenantId.toLowerCase(),
    ]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      broken = true; // conexão em estado incerto: descartar em vez de reutilizar
    }
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
}
