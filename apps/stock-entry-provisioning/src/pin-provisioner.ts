import { Pool, type PoolClient, type PoolConfig } from "pg";

import {
  destroyStockEntryKeyBundle,
  type StockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import { provisioningError, StockEntryProvisioningError } from "./errors.js";

export const STOCK_ENTRY_PIN_WRITE_ONCE_ACK =
  "BACKUP_AND_RESTORE_VERIFIED_WRITE_ONCE";

interface RoleRow {
  current_bypassrls: boolean;
  current_createdb: boolean;
  current_createrole: boolean;
  current_name: string;
  current_super: boolean;
  session_bypassrls: boolean;
  session_createdb: boolean;
  session_createrole: boolean;
  session_name: string;
  session_super: boolean;
}

export type PinStatus = "absent" | "divergent" | "matching";

/** @internal Exportado para testes de política TLS sem abrir socket. */
export function provisioningDatabaseConfig(
  connectionString: string,
  databaseCa: string | undefined,
): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.search !== "" ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (!loopback && !databaseCa) {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  return {
    application_name: "seu-renave-stock-entry-provisioning",
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 1,
    query_timeout: 7_000,
    statement_timeout: 5_000,
    ...(databaseCa
      ? { ssl: { ca: databaseCa, rejectUnauthorized: true } }
      : {}),
  };
}

async function assertMigrator(client: PoolClient): Promise<void> {
  const { rows } = await client.query<RoleRow>(
    `select current_role_row.rolname as current_name,
            current_role_row.rolsuper as current_super,
            current_role_row.rolbypassrls as current_bypassrls,
            current_role_row.rolcreaterole as current_createrole,
            current_role_row.rolcreatedb as current_createdb,
            session_role_row.rolname as session_name,
            session_role_row.rolsuper as session_super,
            session_role_row.rolbypassrls as session_bypassrls,
            session_role_row.rolcreaterole as session_createrole,
            session_role_row.rolcreatedb as session_createdb
       from pg_catalog.pg_roles current_role_row
       join pg_catalog.pg_roles session_role_row
         on session_role_row.rolname = session_user
      where current_role_row.rolname = current_user`,
  );
  const role = rows[0];
  if (
    rows.length !== 1 ||
    role?.current_name !== "renave_migrator" ||
    role.session_name !== "renave_migrator" ||
    role.current_super ||
    role.current_bypassrls ||
    role.current_createrole ||
    role.current_createdb ||
    role.session_super ||
    role.session_bypassrls ||
    role.session_createrole ||
    role.session_createdb
  ) {
    throw new StockEntryProvisioningError("DATABASE_ROLE_INVALID");
  }
}

async function assertContract(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ ready: boolean }>(
    `select renave_runtime.api_contract_ready() as ready`,
  );
  if (rows.length !== 1 || rows[0]?.ready !== true) {
    throw new StockEntryProvisioningError("PIN_PROVISIONING_FAILED");
  }
}

async function pinStatus(
  client: PoolClient,
  bundle: StockEntryKeyBundle,
): Promise<PinStatus> {
  const { rows: countRows } = await client.query<{ count: string }>(
    `select pg_catalog.count(*)::text as count
       from renave_runtime.stock_entry_runtime_key_generation`,
  );
  if (countRows[0]?.count === "0") return "absent";
  if (countRows[0]?.count !== "1") return "divergent";
  const { rows } = await client.query<{ matches: boolean }>(
    `select renave_runtime.matches_stock_entry_runtime_key_generation($1, $2)
       as matches`,
    [bundle.digests.generationId, bundle.digests.fingerprint],
  );
  return rows.length === 1 && rows[0]?.matches === true
    ? "matching"
    : "divergent";
}

async function transaction<T>(
  client: PoolClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = '5s'");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local idle_in_transaction_session_timeout = '5s'");
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

export async function inspectPinWithClient(
  client: PoolClient,
  bundle: StockEntryKeyBundle,
): Promise<PinStatus> {
  try {
    return await transaction(client, async () => {
      await assertMigrator(client);
      await assertContract(client);
      return pinStatus(client, bundle);
    });
  } catch (error) {
    throw provisioningError(error, "PIN_PROVISIONING_FAILED");
  }
}

export async function provisionPinWithClient(
  client: PoolClient,
  bundle: StockEntryKeyBundle,
): Promise<void> {
  try {
    await transaction(client, async () => {
      await assertMigrator(client);
      await assertContract(client);
      if ((await pinStatus(client, bundle)) !== "absent") {
        throw new StockEntryProvisioningError("PIN_STATE_DIVERGENT");
      }
      await client.query(
        `insert into renave_runtime.stock_entry_runtime_key_generation
          (singleton, generation_id, runtime_fingerprint)
         values (true, $1, $2)`,
        [bundle.digests.generationId, bundle.digests.fingerprint],
      );
      if ((await pinStatus(client, bundle)) !== "matching") {
        throw new StockEntryProvisioningError("PIN_PROVISIONING_FAILED");
      }
      await assertContract(client);
    });
  } catch (error) {
    throw provisioningError(error, "PIN_PROVISIONING_FAILED");
  }
}

export function assertPinConfirmation(input: {
  acknowledgement: string | undefined;
  bundle: StockEntryKeyBundle;
  confirmFingerprint: string | undefined;
  confirmGeneration: string | undefined;
}): void {
  const fingerprint = input.bundle.digests.fingerprint.toString("hex");
  if (
    input.acknowledgement !== STOCK_ENTRY_PIN_WRITE_ONCE_ACK ||
    input.confirmGeneration !== input.bundle.digests.generationId ||
    input.confirmFingerprint !== fingerprint
  ) {
    throw new StockEntryProvisioningError("PIN_CONFIRMATION_INVALID");
  }
}

export async function withProvisioningDatabase<T>(input: {
  bundle: StockEntryKeyBundle;
  databaseCa: string | undefined;
  databaseUrl: string;
  operation: (client: PoolClient, bundle: StockEntryKeyBundle) => Promise<T>;
}): Promise<T> {
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    pool = new Pool(
      provisioningDatabaseConfig(input.databaseUrl, input.databaseCa),
    );
    client = await pool.connect();
    return await input.operation(client, input.bundle);
  } catch (error) {
    throw provisioningError(error, "PIN_PROVISIONING_FAILED");
  } finally {
    client?.release(true);
    await pool?.end().catch(() => undefined);
    destroyStockEntryKeyBundle(input.bundle);
  }
}
