import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { expect, inject, it } from "vitest";

import { loadMigrations, runMigrations } from "../../src/migrate.js";

const urls = inject("dbUrls");

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

it("mantém o estado parcial até 0063 completamente fechado", async () => {
  const database = `renave_partial_${randomBytes(6).toString("hex")}`;
  const migrationDir = await mkdtemp(join(tmpdir(), "renave-partial-"));
  const control = new Client({ connectionString: urls.admin });
  let controlConnected = false;
  let partialAdmin: Client | undefined;
  let partialMigrator: Client | undefined;
  let partialReader: Client | undefined;
  let partialProvisioner: Client | undefined;
  try {
    await control.connect();
    controlConnected = true;
    await control.query(`create database ${database} template template0`);
    const adminUrl = withDatabase(urls.admin, database);
    const migratorUrl = withDatabase(urls.migrator, database);
    const readerUrl = withDatabase(urls.platformReader, database);
    const provisionerUrl = withDatabase(urls.platformProvisioner, database);
    partialAdmin = new Client({ connectionString: adminUrl });
    await partialAdmin.connect();
    await partialAdmin.query(`revoke all on database ${database} from public`);
    await partialAdmin.query(
      `grant connect,create on database ${database} to renave_migrator`,
    );
    await partialAdmin.query(
      `grant connect on database ${database}
       to renave_platform_reader,renave_platform_provisioner`,
    );

    const migrations = (await loadMigrations()).slice(0, 63);
    for (const migration of migrations) {
      await writeFile(
        join(migrationDir, `${migration.version}.sql`),
        migration.sql,
        "utf8",
      );
    }
    await runMigrations(migratorUrl, { dir: migrationDir });

    partialMigrator = new Client({ connectionString: migratorUrl });
    partialReader = new Client({ connectionString: readerUrl });
    partialProvisioner = new Client({ connectionString: provisionerUrl });
    await Promise.all([
      partialMigrator.connect(),
      partialReader.connect(),
      partialProvisioner.connect(),
    ]);
    await expect(
      partialMigrator.query("select renave_platform.contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: false }] });
    const privileges = await partialAdmin.query<{
      provisioner_execute: boolean;
      provisioner_usage: boolean;
      reader_execute: boolean;
      reader_usage: boolean;
    }>(
      `select
        has_schema_privilege('renave_platform_reader','renave_platform','USAGE')
          reader_usage,
        has_schema_privilege('renave_platform_provisioner','renave_platform','USAGE')
          provisioner_usage,
        has_function_privilege('renave_platform_reader',
          'renave_platform.list_credential_link_queue(bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)',
          'EXECUTE') reader_execute,
        has_function_privilege('renave_platform_provisioner',
          'renave_platform.grant_operator(bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)',
          'EXECUTE') provisioner_execute`,
    );
    expect(privileges.rows[0]).toEqual({
      provisioner_execute: false,
      provisioner_usage: false,
      reader_execute: false,
      reader_usage: false,
    });
    await expect(
      partialReader.query(
        `select * from renave_platform.list_credential_link_queue(
          decode(repeat('00',32),'hex'),decode(repeat('01',32),'hex'),
          '127.0.0.1',decode(repeat('02',32),'hex'),
          null,null,null,null,100)`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      partialProvisioner.query(
        `select renave_platform.grant_operator(
          decode(repeat('00',32),'hex'),clock_timestamp(),
          clock_timestamp()+interval '1 hour',decode(repeat('01',32),'hex'),
          decode(repeat('02',32),'hex'),'127.0.0.1',
          decode(repeat('03',32),'hex'))`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await Promise.all([
      partialMigrator?.end(),
      partialReader?.end(),
      partialProvisioner?.end(),
      partialAdmin?.end(),
    ]);
    if (controlConnected) {
      await control.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [database],
      );
      await control.query(`drop database if exists ${database}`);
      await control.end();
    }
    await rm(migrationDir, { force: true, recursive: true });
  }
});
