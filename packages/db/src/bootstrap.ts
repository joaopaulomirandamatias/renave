import { Client } from "pg";
import {
  APP_ROLE,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  MIGRATOR_ROLE,
  OPERATION_WORKER_ROLE,
  PLATFORM_PROVISIONER_ROLE,
  PLATFORM_READER_ROLE,
  PROFILE_PROVISIONER_ROLE,
  PROFILE_READER_ROLE,
} from "./config.js";

export interface BootstrapOptions {
  /** URL de um superusuário (ou papel com CREATEROLE + dono do banco). Uso único, nunca da aplicação. */
  adminUrl: string;
  migratorPassword: string;
  appPassword: string;
  identityAppPassword: string;
  maintenanceAppPassword: string;
  operationWorkerPassword: string;
  profileProvisionerPassword: string;
  profileReaderPassword: string;
  platformProvisionerPassword: string;
  platformReaderPassword: string;
}

/**
 * Cria/atualiza, de forma idempotente, os papéis e os privilégios de banco:
 *
 *  - `renave_migrator`: LOGIN, dono dos objetos; CREATE no banco.
 *  - `renave_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, sem CREATE,
 *    não pertence ao migrator; só CONNECT (os GRANTs de tabela vêm das migrations).
 *  - `renave_identity_app`: LOGIN isolado, sem acesso às tabelas de negócio;
 *    recebe apenas EXECUTE nas rotinas OIDC pelas migrations.
 *  - `renave_maintenance_app`: LOGIN isolado, sem leitura direta; recebe
 *    apenas EXECUTE em rotinas operacionais fechadas pelas migrations.
 *  - `renave_operation_worker`: LOGIN isolado, sem leitura direta; recebe
 *    somente EXECUTE nas rotinas fenced de operações pelas migrations.
 *  - `renave_platform_reader`: LOGIN isolado; consulta apenas a projeção
 *    sanitizada do console global por funções fechadas.
 *  - `renave_platform_provisioner`: LOGIN isolado; concede e revoga operadores
 *    globais por funções offline, sem ler a fila.
 *
 * Rodar de novo rotaciona as senhas. As senhas vão como literal escapado no
 * servidor (`format('%L')`) e o log de statements é silenciado na transação.
 */
export async function bootstrapRoles(options: BootstrapOptions): Promise<void> {
  if (
    options.migratorPassword === "" ||
    options.appPassword === "" ||
    options.identityAppPassword === "" ||
    options.maintenanceAppPassword === "" ||
    options.operationWorkerPassword === "" ||
    options.profileProvisionerPassword === "" ||
    options.profileReaderPassword === "" ||
    options.platformProvisionerPassword === "" ||
    options.platformReaderPassword === ""
  ) {
    throw new Error("Senhas dos papéis não podem ser vazias.");
  }
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    const me = await client.query<{ rolsuper: boolean }>(
      "select rolsuper from pg_roles where rolname = current_user",
    );
    await client.query("begin");
    if (me.rows[0]?.rolsuper)
      await client.query("set local log_statement = 'none'");

    const attrs =
      "login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication";
    for (const [role, password] of [
      [MIGRATOR_ROLE, options.migratorPassword],
      [APP_ROLE, options.appPassword],
      [IDENTITY_APP_ROLE, options.identityAppPassword],
      [MAINTENANCE_APP_ROLE, options.maintenanceAppPassword],
      [OPERATION_WORKER_ROLE, options.operationWorkerPassword],
      [PROFILE_PROVISIONER_ROLE, options.profileProvisionerPassword],
      [PROFILE_READER_ROLE, options.profileReaderPassword],
      [PLATFORM_PROVISIONER_ROLE, options.platformProvisionerPassword],
      [PLATFORM_READER_ROLE, options.platformReaderPassword],
    ] as const) {
      const exists = await client.query(
        "select 1 from pg_roles where rolname = $1",
        [role],
      );
      const verb = exists.rowCount === 0 ? "create" : "alter";
      const { rows } = await client.query<{ sql: string }>(
        `select format('${verb} role %I ${attrs} password %L', $1::text, $2::text) as sql`,
        [role, password],
      );
      await client.query(rows[0]!.sql);
    }

    await client.query(
      `alter role ${APP_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${IDENTITY_APP_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${MAINTENANCE_APP_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${OPERATION_WORKER_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${PROFILE_PROVISIONER_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${PROFILE_READER_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${PLATFORM_PROVISIONER_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );
    await client.query(
      `alter role ${PLATFORM_READER_ROLE} set idle_in_transaction_session_timeout = '30s'`,
    );

    // Privilégios por banco (escopo da conexão administrativa).
    await client.query(`
      do $$
      declare db text := current_database();
      begin
        execute format('revoke all on database %I from public', db);
        execute format('grant connect, create on database %I to ${MIGRATOR_ROLE}', db);
        execute format('revoke all on database %I from ${APP_ROLE}', db);
        execute format('revoke all on database %I from ${IDENTITY_APP_ROLE}', db);
        execute format('revoke all on database %I from ${MAINTENANCE_APP_ROLE}', db);
        execute format('revoke all on database %I from ${OPERATION_WORKER_ROLE}', db);
        execute format('revoke all on database %I from ${PROFILE_PROVISIONER_ROLE}', db);
        execute format('revoke all on database %I from ${PROFILE_READER_ROLE}', db);
        execute format('revoke all on database %I from ${PLATFORM_PROVISIONER_ROLE}', db);
        execute format('revoke all on database %I from ${PLATFORM_READER_ROLE}', db);
        execute format('grant connect on database %I to ${APP_ROLE}', db);
        execute format('grant connect on database %I to ${IDENTITY_APP_ROLE}', db);
        execute format('grant connect on database %I to ${MAINTENANCE_APP_ROLE}', db);
        execute format('grant connect on database %I to ${OPERATION_WORKER_ROLE}', db);
        execute format('grant connect on database %I to ${PROFILE_PROVISIONER_ROLE}', db);
        execute format('grant connect on database %I to ${PROFILE_READER_ROLE}', db);
        execute format('grant connect on database %I to ${PLATFORM_PROVISIONER_ROLE}', db);
        execute format('grant connect on database %I to ${PLATFORM_READER_ROLE}', db);
      end $$`);
    await client.query("revoke all on schema public from public");
    await client.query(`revoke all on schema public from ${APP_ROLE}`);
    await client.query(`revoke all on schema public from ${IDENTITY_APP_ROLE}`);
    await client.query(
      `revoke all on schema public from ${MAINTENANCE_APP_ROLE}`,
    );
    await client.query(
      `revoke all on schema public from ${OPERATION_WORKER_ROLE}`,
    );
    await client.query(
      `revoke all on schema public from ${PROFILE_PROVISIONER_ROLE}`,
    );
    await client.query(
      `revoke all on schema public from ${PROFILE_READER_ROLE}`,
    );
    await client.query(
      `revoke all on schema public from ${PLATFORM_PROVISIONER_ROLE}`,
    );
    await client.query(
      `revoke all on schema public from ${PLATFORM_READER_ROLE}`,
    );
    for (const member of [
      APP_ROLE,
      IDENTITY_APP_ROLE,
      MAINTENANCE_APP_ROLE,
      OPERATION_WORKER_ROLE,
      PROFILE_PROVISIONER_ROLE,
      PROFILE_READER_ROLE,
      PLATFORM_PROVISIONER_ROLE,
      PLATFORM_READER_ROLE,
    ]) {
      for (const parent of [
        MIGRATOR_ROLE,
        APP_ROLE,
        IDENTITY_APP_ROLE,
        MAINTENANCE_APP_ROLE,
        OPERATION_WORKER_ROLE,
        PROFILE_PROVISIONER_ROLE,
        PROFILE_READER_ROLE,
        PLATFORM_PROVISIONER_ROLE,
        PLATFORM_READER_ROLE,
      ]) {
        if (member !== parent) {
          await client.query(`revoke ${parent} from ${member}`);
        }
      }
    }
    await client.query(`
      do $$
      declare membership record;
      begin
        for membership in
          select parent.rolname as parent_name, member.rolname as member_name
            from pg_catalog.pg_auth_members edge
            join pg_catalog.pg_roles parent on parent.oid=edge.roleid
            join pg_catalog.pg_roles member on member.oid=edge.member
           where parent.rolname in (
                   '${PLATFORM_PROVISIONER_ROLE}', '${PLATFORM_READER_ROLE}'
                 )
              or member.rolname in (
                   '${PLATFORM_PROVISIONER_ROLE}', '${PLATFORM_READER_ROLE}'
                 )
        loop
          execute format(
            'revoke %I from %I',
            membership.parent_name,
            membership.member_name
          );
        end loop;
      end $$`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
