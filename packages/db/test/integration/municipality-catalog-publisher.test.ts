import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, inject, it } from "vitest";

import {
  MunicipalityCatalogPublicationRejectedError,
  publishMunicipalityCatalogSnapshotFiles,
  publishVerifiedMunicipalityCatalog,
} from "../../src/municipality-catalog-publisher.js";
import {
  municipalityCatalogSnapshotContract,
  type VerifiedMunicipalityCatalogSnapshot,
  verifyMunicipalityCatalogSnapshot,
} from "../../src/municipality-catalog-publication.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
let admin: Pool;
let migratorA: Pool;
let migratorB: Pool;
const publishedVersions = new Set<string>();

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(
  seed: string,
  observedAt: Date,
): VerifiedMunicipalityCatalogSnapshot {
  return snapshotBundle(seed, observedAt).verified;
}

function snapshotBundle(
  seed: string,
  observedAt: Date,
): {
  manifestBytes: Buffer;
  sourceBytes: Buffer;
  verified: VerifiedMunicipalityCatalogSnapshot;
} {
  const rows = Array.from({ length: 4_996 }, (_, index) => ({
    id: String(1_000_000 + index),
    nome: `Município ${seed} ${String(index)}`,
    uf: "SP",
  }));
  rows.push(
    { id: "1501402", nome: "Belém", uf: "PA" },
    { id: "2611533", nome: "Quixaba", uf: "PE" },
    { id: "5101837", nome: "Boa Esperança do Norte", uf: "MT" },
    { id: "3303807", nome: "Paraty", uf: "RJ" },
  );
  const sourceBytes = Buffer.from(JSON.stringify(rows), "utf8");
  const codes = rows
    .map(({ id }) => Number(id))
    .toSorted((left, right) => left - right);
  const artifact = Buffer.from(
    codes.map((code) => `${String(code)}\n`).join(""),
    "utf8",
  );
  const sourceSha256 = sha256(sourceBytes);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      source: {
        kind: "RENAVE_MUNICIPIOS",
        environment: "homologation",
        url: municipalityCatalogSnapshotContract.sourceUrl,
        observedAt: observedAt.toISOString(),
        sha256: sourceSha256,
      },
      artifact: {
        format: municipalityCatalogSnapshotContract.artifactFormat,
        rowCount: rows.length,
        sha256: sha256(artifact),
      },
      release: { version: `renave-municipios-v1-${sourceSha256}` },
      provenance: {
        approvalReference: `IT-${seed}`,
        captureToolDigest: "a".repeat(64),
      },
    }),
    "utf8",
  );
  const verified = verifyMunicipalityCatalogSnapshot({
    expectedManifestSha256: sha256(manifestBytes),
    manifestBytes,
    sourceBytes,
  });
  publishedVersions.add(verified.version);
  return { manifestBytes, sourceBytes, verified };
}

function policy(now = new Date()): { maximumAgeMs: number; now: Date } {
  return { maximumAgeMs: 60 * 60 * 1_000, now };
}

beforeAll(() => {
  admin = createPool(urls.admin, { max: 1 });
  migratorA = createPool(urls.migrator, { max: 1 });
  migratorB = createPool(urls.migrator, { max: 1 });
});

afterEach(async () => {
  if (publishedVersions.size === 0) return;
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const versions = [...publishedVersions];
    await client.query(
      `delete from renave_reference.municipality_catalog_entry
        where release_version = any($1::text[])`,
      [versions],
    );
    await client.query(
      `delete from renave_reference.municipality_catalog_release
        where version = any($1::text[])`,
      [versions],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    publishedVersions.clear();
  }
});

afterAll(async () => {
  await Promise.all([admin.end(), migratorA.end(), migratorB.end()]);
});

it("publica uma vez e trata concorrência idêntica como replay", async () => {
  const value = snapshot("igual", new Date(Date.now() - 60_000));
  const results = await Promise.all([
    publishVerifiedMunicipalityCatalog(migratorA, value, policy()),
    publishVerifiedMunicipalityCatalog(migratorB, value, policy()),
  ]);
  expect(results.map(({ outcome }) => outcome).sort()).toEqual([
    "already_active",
    "published",
  ]);

  const persisted = await admin.query(
    `select release.version,
            pg_catalog.encode(release.source_sha256, 'hex') source_sha256,
            pg_catalog.encode(release.artifact_sha256, 'hex') artifact_sha256,
            release.row_count,
            renave_reference.municipality_release_integrity(
              release.version, release.row_count, release.artifact_sha256
            ) integrity
       from renave_reference.active_municipality_catalog_release release`,
  );
  expect(persisted.rows).toEqual([
    {
      artifact_sha256: value.artifactSha256,
      integrity: true,
      row_count: value.rowCount,
      source_sha256: value.sourceSha256,
      version: value.version,
    },
  ]);
});

it("revalida arquivos e a âncora independente antes de abrir publicação", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renave-publisher-it-"));
  try {
    const fixture = snapshotBundle("arquivos", new Date(Date.now() - 60_000));
    const manifestPath = join(directory, "manifest.json");
    const sourcePath = join(directory, "source.json");
    await writeFile(manifestPath, fixture.manifestBytes);
    await writeFile(sourcePath, fixture.sourceBytes);

    await expect(
      publishMunicipalityCatalogSnapshotFiles({
        expectedManifestSha256: "0".repeat(64),
        manifestPath,
        maximumAgeMs: 60 * 60 * 1_000,
        now: new Date(),
        pool: migratorA,
        sourcePath,
      }),
    ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
    await expect(
      publishMunicipalityCatalogSnapshotFiles({
        expectedManifestSha256: sha256(fixture.manifestBytes),
        manifestPath,
        maximumAgeMs: 60 * 60 * 1_000,
        now: new Date(),
        pool: migratorA,
        sourcePath,
      }),
    ).resolves.toMatchObject({ outcome: "published" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("recusa replay cuja origem persistida não é a URL canônica", async () => {
  const value = snapshot("origem-divergente", new Date(Date.now() - 60_000));
  await migratorA.query(
    `select renave_reference.publish_municipality_catalog(
       $1, 'RENAVE_MUNICIPIOS', 'https://example.invalid/municipios',
       $2::timestamptz, pg_catalog.decode($3, 'hex'),
       pg_catalog.decode($4, 'hex'), $5, $6::integer[]
     )`,
    [
      value.version,
      value.observedAt,
      value.sourceSha256,
      value.artifactSha256,
      value.rowCount,
      value.codes,
    ],
  );

  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, value, policy()),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
});

it("serializa snapshots diferentes e nunca deixa o mais antigo ativo", async () => {
  const base = Date.now() - 120_000;
  const older = snapshot("antigo", new Date(base));
  const newer = snapshot("novo", new Date(base + 1_000));
  const results = await Promise.allSettled([
    publishVerifiedMunicipalityCatalog(migratorA, older, policy()),
    publishVerifiedMunicipalityCatalog(migratorB, newer, policy()),
  ]);
  expect(results.some(({ status }) => status === "fulfilled")).toBe(true);
  const active = await admin.query<{ version: string }>(
    "select version from renave_reference.active_municipality_catalog_release",
  );
  expect(active.rows).toEqual([{ version: newer.version }]);
  for (const result of results) {
    if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(
        MunicipalityCatalogPublicationRejectedError,
      );
    }
  }
});

it("faz rollback integral, recusa regressão, relógio futuro e papel indireto", async () => {
  const now = new Date();
  const current = snapshot("corrente", new Date(now.getTime() - 60_000));
  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, current, policy(now)),
  ).resolves.toMatchObject({ outcome: "published" });
  await expect(
    publishVerifiedMunicipalityCatalog(
      migratorA,
      Object.freeze({ ...current, rowCount: current.rowCount - 1 }),
      policy(now),
    ),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);

  const successor = snapshot("sucessor", new Date(now.getTime() - 30_000));
  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, successor, policy(now)),
  ).resolves.toMatchObject({ outcome: "published" });
  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, current, policy(now)),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);

  const older = snapshot("regressao", new Date(now.getTime() - 120_000));
  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, older, policy(now)),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);

  const future = snapshot("futuro", new Date(now.getTime() + 60_000));
  await expect(
    publishVerifiedMunicipalityCatalog(
      migratorA,
      future,
      policy(new Date(now.getTime() + 120_000)),
    ),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);

  const forged = Object.freeze({
    ...snapshot("rollback", new Date(now.getTime() - 30_000)),
    artifactSha256: "0".repeat(64),
  });
  await expect(
    publishVerifiedMunicipalityCatalog(migratorA, forged, policy(now)),
  ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
  const rolledBack = await admin.query<{ count: string }>(
    `select count(*)::text count
       from renave_reference.municipality_catalog_entry
      where release_version = $1`,
    [forged.version],
  );
  expect(rolledBack.rows).toEqual([{ count: "0" }]);

  const app = createPool(urls.app, { max: 1 });
  try {
    await expect(
      publishVerifiedMunicipalityCatalog(app, older, policy(now)),
    ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
  } finally {
    await app.end();
  }

  const indirectPool = createPool(urls.admin, { max: 1 });
  try {
    const indirectClient = await indirectPool.connect();
    await indirectClient.query("set role renave_migrator");
    await expect(
      publishVerifiedMunicipalityCatalog(
        { connect: async () => indirectClient } as never,
        older,
        policy(now),
      ),
    ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
  } finally {
    await indirectPool.end();
  }
});
