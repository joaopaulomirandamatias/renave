import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, inject, it } from "vitest";

import {
  PostgresStockExitMunicipalityCatalog,
  StockExitMunicipalityCatalogUnavailableError,
} from "../../src/api-runtime.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const admin = createPool(urls.admin);
const app = createPool(urls.app);
const catalog = new PostgresStockExitMunicipalityCatalog();
const OFFICIAL =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/municipios";
const SENTINELS = [1_501_402, 2_611_533, 5_101_837, 3_303_807];
let writer: PoolClient;

function codes(extra = 0): number[] {
  return [
    ...Array.from({ length: 4_996 }, (_, index) => 1_000_000 + index + extra),
    ...SENTINELS,
  ];
}

function digest(values: number[]): Buffer {
  return createHash("sha256")
    .update(
      values
        .toSorted((a, b) => a - b)
        .map((code) => `${String(code)}\n`)
        .join(""),
    )
    .digest();
}

async function publish(input: {
  codes?: number[];
  observedAt?: Date;
  sourceUrl?: string;
  version: string;
}) {
  const values = input.codes ?? codes();
  await writer.query(
    `select renave_reference.publish_municipality_catalog(
       $1,'RENAVE_MUNICIPIOS',$2,$3,$4,$5,$6,$7::integer[])`,
    [
      input.version,
      input.sourceUrl ?? OFFICIAL,
      input.observedAt ?? new Date(),
      createHash("sha256").update(input.version).digest(),
      digest(values),
      values.length,
      values,
    ],
  );
}

beforeEach(async () => {
  writer = await admin.connect();
  await writer.query("begin");
  await writer.query("set local role renave_migrator");
});

afterEach(async () => {
  await writer.query("rollback").catch(() => undefined);
  writer.release();
});

afterAll(async () => Promise.all([admin.end(), app.end()]));

it("falha fechado sem release e aceita somente o catálogo oficial vigente", async () => {
  await expect(catalog.contains(writer, SENTINELS[0]!)).rejects.toBeInstanceOf(
    StockExitMunicipalityCatalogUnavailableError,
  );
  await publish({ version: "vigente" });
  await writer.query("set local role renave_app");
  await expect(catalog.contains(writer, SENTINELS[0]!)).resolves.toBe(true);
  await expect(catalog.contains(writer, 9_999_999)).resolves.toBe(false);
  await expect(
    writer.query(
      "select renave_stock_exit_barriers.municipality_catalog_ready() ready",
    ),
  ).resolves.toMatchObject({ rows: [{ ready: true }] });
  await expect(
    writer.query("select renave_runtime.api_contract_ready() ready"),
  ).resolves.toMatchObject({ rows: [{ ready: true }] });
});

it("recusa URL, idade, futuro, contagem e sentinela divergentes", async () => {
  const invalid = [
    { sourceUrl: `${OFFICIAL}?uf=PA`, version: "url" },
    {
      observedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1),
      version: "expired",
    },
    { observedAt: new Date(Date.now() + 60 * 60 * 1_000), version: "future" },
    { codes: codes().slice(0, -1), version: "missing-sentinel" },
    { codes: codes().slice(0, 4_995), version: "too-small" },
    {
      codes: [
        ...codes(),
        ...Array.from({ length: 5_001 }, (_, index) => 7_000_000 + index),
      ],
      version: "too-large",
    },
  ];
  for (const fixture of invalid) {
    await writer.query("savepoint fixture");
    await publish(fixture);
    await expect(
      catalog.contains(writer, SENTINELS[0]!),
    ).rejects.toBeInstanceOf(StockExitMunicipalityCatalogUnavailableError);
    await writer.query("rollback to savepoint fixture");
  }
});

it("aceita a borda interna de 24 horas sem depender do relógio da aplicação", async () => {
  await publish({
    observedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 + 2_000),
    version: "edge-inside",
  });
  await expect(catalog.contains(writer, SENTINELS[0]!)).resolves.toBe(true);
});

it("não cai para histórico válido quando a release ativa é inválida", async () => {
  await publish({ version: "historico-valido" });
  await publish({
    sourceUrl: "https://invalid.example/municipios",
    version: "ativo-invalido",
  });
  await expect(catalog.contains(writer, SENTINELS[0]!)).rejects.toBeInstanceOf(
    StockExitMunicipalityCatalogUnavailableError,
  );
});

it("detecta corrupção e drift de contrato", async () => {
  await publish({ version: "corromper" });
  await writer.query("set constraints all immediate");
  await writer.query(
    "alter table renave_reference.municipality_catalog_entry disable trigger immutable_entries",
  );
  await writer.query(
    "delete from renave_reference.municipality_catalog_entry where release_version='corromper' and code=$1",
    [SENTINELS[0]],
  );
  await expect(catalog.contains(writer, SENTINELS[1]!)).rejects.toBeInstanceOf(
    StockExitMunicipalityCatalogUnavailableError,
  );
  await writer.query("rollback");
  await writer.query("begin");
  await writer.query("set local role renave_migrator");
  for (const drift of [
    "grant select on renave_stock_exit_barriers.rate_bucket to renave_app",
    "alter table renave_stock_exit_barriers.rate_bucket drop constraint stock_exit_rate_bucket_key",
    "alter table renave_reference.municipality_catalog_entry disable trigger immutable_entries",
    "update renave.schema_migrations set checksum=repeat('0',64) where version='0082_stock_exit_runtime_barriers'",
  ]) {
    await writer.query("savepoint drift");
    await writer.query(drift);
    await expect(
      writer.query("select renave_runtime.api_contract_ready() ready"),
    ).resolves.toMatchObject({ rows: [{ ready: false }] });
    await writer.query("rollback to savepoint drift");
  }
});

it("expõe apenas readiness, lookup vigente e consumo à aplicação", async () => {
  for (const role of [
    "renave_app",
    "renave_operation_worker",
    "renave_operation_promoter",
    "renave_identity_app",
    "renave_maintenance_app",
  ]) {
    const { rows } = await writer.query(
      `select
        has_function_privilege($1,
          'renave_stock_exit_barriers.lookup_municipality(integer)','EXECUTE') lookup,
        has_function_privilege($1,
          'renave_stock_exit_barriers.municipality_catalog_ready()','EXECUTE') readiness,
        has_function_privilege($1,
          'renave_stock_exit_barriers.consume_rate_limit(bytea,bytea)','EXECUTE') consume,
        has_table_privilege($1,
          'renave_stock_exit_barriers.rate_bucket','SELECT,INSERT,UPDATE,DELETE') table_access`,
      [role],
    );
    expect(rows).toEqual([
      {
        consume: role === "renave_app",
        lookup: role === "renave_app",
        readiness: role === "renave_app",
        table_access: false,
      },
    ]);
  }
  const catalogAcl = await writer.query(
    `select
       has_table_privilege('renave_app',
         'renave_reference.municipality_catalog_entry','SELECT') entry_select,
       has_table_privilege('renave_app',
         'renave_reference.municipality_catalog_release','SELECT') release_select`,
  );
  expect(catalogAcl.rows).toEqual([
    { entry_select: false, release_select: false },
  ]);
});
