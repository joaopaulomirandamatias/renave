import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/") {
  throw new Error("runtime directory required");
}

const removableDirectories = new Set(["__tests__", "src", "test", "tests"]);
const operationWorkerDbFiles = new Set([
  "cnpj.js",
  "config.js",
  "operation-reconciliation.js",
  "operation-worker.js",
  "runtime-guard.js",
  "serpro-query-limiter.js",
  "tenant-context.js",
]);
const forbiddenFile = (name) =>
  /\.(?:test|spec)\./u.test(name) ||
  /\.(?:[cm]?ts|tsx)$/u.test(name) ||
  /\.(?:env|key|map|p12|pem|pfx)$/iu.test(name) ||
  name === ".env" ||
  name.startsWith(".env.");

async function rewriteWorkspaceManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof manifest.name !== "string" ||
    !manifest.name.startsWith("@seu-renave/")
  ) {
    return null;
  }
  if (manifest.exports && typeof manifest.exports === "object") {
    for (const target of Object.values(manifest.exports)) {
      if (
        target &&
        typeof target === "object" &&
        typeof target.production === "string"
      ) {
        target.default = target.production;
      }
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  return manifest.name;
}

async function pruneOperationWorkerDb(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !operationWorkerDbFiles.has(entry.name)) {
      await rm(join(directory, entry.name), { force: true, recursive: true });
    }
  }
}

async function sanitize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifestEntry = entries.find(
    (entry) => entry.isFile() && entry.name === "package.json",
  );
  const workspacePackageName = manifestEntry
    ? await rewriteWorkspaceManifest(join(directory, manifestEntry.name))
    : null;
  const workspacePackage = workspacePackageName !== null;

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        removableDirectories.has(entry.name) ||
        (workspacePackage && entry.name === "src")
      ) {
        await rm(path, { force: true, recursive: true });
      } else {
        await sanitize(path);
        if ((await readdir(path)).length === 0) {
          await rm(path, { force: true, recursive: true });
        }
      }
      continue;
    }
    if (entry.isFile()) {
      if (
        forbiddenFile(entry.name) ||
        (workspacePackage &&
          (entry.name.startsWith("tsconfig") ||
            entry.name.startsWith("vitest.config.")))
      ) {
        await rm(path, { force: true });
      }
    }
  }
  if (workspacePackageName === "@seu-renave/db") {
    await pruneOperationWorkerDb(join(directory, "dist"));
  }
}

await sanitize(root);

for (const required of [
  "dist/main.js",
  "dist/health-probe.js",
  "package.json",
]) {
  await readFile(join(root, required));
}

if (basename(root) === "") throw new Error("invalid runtime directory");
