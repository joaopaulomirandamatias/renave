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
  if (
    values.length !== 7 ||
    values[0] !== "verify" ||
    values[1] !== "--manifest" ||
    values[3] !== "--source" ||
    values[5] !== "--expected-manifest-sha256" ||
    !values[2] ||
    !values[4] ||
    !values[6]
  ) {
    throw new MunicipalityCatalogSnapshotInvalidError();
  }
  return {
    expectedManifestSha256: values[6],
    manifestPath: values[2],
    sourcePath: values[4],
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
