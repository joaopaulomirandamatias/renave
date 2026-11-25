import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeEach, afterEach, expect, inject, it } from "vitest";

import {
  PostgresStockExitMunicipalityCatalog,
  StockExitMunicipalityCatalogUnavailableError,
} from "../../src/api-runtime.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const admin = createPool(urls.admin);
const app = createPool(urls.app);
const catalog = new PostgresStockExitMunicipalityCatalog();
const belém = 1501402;
const quixaba = 2611533;
let writer: PoolClient;

beforeEach(async () => {
  writer = await admin.connect();
  await writer.query("begin");
  await writer.query("set local role renave_migrator");
});

afterEach(async () => {
  try {
    await writer.query("rollback");
  } finally {
    writer.release();
  }
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const publishSql = `select renave_reference.publish_municipality_catalog(
    $1,'RENAVE_MUNICIPIOS','https://fixture.invalid/municipios',
    '2026-01-01T00:00:00Z', $2, $3, $4, $5::integer[])`;

function publish(
  version: string,
  codes: number[],
  rowCount = codes.length,
  digest = createHash("sha256")
    .update(
      codes
        .toSorted((a, b) => a - b)
        .map((code) => code + "\n")
        .join(""),
    )
    .digest(),
) {
  return writer.query(publishSql, [
    version,
    createHash("sha256").update("fixture").digest(),
    digest,
    rowCount,
    codes,
  ]);
}

async function rejectAndRecover(work: () => Promise<unknown>, code: string) {
  await writer.query("savepoint rejected");
  await expect(work()).rejects.toMatchObject({ code });
  await writer.query("rollback to savepoint rejected");
}

it("inicia sem release e mantém o contrato da API pronto", async () => {
  const reader = await app.connect();
  try {
    await expect(
      reader.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
    await expect(catalog.contains(reader, belém)).rejects.toBeInstanceOf(
      StockExitMunicipalityCatalogUnavailableError,
    );
  } finally {
    reader.release();
  }
});

it("publica releases inteiras, preserva o histórico e consulta com e sem tenant", async () => {
  await publish("teste-1", [quixaba, belém]);
  await writer.query("set local role renave_app");
  await expect(catalog.contains(writer, belém)).resolves.toBe(true);
  await writer.query(
    "select set_config('renave.tenant_id', gen_random_uuid()::text, true)",
  );
  await expect(catalog.contains(writer, quixaba)).resolves.toBe(true);
  await expect(catalog.contains(writer, 123)).resolves.toBe(false);
  await writer.query("set local role renave_migrator");

  await rejectAndRecover(() => publish("vazia", []), "23514");
  await rejectAndRecover(() => publish("contagem", [belém], 2), "23514");
  await rejectAndRecover(
    () => publish("hash", [belém], 1, Buffer.alloc(32)),
    "23514",
  );
  await rejectAndRecover(() => publish("duplicada", [belém, belém]), "23505");
  await rejectAndRecover(() => publish("invalida", [0]), "23514");
  await rejectAndRecover(() => publish("teste-1", [10]), "55000");
  await rejectAndRecover(
    () =>
      writer.query("delete from renave_reference.municipality_catalog_release"),
    "55000",
  );
  await writer.query("set constraints all immediate");
  await rejectAndRecover(
    () => writer.query("truncate renave_reference.municipality_catalog_entry"),
    "55000",
  );
  await rejectAndRecover(
    () =>
      writer.query(
        "update renave_reference.municipality_catalog_entry set code=1",
      ),
    "55000",
  );

  await writer.query("set constraints all deferred");
  const reader = await app.connect();
  try {
    await expect(catalog.contains(reader, belém)).rejects.toBeInstanceOf(
      StockExitMunicipalityCatalogUnavailableError,
    );
    await publish("teste-2", [quixaba]);
    await expect(
      writer.query(
        "select version from renave_reference.active_municipality_catalog_release",
      ),
    ).resolves.toMatchObject({ rows: [{ version: "teste-2" }] });
    await expect(
      writer.query(
        "select count(*)::integer as n from renave_reference.municipality_catalog_entry where release_version='teste-1'",
      ),
    ).resolves.toMatchObject({ rows: [{ n: 2 }] });
    await expect(catalog.contains(writer, belém)).resolves.toBe(false);
    await expect(catalog.contains(writer, quixaba)).resolves.toBe(true);
  } finally {
    reader.release();
  }
});

it("fecha a consulta em caso de alteração na contagem ou no conteúdo", async () => {
  await publish("teste", [belém, quixaba]);
  await writer.query("set constraints all immediate");
  await writer.query(
    "alter table renave_reference.municipality_catalog_entry disable trigger immutable_entries",
  );
  await writer.query(
    "update renave_reference.municipality_catalog_entry set code=1 where code=$1",
    [quixaba],
  );
  await expect(catalog.contains(writer, belém)).rejects.toBeInstanceOf(
    StockExitMunicipalityCatalogUnavailableError,
  );
  await writer.query(
    "delete from renave_reference.municipality_catalog_entry where code=1",
  );
  await expect(catalog.contains(writer, belém)).rejects.toBeInstanceOf(
    StockExitMunicipalityCatalogUnavailableError,
  );
});

it("nega acesso direto e publicação a todos os papéis de serviço; só a API consulta", async () => {
  for (const role of [
    "renave_app",
    "renave_operation_worker",
    "renave_operation_promoter",
    "renave_identity_app",
    "renave_platform_reader",
    "renave_platform_provisioner",
    "renave_maintenance_app",
    "renave_profile_reader",
    "renave_profile_provisioner",
    "renave_credential_scope_provisioner",
  ]) {
    const { rows } = await writer.query(
      `select
        has_schema_privilege($1,'renave_reference','USAGE') as schema_usage,
        has_schema_privilege($1,'renave_reference','CREATE') as schema_create,
        has_function_privilege($1,'renave_reference.lookup_municipality(int)','EXECUTE') as lookup,
        exists(select 1 from pg_proc p where p.pronamespace='renave_reference'::regnamespace
          and p.proname <> 'lookup_municipality' and has_function_privilege($1,p.oid,'EXECUTE')) as other_function,
        exists(select 1 from pg_class c where c.relnamespace='renave_reference'::regnamespace
          and c.relkind in ('r','v') and has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as table_access`,
      [role],
    );
    expect(rows).toEqual([
      {
        schema_usage: role === "renave_app",
        schema_create: false,
        lookup: role === "renave_app",
        other_function: false,
        table_access: false,
      },
    ]);
  }
});

it("detecta drift de ACL, trigger e checksum sem depender de release ativa", async () => {
  for (const drift of [
    "grant select on renave_reference.municipality_catalog_entry to renave_app",
    "alter table renave_reference.municipality_catalog_release disable trigger validate_release",
    "update renave.schema_migrations set checksum=repeat('0',64) where version='0080_municipality_catalog'",
  ]) {
    await writer.query("savepoint drift");
    await writer.query(drift);
    await expect(
      writer.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: false }] });
    await writer.query("rollback to savepoint drift");
  }
});

it("troca a versão para outra conexão somente no commit da publicação", async () => {
  const reader = await app.connect();
  try {
    await publish("visivel-1", [belém]);
    await writer.query("commit");
    await writer.query("begin");
    await writer.query("set local role renave_migrator");
    await publish("visivel-2", [quixaba]);
    await expect(catalog.contains(reader, belém)).resolves.toBe(true);
    await expect(catalog.contains(reader, quixaba)).resolves.toBe(false);
    await writer.query("commit");
    await expect(catalog.contains(reader, belém)).resolves.toBe(false);
    await expect(catalog.contains(reader, quixaba)).resolves.toBe(true);
  } finally {
    reader.release();
    await writer.query("rollback");
    await writer.query("begin");
    // Desfaz somente as duas fixtures que o leitor precisou ver após commit.
    await writer.query("set local session_replication_role = replica");
    await writer.query(
      "delete from renave_reference.municipality_catalog_entry where release_version in ('visivel-1', 'visivel-2')",
    );
    await writer.query(
      "delete from renave_reference.municipality_catalog_release where version in ('visivel-1', 'visivel-2')",
    );
    await writer.query("commit");
  }
});
