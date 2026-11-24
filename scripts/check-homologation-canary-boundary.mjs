import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx"]);

const forbiddenSourcePatterns = [
  ["operação de criação de estoque", /\bcreateStockEntry\b/u],
  ["módulo de entrada de estoque", /stock-entry/iu],
  ["capacidade de mutação", /\b(?:executeMutation|mutation|mutate)\b/iu],
  [
    "conector RENAVE",
    /renave-connector|\bRenaveConnector\b|\bHttpRenaveTransport\b/iu,
  ],
  ["banco de dados", /@seu-renave\/db|\b(?:database|indexedDB)\b/iu],
  ["cookie do documento", /document\s*\.\s*cookie/iu],
  ["persistência no navegador", /\b(?:(?:local|session)?Storage)\b/u],
  [
    "temporizador",
    /\b(?:setTimeout|setInterval|setImmediate|requestAnimationFrame)\s*\(/u,
  ],
  ["repetição automática", /\b(?:poll|polling|retry)\b/iu],
  ["fetch direto", /\bfetch\s*\(/u],
  ["URL absoluta", /https?:\/\//iu],
  [
    "endpoint ou capacidade direta do SERPRO",
    /serpro\.gov\.br|\b(?:SERPRO_[A-Z0-9_]+|Serpro[A-Za-z0-9_]+)\b/u,
  ],
  ["saída em console", /\bconsole\s*\./u],
];

const allowedPackages = new Set(["react", "@seu-renave/ui"]);

async function listProductionSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listProductionSources(target)));
      continue;
    }
    if (
      sourceExtensions.has(path.extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.")
    ) {
      files.push(target);
    }
  }
  return files;
}

function importViolations(source, relativePath) {
  const violations = [];
  const importPattern =
    /import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gu;
  for (const match of source.matchAll(importPattern)) {
    const [, typeOnly, specifier] = match;
    if (/(?:^|\/)(?:api|db|connectors?|runtime)(?:[/.]|$)/iu.test(specifier)) {
      violations.push(
        `${relativePath}: importação de runtime proibida (${specifier})`,
      );
      continue;
    }
    if (specifier.startsWith("./")) continue;
    if (specifier === "../../App.js" && typeOnly) continue;
    if (allowedPackages.has(specifier)) continue;
    violations.push(
      `${relativePath}: importação fora da fronteira (${specifier})`,
    );
  }
  return violations;
}

export function checkCanarySource(source, relativePath = "fonte") {
  const violations = importViolations(source, relativePath);
  for (const [label, pattern] of forbiddenSourcePatterns) {
    if (pattern.test(source)) violations.push(`${relativePath}: ${label}`);
  }
  return violations;
}

export async function checkHomologationCanaryBoundary(directory) {
  const files = await listProductionSources(directory);
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    violations.push(
      ...checkCanarySource(source, path.relative(directory, file)),
    );
  }
  const port = await readFile(path.join(directory, "port.ts"), "utf8");
  const required = [
    "loadReadiness",
    "runPreflight",
    "checkEligibility",
    "searchStocks",
    "lookupVehicle",
  ];
  for (const method of required) {
    if (!new RegExp(`\\b${method}\\s*\\(`, "u").test(port)) {
      violations.push(`port.ts: capacidade obrigatória ausente (${method})`);
    }
  }
  const methodPattern = /^\s{2}([A-Za-z][A-Za-z0-9]*)\s*\(/gmu;
  for (const match of port.matchAll(methodPattern)) {
    if (!required.includes(match[1])) {
      violations.push(`port.ts: capacidade adicional proibida (${match[1]})`);
    }
  }
  if (/\bSessionClient\b/u.test(port)) {
    violations.push("port.ts: cliente de sessão amplo proibido");
  }
  return violations;
}

async function main() {
  const directory = path.resolve("apps/web/src/features/homologation-canary");
  const violations = await checkHomologationCanaryBoundary(directory);
  if (violations.length > 0) {
    console.error("Fronteira do ensaio guiado violada:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("Fronteira do ensaio guiado sem mutação SERPRO: OK");
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await main();
}
