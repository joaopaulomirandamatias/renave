import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  fetchBoundedJson,
  MAX_SERPRO_JSON_RESPONSE_BYTES,
} from "./serpro-json-monitor.mjs";

const methods = new Set(["delete", "get", "patch", "post", "put"]);
const baselineUrl = new URL(
  "../contracts/serpro/estabelecimento-baseline.json",
  import.meta.url,
);

export function contractMetrics(document) {
  const operations = Object.values(document.paths ?? {}).flatMap((path) =>
    Object.entries(path).filter(([method]) => methods.has(method)),
  );
  const securedByCnpj = operations.filter(([, operation]) =>
    (operation.security ?? []).some((requirement) =>
      Object.hasOwn(requirement, "cnpjEstabelecimento"),
    ),
  ).length;

  return {
    operationCount: operations.length,
    operationsSecuredByCnpjEstabelecimento: securedByCnpj,
    pathCount: Object.keys(document.paths ?? {}).length,
  };
}

export async function checkSerproContract({
  baseline,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_SERPRO_JSON_RESPONSE_BYTES,
  output = console,
}) {
  let changed = false;

  for (const [environment, expected] of Object.entries(baseline.environments)) {
    const { bytes, document } = await fetchBoundedJson(
      environment,
      expected.source,
      { fetchImpl, maxBytes },
    );
    if (
      expected.operationsSecuredByCnpjEstabelecimento > 0 &&
      document.securityDefinitions?.cnpjEstabelecimento?.name !==
        "CNPJ-Estabelecimento"
    ) {
      throw new Error(
        `${environment}: security definition deixou de usar CNPJ-Estabelecimento`,
      );
    }
    const actual = {
      ...contractMetrics(document),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const differences = Object.entries(actual).filter(
      ([key, value]) => expected[key] !== value,
    );

    if (differences.length === 0) {
      output.log(`${environment}: contrato sem mudanças`);
      continue;
    }

    changed = true;
    output.error(`${environment}: contrato mudou`);
    for (const [key, value] of differences) {
      output.error(`  ${key}: esperado=${expected[key]} atual=${value}`);
    }
  }

  return { changed };
}

export async function runContractCli() {
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  const { changed } = await checkSerproContract({ baseline });
  if (changed) process.exitCode = 1;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) await runContractCli();
