import type { Pool } from "pg";

import {
  APP_ROLE,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  OPERATION_WORKER_ROLE,
} from "./config.js";

export type RuntimeDatabaseRole =
  | typeof APP_ROLE
  | typeof IDENTITY_APP_ROLE
  | typeof MAINTENANCE_APP_ROLE
  | typeof OPERATION_WORKER_ROLE;

export interface RuntimeDatabaseGuardOptions {
  expectedRole: RuntimeDatabaseRole;
}

interface RuntimeRoleRow {
  current_user: string;
  has_database_connect: boolean;
  has_database_create: boolean;
  has_database_ownership: boolean;
  has_database_temporary: boolean;
  has_protected_object_ownership: boolean;
  has_set_role: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolsuper: boolean;
  session_user: string;
}

export class RuntimeDatabaseContractError extends Error {
  readonly code = "RUNTIME_DATABASE_CONTRACT_REJECTED";
  override name = "RuntimeDatabaseContractError";

  constructor() {
    super("O banco de runtime não satisfaz o contrato de segurança esperado");
  }
}

function roleIsSafe(
  row: RuntimeRoleRow | undefined,
  expectedRole: RuntimeDatabaseRole,
): boolean {
  return (
    row !== undefined &&
    row.current_user === expectedRole &&
    row.session_user === expectedRole &&
    row.rolcanlogin &&
    !row.rolsuper &&
    !row.rolbypassrls &&
    !row.rolinherit &&
    !row.rolcreatedb &&
    !row.rolcreaterole &&
    !row.rolreplication &&
    row.has_database_connect &&
    !row.has_database_create &&
    !row.has_database_temporary &&
    !row.has_set_role &&
    !row.has_database_ownership &&
    !row.has_protected_object_ownership
  );
}

/**
 * Confirma identidade, atributos e contrato de migrations antes de compor o
 * runtime. Qualquer erro de rede, privilégio ou conteúdo falha fechado com uma
 * mensagem estável que não carrega URL, usuário ou texto do driver.
 */
export async function assertRuntimeDatabase(
  pool: Pool,
  options: RuntimeDatabaseGuardOptions,
): Promise<void> {
  if (
    options.expectedRole !== APP_ROLE &&
    options.expectedRole !== IDENTITY_APP_ROLE &&
    options.expectedRole !== MAINTENANCE_APP_ROLE &&
    options.expectedRole !== OPERATION_WORKER_ROLE
  ) {
    throw new RuntimeDatabaseContractError();
  }

  try {
    const role = await pool.query<RuntimeRoleRow>(
      `select
         current_user,
         session_user,
         roles.rolcanlogin,
         roles.rolsuper,
         roles.rolbypassrls,
         roles.rolinherit,
         roles.rolcreatedb,
         roles.rolcreaterole,
         roles.rolreplication,
         pg_catalog.has_database_privilege(
           current_user, pg_catalog.current_database(), 'CONNECT'
         ) as has_database_connect,
         pg_catalog.has_database_privilege(
           current_user, pg_catalog.current_database(), 'CREATE'
         ) as has_database_create,
         pg_catalog.has_database_privilege(
           current_user, pg_catalog.current_database(), 'TEMPORARY'
         ) as has_database_temporary,
         exists (
           select 1
             from pg_catalog.pg_roles candidate
            where candidate.rolname <> current_user
              and pg_catalog.pg_has_role(current_user, candidate.oid, 'set')
         ) as has_set_role,
         exists (
           select 1
             from pg_catalog.pg_database database
            where database.datname = pg_catalog.current_database()
              and database.datdba = roles.oid
         ) as has_database_ownership,
         exists (
           select 1
             from pg_catalog.pg_namespace namespace
            where namespace.nspname = any (
              array[
                'renave', 'renave_identity', 'renave_directory',
                'renave_operations', 'renave_runtime'
              ]::text[]
            )
              and namespace.nspowner = roles.oid
           union all
           select 1
             from pg_catalog.pg_class object
             join pg_catalog.pg_namespace namespace
               on namespace.oid = object.relnamespace
            where namespace.nspname = any (
              array[
                'renave', 'renave_identity', 'renave_directory',
                'renave_operations', 'renave_runtime'
              ]::text[]
            )
              and object.relowner = roles.oid
         ) as has_protected_object_ownership
       from pg_catalog.pg_roles roles
      where roles.rolname = current_user`,
    );
    if (!roleIsSafe(role.rows[0], options.expectedRole)) {
      throw new RuntimeDatabaseContractError();
    }

    const contractFunction =
      options.expectedRole === MAINTENANCE_APP_ROLE
        ? "maintenance_contract_ready"
        : options.expectedRole === OPERATION_WORKER_ROLE
          ? "operation_worker_contract_ready"
          : "api_contract_ready";
    const contract = await pool.query<{ ready: boolean }>(
      `select renave_runtime.${contractFunction}() as ready`,
    );
    if (contract.rows[0]?.ready !== true) {
      throw new RuntimeDatabaseContractError();
    }
  } catch (error) {
    if (error instanceof RuntimeDatabaseContractError) throw error;
    throw new RuntimeDatabaseContractError();
  }
}
