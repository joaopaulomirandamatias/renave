import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assertRuntimeEsmImports } from "./runtime-imports.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/")
  throw new Error("runtime directory required");

const removableDirectories = new Set(["__tests__", "src", "test", "tests"]);
const dbFiles = new Set([
  "config.js",
  "operation-promoter.js",
  "operations.js",
  "runtime-guard.js",
  "tenant-context.js",
]);
const allowedWorkspacePackages = new Set([
  "@seu-renave/db",
  "@seu-renave/operation-promoter-app",
  "@seu-renave/operation-promotion-decision",
]);
const forbidden = (name) =>
  /\.(?:test|spec)\./u.test(name) ||
  /\.(?:[cm]?ts|tsx)$/u.test(name) ||
  /\.(?:env|key|map|p12|pem|pfx)$/iu.test(name) ||
  name === ".env" ||
  name.startsWith(".env.");

async function rewriteManifest(path) {
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

async function sanitize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packageEntry = entries.find(
    (entry) => entry.isFile() && entry.name === "package.json",
  );
  const packageName = packageEntry
    ? await rewriteManifest(join(directory, "package.json"))
    : null;
  if (
    packageName?.startsWith("@seu-renave/") &&
    !allowedWorkspacePackages.has(packageName)
  ) {
    await rm(directory, { force: true, recursive: true });
    return true;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (removableDirectories.has(entry.name)) {
        await rm(path, { force: true, recursive: true });
      } else {
        const removed = await sanitize(path);
        if (!removed && (await readdir(path)).length === 0) {
          await rm(path, { force: true, recursive: true });
        }
      }
    } else if (
      entry.isFile() &&
      (forbidden(entry.name) ||
        (packageName &&
          (entry.name.startsWith("tsconfig") ||
            entry.name.startsWith("vitest.config."))))
    ) {
      await rm(path, { force: true });
    }
  }
  if (packageName === "@seu-renave/db") {
    const dist = join(directory, "dist");
    for (const entry of await readdir(dist, { withFileTypes: true })) {
      if (!entry.isFile() || !dbFiles.has(entry.name)) {
        await rm(join(dist, entry.name), { force: true, recursive: true });
      }
    }
  }
  return false;
}

await sanitize(root);
await Promise.all(
  ["access-control", "identity"].map((name) =>
    rm(join(root, "node_modules", "@seu-renave", name), {
      force: true,
      recursive: true,
    }),
  ),
);
await rm(join(root, "README.md"), { force: true });
await readFile(join(root, "dist", "main.js"));
await assertRuntimeEsmImports(root);
