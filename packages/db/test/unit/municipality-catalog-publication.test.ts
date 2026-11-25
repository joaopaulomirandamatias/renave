import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runMunicipalityCatalogCli } from "../../src/municipality-catalog-cli.js";
import {
  MunicipalityCatalogSnapshotInvalidError,
  municipalityCatalogSnapshotContract,
  verifyMunicipalityCatalogSnapshot,
  verifyMunicipalityCatalogSnapshotFiles,
} from "../../src/municipality-catalog-publication.js";

interface MunicipalityFixture {
  id: string;
  nome: string;
  uf: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function municipalities(): MunicipalityFixture[] {
  const rows = Array.from({ length: 4_996 }, (_, index) => ({
    id: String(1_000_000 + index),
    nome: `Município ${String(index)}`,
    uf: "SP",
  }));
  rows.push(
    { id: "1501402", nome: "Belém", uf: "PA" },
    { id: "2611533", nome: "Quixaba", uf: "PE" },
    { id: "5101837", nome: "Boa Esperança do Norte", uf: "MT" },
    { id: "3303807", nome: "Paraty", uf: "RJ" },
  );
  return rows.reverse();
}

function snapshot(rows = municipalities()) {
  const sourceBytes = Buffer.from(JSON.stringify(rows), "utf8");
  const codes = rows
    .map(({ id }) => Number(id))
    .toSorted((left, right) => left - right);
  const artifact = Buffer.from(
    codes.map((code) => `${String(code)}\n`).join(""),
    "utf8",
  );
  const sourceSha256 = sha256(sourceBytes);
  const manifest = {
    schemaVersion: 1,
    source: {
      kind: "RENAVE_MUNICIPIOS",
      environment: "homologation",
      url: municipalityCatalogSnapshotContract.sourceUrl,
      observedAt: "2026-11-24T22:00:00.000Z",
      sha256: sourceSha256,
    },
    artifact: {
      format: municipalityCatalogSnapshotContract.artifactFormat,
      rowCount: rows.length,
      sha256: sha256(artifact),
    },
    release: { version: `renave-municipios-v1-${sourceSha256}` },
    provenance: {
      captureToolDigest: "a".repeat(64),
      approvalReference: "CHG-2026-001",
    },
  };
  return {
    artifact,
    manifest,
    manifestBytes: Buffer.from(JSON.stringify(manifest), "utf8"),
    sourceBytes,
  };
}

function verifyFixture(rows = municipalities()) {
  const fixture = snapshot(rows);
  return verifyMunicipalityCatalogSnapshot({
    expectedManifestSha256: sha256(fixture.manifestBytes),
    manifestBytes: fixture.manifestBytes,
    sourceBytes: fixture.sourceBytes,
  });
}

describe("snapshot municipal RENAVE offline", () => {
  it("deriva o artefato determinístico, aceita Quixaba e retorna metadados sanitizados", () => {
    const fixture = snapshot();
    const verified = verifyMunicipalityCatalogSnapshot({
      expectedManifestSha256: sha256(fixture.manifestBytes),
      manifestBytes: fixture.manifestBytes,
      sourceBytes: fixture.sourceBytes,
    });

    expect(verified.rowCount).toBe(5_000);
    expect(verified.codes).toHaveLength(5_000);
    expect(verified.codes).toContain(2_611_533);
    expect(fixture.artifact.at(-1)).toBe(10);
    expect(verified.artifactSha256).toBe(sha256(fixture.artifact));
    expect(verified.version).toBe(
      `renave-municipios-v1-${verified.sourceSha256}`,
    );
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.codes)).toBe(true);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() =>
        verifyMunicipalityCatalogSnapshot({
          expectedManifestSha256: "0".repeat(64),
          manifestBytes: fixture.manifestBytes,
          sourceBytes: fixture.sourceBytes,
        }),
      ).toThrow(MunicipalityCatalogSnapshotInvalidError);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("não analisa a fonte antes de autenticar seus bytes", () => {
    const fixture = snapshot();
    const manifest = structuredClone(fixture.manifest);
    manifest.source.sha256 = "e".repeat(64);
    manifest.release.version = `renave-municipios-v1-${manifest.source.sha256}`;
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const parse = vi.spyOn(JSON, "parse");

    try {
      expect(() =>
        verifyMunicipalityCatalogSnapshot({
          expectedManifestSha256: sha256(manifestBytes),
          manifestBytes,
          sourceBytes: fixture.sourceBytes,
        }),
      ).toThrow(MunicipalityCatalogSnapshotInvalidError);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it("recusa manifest fora do contrato exato ou sem proveniência verificável", () => {
    const mutations: Array<
      (manifest: ReturnType<typeof snapshot>["manifest"]) => void
    > = [
      (manifest) => void Object.assign(manifest, { extra: true }),
      (manifest) => (manifest.schemaVersion = 2),
      (manifest) => (manifest.source.environment = "production"),
      (manifest) => (manifest.source.url += "?uf=PA"),
      (manifest) => (manifest.source.observedAt = "2026-11-24T22:00:00Z"),
      (manifest) => (manifest.source.sha256 = "0".repeat(64)),
      (manifest) => (manifest.artifact.sha256 = "0".repeat(64)),
      (manifest) => (manifest.artifact.rowCount = 4_999),
      (manifest) => (manifest.release.version = "manual"),
      (manifest) => (manifest.provenance.captureToolDigest = "invalido"),
      (manifest) => (manifest.provenance.approvalReference = " ticket "),
      (manifest) => (manifest.provenance.approvalReference = "ticket\u202e"),
    ];
    for (const mutate of mutations) {
      const fixture = snapshot();
      const manifest = structuredClone(fixture.manifest);
      mutate(manifest);
      expect(() =>
        verifyMunicipalityCatalogSnapshot({
          expectedManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
          manifestBytes: Buffer.from(JSON.stringify(manifest)),
          sourceBytes: fixture.sourceBytes,
        }),
      ).toThrow(MunicipalityCatalogSnapshotInvalidError);
    }
  });

  it("recusa catálogo filtrado, duplicado ou com município incompatível", () => {
    const cases: MunicipalityFixture[][] = [];

    const extra = municipalities();
    (extra[0] as MunicipalityFixture & { extra?: boolean }).extra = true;
    cases.push(extra);

    const nonCanonical = municipalities();
    nonCanonical[0]!.id = "01000000";
    cases.push(nonCanonical);

    const duplicate = municipalities();
    duplicate[0]!.id = duplicate[1]!.id;
    cases.push(duplicate);

    const hiddenName = municipalities();
    hiddenName[0]!.nome = "Município\u200b";
    cases.push(hiddenName);

    const invalidUf = municipalities();
    invalidUf[0]!.uf = "XX";
    cases.push(invalidUf);

    const missingSentinel = municipalities();
    missingSentinel.find(({ id }) => id === "2611533")!.id = "6999999";
    cases.push(missingSentinel);

    const truncated = municipalities().slice(1);
    cases.push(truncated);

    for (const rows of cases) {
      expect(() => verifyFixture(rows)).toThrow(
        MunicipalityCatalogSnapshotInvalidError,
      );
    }
  });

  it("recusa bytes vazios, excessivos, com BOM ou UTF-8 inválido", () => {
    const fixture = snapshot();
    for (const [manifestBytes, sourceBytes] of [
      [Buffer.alloc(0), fixture.sourceBytes],
      [Buffer.alloc(16 * 1024 + 1), fixture.sourceBytes],
      [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.manifestBytes]),
        fixture.sourceBytes,
      ],
      [Buffer.from([0xc3, 0x28]), fixture.sourceBytes],
      [fixture.manifestBytes, Buffer.alloc(10 * 1024 * 1024 + 1)],
      [
        fixture.manifestBytes,
        Buffer.concat([fixture.sourceBytes, Buffer.from(" ")]),
      ],
      [
        fixture.manifestBytes,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.sourceBytes]),
      ],
    ] as const) {
      expect(() =>
        verifyMunicipalityCatalogSnapshot({
          expectedManifestSha256: sha256(manifestBytes),
          manifestBytes,
          sourceBytes,
        }),
      ).toThrow(MunicipalityCatalogSnapshotInvalidError);
    }
  });

  it("lê somente arquivos explícitos e mantém a CLI sem rede ou PostgreSQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renave-municipios-"));
    temporaryDirectories.push(directory);
    const fixture = snapshot();
    const manifestPath = join(directory, "manifest.json");
    const sourcePath = join(directory, "source.json");
    await writeFile(manifestPath, fixture.manifestBytes);
    await writeFile(sourcePath, fixture.sourceBytes);

    await expect(
      verifyMunicipalityCatalogSnapshotFiles({
        expectedManifestSha256: sha256(fixture.manifestBytes),
        manifestPath,
        sourcePath,
      }),
    ).resolves.toMatchObject({ rowCount: 5_000 });

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await runMunicipalityCatalogCli([
        "verify",
        "--manifest",
        manifestPath,
        "--source",
        sourcePath,
        "--expected-manifest-sha256",
        sha256(fixture.manifestBytes),
      ]);
      const output = String(write.mock.calls[0]?.[0] ?? "");
      expect(JSON.parse(output)).toMatchObject({
        mode: "verify",
        rowCount: 5_000,
      });
      expect(output).not.toContain(manifestPath);
      expect(output).not.toContain(sourcePath);
    } finally {
      write.mockRestore();
    }
    await expect(
      verifyMunicipalityCatalogSnapshotFiles({
        expectedManifestSha256: sha256(fixture.manifestBytes),
        manifestPath: join(directory, "ausente.json"),
        sourcePath,
      }),
    ).rejects.toEqual(new MunicipalityCatalogSnapshotInvalidError());

    const cliSource = await readFile(
      fileURLToPath(
        new URL("../../src/municipality-catalog-cli.ts", import.meta.url),
      ),
      "utf8",
    );
    const verifierSource = await readFile(
      fileURLToPath(
        new URL(
          "../../src/municipality-catalog-publication.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const source of [cliSource, verifierSource]) {
      expect(source).not.toMatch(
        /(?:from\s+["'](?:pg|node:https?|undici)["']|\bfetch\s*\()/u,
      );
    }
  });

  it("sanitiza argumentos inválidos da CLI", async () => {
    const previousExitCode = process.exitCode;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await runMunicipalityCatalogCli(["verify", "--manifest", "/segredo"]);
      expect(String(write.mock.calls[0]?.[0] ?? "")).toBe(
        '{"code":"MUNICIPALITY_CATALOG_SNAPSHOT_INVALID"}\n',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
    }
  });

  it("recusa FIFO sem bloquear na abertura", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "renave-municipios-fifo-"));
    temporaryDirectories.push(directory);
    const fifoPath = join(directory, "manifest.fifo");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);

    await expect(
      verifyMunicipalityCatalogSnapshotFiles({
        expectedManifestSha256: "0".repeat(64),
        manifestPath: fifoPath,
        sourcePath: fifoPath,
      }),
    ).rejects.toBeInstanceOf(MunicipalityCatalogSnapshotInvalidError);
  });
});
