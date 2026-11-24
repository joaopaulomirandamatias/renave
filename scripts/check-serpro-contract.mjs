import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const methods = new Set(["delete", "get", "patch", "post", "put"]);
const baselineUrl = new URL(
  "../contracts/serpro/estabelecimento-baseline.json",
  import.meta.url,
);

function metrics(document) {
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

const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
let changed = false;

for (const [environment, expected] of Object.entries(baseline.environments)) {
  const response = await fetch(expected.source, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `${environment}: Swagger respondeu HTTP ${response.status}`,
    );
  }

  const body = await response.text();
  const document = JSON.parse(body);
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
    ...metrics(document),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  const differences = Object.entries(actual).filter(
    ([key, value]) => expected[key] !== value,
  );

  if (differences.length === 0) {
    console.log(`${environment}: contrato sem mudanças`);
    continue;
  }

  changed = true;
  console.error(`${environment}: contrato mudou`);
  for (const [key, value] of differences) {
    console.error(`  ${key}: esperado=${expected[key]} atual=${value}`);
  }
}

if (changed) process.exitCode = 1;
