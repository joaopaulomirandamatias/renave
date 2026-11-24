import { createRequire } from "node:module";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function importSpecifiers(source) {
  const specifiers = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) result.push(path);
  }
  return result;
}

async function roots(root) {
  const result = [join(root, "dist")];
  const links = join(root, "node_modules", "@seu-renave");
  for (const entry of await readdir(links, { withFileTypes: true }).catch(
    () => [],
  )) {
    const packageRoot = await realpath(join(links, entry.name)).catch(
      () => null,
    );
    if (packageRoot) result.push(join(packageRoot, "dist"));
  }
  return [...new Set(await Promise.all(result.map((path) => realpath(path))))];
}

async function resolves(file, specifier) {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = specifier.startsWith("/")
      ? resolve(specifier)
      : resolve(dirname(file), specifier);
    return (await stat(target).catch(() => null))?.isFile() === true;
  }
  try {
    createRequire(file).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export async function assertRuntimeEsmImports(root) {
  for (const ownedRoot of await roots(resolve(root))) {
    for (const file of await files(ownedRoot)) {
      const source = await import("node:fs/promises").then(({ readFile }) =>
        readFile(file, "utf8"),
      );
      for (const specifier of importSpecifiers(source)) {
        if (!(await resolves(file, specifier))) {
          throw new Error("runtime ESM import unavailable");
        }
      }
    }
  }
}
