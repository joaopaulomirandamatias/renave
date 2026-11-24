import { createRequire } from "node:module";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
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

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await javascriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

async function ownedRuntimeRoots(root) {
  const roots = [join(root, "dist")];
  const workspaceLinks = join(root, "node_modules", "@seu-renave");
  for (const entry of await readdir(workspaceLinks, {
    withFileTypes: true,
  }).catch(() => [])) {
    const packageRoot = await realpath(join(workspaceLinks, entry.name)).catch(
      () => null,
    );
    if (packageRoot) roots.push(join(packageRoot, "dist"));
  }
  return [...new Set(await Promise.all(roots.map((path) => realpath(path))))];
}

async function resolvesFrom(file, specifier) {
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
  const runtimeRoot = resolve(root);
  for (const ownedRoot of await ownedRuntimeRoots(runtimeRoot)) {
    for (const file of await javascriptFiles(ownedRoot)) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (!(await resolvesFrom(file, specifier))) {
          throw new Error("runtime ESM import unavailable");
        }
      }
    }
  }
}
