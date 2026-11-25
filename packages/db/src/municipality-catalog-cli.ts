import { pathToFileURL } from "node:url";

import {
  MunicipalityCatalogSnapshotInvalidError,
  verifyMunicipalityCatalogSnapshotFiles,
} from "./municipality-catalog-publication.js";

function argumentsFrom(values: readonly string[]): {
  expectedManifestSha256: string;
  manifestPath: string;
  sourcePath: string;
} {
  const normalized = values[0] === "--" ? values.slice(1) : values;
  if (
    normalized.length !== 7 ||
    normalized[0] !== "verify" ||
    normalized[1] !== "--manifest" ||
    normalized[3] !== "--source" ||
    normalized[5] !== "--expected-manifest-sha256" ||
    !normalized[2] ||
    !normalized[4] ||
    !normalized[6]
  ) {
    throw new MunicipalityCatalogSnapshotInvalidError();
  }
  return {
    expectedManifestSha256: normalized[6],
    manifestPath: normalized[2],
    sourcePath: normalized[4],
  };
}

export async function runMunicipalityCatalogCli(
  values: readonly string[],
): Promise<void> {
  try {
    const verified = await verifyMunicipalityCatalogSnapshotFiles(
      argumentsFrom(values),
    );
    process.stdout.write(
      `${JSON.stringify({
        artifactSha256: verified.artifactSha256,
        manifestSha256: verified.manifestSha256,
        mode: "verify",
        rowCount: verified.rowCount,
        sourceSha256: verified.sourceSha256,
        version: verified.version,
      })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ code: "MUNICIPALITY_CATALOG_SNAPSHOT_INVALID" })}\n`,
    );
    process.exitCode = 1;
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  await runMunicipalityCatalogCli(process.argv.slice(2));
}
