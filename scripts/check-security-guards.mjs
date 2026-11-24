import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const thisFile = fileURLToPath(import.meta.url);
const runtimeRoots = [".github", "apps", "packages", "scripts"];
const runtimeExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const forbiddenSecretExtensions = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
]);

const sourceRules = [
  {
    id: "TLS_VERIFY_DISABLED",
    pattern: /rejectUnauthorized\s*:\s*false/,
  },
  {
    id: "TLS_ENV_DISABLED",
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*(?:=|:)\s*["']?0/,
  },
  {
    id: "INSECURE_CLI_FLAG",
    pattern: /(?:^|\s)--insecure(?:\s|$)/,
  },
  {
    id: "CURL_TLS_VERIFY_DISABLED",
    pattern: /\bcurl\b[^\n]*\s-k(?:\s|$)/,
  },
  {
    id: "WGET_TLS_VERIFY_DISABLED",
    pattern: /\bwget\b[^\n]*--no-check-certificate(?:\s|$)/,
  },
  {
    id: "WEB_STORAGE_CREDENTIAL",
    pattern:
      /(?:localStorage|sessionStorage)[\s\S]{0,120}(?:access[_-]?token|auth|id[_-]?token|refresh[_-]?token|session|token)/i,
  },
  {
    id: "PRIVATE_KEY_MATERIAL",
    pattern: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,
  },
];

function isRuntimeSource(path) {
  const normalized = path.replaceAll("\\", "/");
  return (
    runtimeExtensions.has(extname(path)) &&
    !normalized.includes("/node_modules/") &&
    !normalized.includes("/dist/") &&
    !normalized.includes("/coverage/") &&
    !normalized.includes("/test/") &&
    !/\.(?:spec|test)\.[^.]+$/.test(path) &&
    resolve(path) !== resolve(thisFile)
  );
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && isRuntimeSource(path)) files.push(path);
  }
  return files;
}

export function findSourceViolations(source) {
  return sourceRules.flatMap((rule) => {
    const match = rule.pattern.exec(source);
    if (!match || match.index === undefined) return [];
    const line = source.slice(0, match.index).split("\n").length;
    return [{ id: rule.id, line }];
  });
}

function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

async function scan() {
  const violations = [];
  for (const directory of runtimeRoots) {
    const absolute = join(root, directory);
    if ((await stat(absolute).catch(() => null))?.isDirectory() !== true)
      continue;
    for (const file of await walk(absolute)) {
      const source = await readFile(file, "utf8");
      for (const violation of findSourceViolations(source)) {
        violations.push(
          `${relative(root, file)}:${violation.line} ${violation.id}`,
        );
      }
    }
  }
  const rootConfigFiles = ["compose.yaml"];
  for (const name of rootConfigFiles) {
    const file = join(root, name);
    if ((await stat(file).catch(() => null))?.isFile() !== true) continue;
    const source = await readFile(file, "utf8");
    for (const violation of findSourceViolations(source)) {
      violations.push(`${name}:${violation.line} ${violation.id}`);
    }
  }

  for (const file of repositoryFiles()) {
    if (forbiddenSecretExtensions.has(extname(file).toLowerCase())) {
      violations.push(`${file}:1 CERTIFICATE_OR_KEY_FILE`);
    }
  }

  if (violations.length > 0) {
    console.error("Controles estáticos de segurança falharam:");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("Controles estáticos de segurança: OK");
}

function selfTest() {
  const cases = [
    ["const agent = { rejectUnauthorized: false };", "TLS_VERIFY_DISABLED"],
    ["NODE_TLS_REJECT_UNAUTHORIZED=0", "TLS_ENV_DISABLED"],
    ["curl --insecure https://example.test", "INSECURE_CLI_FLAG"],
    ["curl -k https://example.test", "CURL_TLS_VERIFY_DISABLED"],
    [
      "wget --no-check-certificate https://example.test",
      "WGET_TLS_VERIFY_DISABLED",
    ],
    ["NODE_TLS_REJECT_UNAUTHORIZED: 0", "TLS_ENV_DISABLED"],
    ['localStorage.setItem("access_token", token)', "WEB_STORAGE_CREDENTIAL"],
    ["-----BEGIN PRIVATE KEY-----", "PRIVATE_KEY_MATERIAL"],
  ];
  for (const [source, expected] of cases) {
    const ids = findSourceViolations(source).map(({ id }) => id);
    if (!ids.includes(expected)) {
      throw new Error(`Autoteste não detectou ${expected}`);
    }
  }
  if (findSourceViolations("const secure = true;").length !== 0) {
    throw new Error("Autoteste marcou código seguro");
  }
  console.log("Autoteste dos controles estáticos: OK");
}

if (process.argv.includes("--self-test")) selfTest();
else await scan();
