import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { assertRuntimeEsmImports } from "./runtime-imports.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/") {
  throw new Error("runtime directory required");
}

const removableDirectories = new Set(["__tests__", "src", "test", "tests"]);
const apiRuntimeDbFiles = new Set(
  [
    "api-runtime",
    "audit-events",
    "authorization",
    "cnpj",
    "config",
    "credential-links",
    "establishments",
    "login-rate-limiter",
    "operations",
    "renave-profiles",
    "runtime-guard",
    "serpro-query-limiter",
    "session-store",
    "stock-entry-rate-limiter",
    "tenant-admin-rate-limiter",
    "tenant-administration",
    "tenant-context",
    "tenant-directory",
    "tenant-runtime",
  ].map((name) => `${name}.js`),
);
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
    return false;
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
  return true;
}

async function sanitize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifestEntry = entries.find(
    (entry) => entry.isFile() && entry.name === "package.json",
  );
  const workspacePackage = manifestEntry
    ? await rewriteWorkspaceManifest(join(directory, manifestEntry.name))
    : false;

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
    if (
      entry.isFile() &&
      (forbiddenFile(entry.name) ||
        (workspacePackage &&
          (entry.name.startsWith("tsconfig") ||
            entry.name.startsWith("vitest.config."))))
    ) {
      await rm(path, { force: true });
    }
  }
  if (workspacePackage) {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (manifest.name === "@seu-renave/db") {
      const dist = join(directory, "dist");
      for (const entry of await readdir(dist, { withFileTypes: true })) {
        if (!entry.isFile() || !apiRuntimeDbFiles.has(entry.name)) {
          await rm(join(dist, entry.name), { force: true, recursive: true });
        }
      }
    }
  }
}

await sanitize(root);

for (const required of [
  "dist/server.js",
  "dist/health-probe.js",
  "package.json",
]) {
  await readFile(join(root, required));
}

await assertRuntimeEsmImports(root);

if (basename(root) === "") throw new Error("invalid runtime directory");
