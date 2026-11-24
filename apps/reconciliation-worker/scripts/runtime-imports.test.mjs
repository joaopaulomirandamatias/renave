import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { assertRuntimeEsmImports } from "./runtime-imports.mjs";

const temporaryDirectories = [];

async function runtime(files) {
  const root = await mkdtemp(join(tmpdir(), "renave-worker-runtime-imports-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, "dist", name), source);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("grafo ESM do runtime do reconciliation worker", () => {
  it("aceita imports relativos presentes", async () => {
    const root = await runtime({
      "dependency.js": "export const value = 1;\n",
      "main.js": 'import { value } from "./dependency.js";\nvoid value;\n',
    });
    await assert.doesNotReject(assertRuntimeEsmImports(root));
  });

  it("recusa import relativo removido pelo pruning", async () => {
    const root = await runtime({
      "main.js": 'export { missing } from "./missing.js";\n',
    });
    await assert.rejects(
      assertRuntimeEsmImports(root),
      /runtime ESM import unavailable/u,
    );
  });

  it("recusa pacote ausente sem ecoar o specifier", async () => {
    const root = await runtime({
      "main.js": 'import "private-package-name";\n',
    });
    await assert.rejects(assertRuntimeEsmImports(root), (error) => {
      assert.equal(error.message, "runtime ESM import unavailable");
      assert.equal(error.message.includes("private-package-name"), false);
      return true;
    });
  });
});
