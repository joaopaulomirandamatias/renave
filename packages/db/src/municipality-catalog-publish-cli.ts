import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { MunicipalityCatalogSnapshotInvalidError } from "./municipality-catalog-publication.js";
import {
  municipalityCatalogPublisherPoolConfig,
  publishMunicipalityCatalogSnapshotFiles,
} from "./municipality-catalog-publisher.js";

const MAXIMUM_CA_BYTES = 256 * 1_024;

function argumentsFrom(values: readonly string[]): {
  expectedManifestSha256: string;
  manifestPath: string;
  maximumAgeMs: number;
  sourcePath: string;
} {
  const normalized = values[0] === "--" ? values.slice(1) : values;
  if (
    normalized.length !== 9 ||
    normalized[0] !== "publish" ||
    normalized[1] !== "--manifest" ||
    normalized[3] !== "--source" ||
    normalized[5] !== "--expected-manifest-sha256" ||
    normalized[7] !== "--maximum-age-hours" ||
    !normalized[2] ||
    !normalized[4] ||
    !normalized[6] ||
    !normalized[8]
  ) {
    throw new MunicipalityCatalogSnapshotInvalidError();
  }
  const maximumAgeHours = Number(normalized[8]);
  if (
    !Number.isSafeInteger(maximumAgeHours) ||
    maximumAgeHours < 1 ||
    maximumAgeHours > 24
  ) {
    throw new MunicipalityCatalogSnapshotInvalidError();
  }
  return {
    expectedManifestSha256: normalized[6],
    manifestPath: normalized[2],
    maximumAgeMs: maximumAgeHours * 60 * 60 * 1_000,
    sourcePath: normalized[4],
  };
}

async function databaseCa(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const path = environment.DATABASE_MIGRATOR_TLS_CA_FILE;
  if (path === undefined || path === "") return undefined;
  let handle;
  let bytes: Buffer | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_CA_BYTES) {
      throw new MunicipalityCatalogSnapshotInvalidError();
    }
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) throw new MunicipalityCatalogSnapshotInvalidError();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new MunicipalityCatalogSnapshotInvalidError();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MunicipalityCatalogSnapshotInvalidError();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function runMunicipalityCatalogPublishCli(
  values: readonly string[],
): Promise<void> {
  let pool: Pool | undefined;
  try {
    const input = argumentsFrom(values);
    const databaseUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!databaseUrl) throw new MunicipalityCatalogSnapshotInvalidError();
    pool = new Pool(
      municipalityCatalogPublisherPoolConfig(
        databaseUrl,
        await databaseCa(process.env),
      ),
    );
    const published = await publishMunicipalityCatalogSnapshotFiles({
      ...input,
      now: new Date(),
      pool,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: "publish",
        outcome: published.outcome,
        rowCount: published.rowCount,
        version: published.version,
      })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        code: "MUNICIPALITY_CATALOG_PUBLICATION_REJECTED",
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  await runMunicipalityCatalogPublishCli(process.argv.slice(2));
}
