import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import {
  APP_ROLE,
  DEFAULT_MIGRATIONS_DIR,
  IDENTITY_APP_ROLE,
  PLATFORM_PROVISIONER_ROLE,
  PLATFORM_READER_ROLE,
  PROFILE_PROVISIONER_ROLE,
  PROFILE_READER_ROLE,
  SCHEMA,
} from "./config.js";

export interface Migration {
  /** Nome do arquivo sem `.sql`, ex.: `0001_tenant_establishment`. */
  version: string;
  sql: string;
  /** SHA-256 hexadecimal do conteúdo exato do arquivo. */
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Chave fixa do advisory lock: serializa runners concorrentes.
const ADVISORY_LOCK_KEY = 7_265_110_001n;

/** Lê as migrations em ordem numérica; exige sequência 0001, 0002… sem lacunas. */
export async function loadMigrations(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrations: Migration[] = [];
  for (const [index, name] of names.entries()) {
    const match = FILE_PATTERN.exec(name);
    if (!match) {
      throw new MigrationError(
        `Nome de migration inválido: ${name} (esperado NNNN_descricao.sql)`,
      );
    }
    const expected = String(index + 1).padStart(4, "0");
    if (match[1] !== expected) {
      throw new MigrationError(
        `Sequência de migrations quebrada: esperado ${expected}, achei ${name}`,
      );
    }
    const sql = await readFile(join(dir, name), "utf8");
    migrations.push({
      version: name.slice(0, -".sql".length),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

/**
 * Aplica as migrations pendentes com o papel migrator. Cada migration roda em
 * transação junto com o registro no ledger. Migration já aplicada cujo arquivo
 * mudou (checksum) ou sumiu faz o runner parar: histórico é imutável.
 */
export async function runMigrations(
  migratorUrl: string,
  options: { dir?: string } = {},
): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.dir);
  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [
      ADVISORY_LOCK_KEY.toString(),
    ]);

    const roles = await client.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname = any($1::text[]) order by rolname",
      [
        [
          APP_ROLE,
          IDENTITY_APP_ROLE,
          PROFILE_PROVISIONER_ROLE,
          PROFILE_READER_ROLE,
          PLATFORM_PROVISIONER_ROLE,
          PLATFORM_READER_ROLE,
        ],
      ],
    );
    const existingRoles = new Set(roles.rows.map(({ rolname }) => rolname));
    const missingRoles = [
      APP_ROLE,
      IDENTITY_APP_ROLE,
      PROFILE_PROVISIONER_ROLE,
      PROFILE_READER_ROLE,
      PLATFORM_PROVISIONER_ROLE,
      PLATFORM_READER_ROLE,
    ].filter((role) => !existingRoles.has(role));
    if (missingRoles.length > 0) {
      throw new MigrationError(
        `Papéis inexistentes (${missingRoles.join(", ")}): rode o bootstrap antes das migrations.`,
      );
    }

    await client.query(`create schema if not exists ${SCHEMA}`);
    await client.query(
      `create table if not exists ${SCHEMA}.schema_migrations (
         version    text primary key,
         checksum   text not null,
         applied_at timestamptz not null default clock_timestamp()
       )`,
    );
    await client.query(`revoke all on ${SCHEMA}.schema_migrations from public`);

    const ledger = await client.query<{ version: string; checksum: string }>(
      `select version, checksum from ${SCHEMA}.schema_migrations order by version`,
    );
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of ledger.rows) {
      const migration = known.get(row.version);
      if (!migration) {
        throw new MigrationError(
          `Migration aplicada sem arquivo correspondente: ${row.version}`,
        );
      }
      if (migration.checksum !== row.checksum) {
        throw new MigrationError(
          `Checksum divergente em ${row.version}: o arquivo foi alterado após aplicado.`,
        );
      }
    }

    const done = new Set(ledger.rows.map((row) => row.version));
    const result: MigrationResult = { applied: [], alreadyApplied: [...done] };
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      try {
        await client.query("begin");
        await client.query(migration.sql);
        await client.query(
          `insert into ${SCHEMA}.schema_migrations (version, checksum) values ($1, $2)`,
          [migration.version, migration.checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new MigrationError(
          `Falha ao aplicar ${migration.version}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      result.applied.push(migration.version);
    }
    return result;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY.toString()])
      .catch(() => {});
    await client.end();
  }
}
