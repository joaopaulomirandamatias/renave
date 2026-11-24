import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
  serializeStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";
import { afterEach, describe, expect, it } from "vitest";

import { readStockEntryProvisioningSecrets } from "./secret-reader.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "renave-provision-secrets-"));
  directories.push(path);
  return path;
}

function bundleJson(): string {
  let seed = 0;
  const bundle = generateStockEntryKeyBundle("hml-reader", (size) =>
    Buffer.alloc(size, ++seed),
  );
  try {
    return serializeStockEntryKeyBundle(bundle);
  } finally {
    destroyStockEntryKeyBundle(bundle);
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("leitura dos segredos do provisionador", () => {
  it("aceita bundle 0400 e CA pública 0444", async () => {
    const root = await directory();
    await writeFile(join(root, "keys.json"), `${bundleJson()}\n`, {
      mode: 0o400,
    });
    await writeFile(join(root, "database-ca.pem"), "CA\n", { mode: 0o444 });
    const secrets = await readStockEntryProvisioningSecrets(root);
    try {
      expect(secrets.bundle.digests.generationId).toBe("hml-reader");
      expect(secrets.databaseCa).toBe("CA");
    } finally {
      destroyStockEntryKeyBundle(secrets.bundle);
    }
  });

  it("recusa permissão ampla e symlink para fora do mount", async () => {
    const root = await directory();
    const outside = await directory();
    const target = join(outside, "keys.json");
    await writeFile(target, bundleJson(), { mode: 0o400 });
    await symlink(target, join(root, "keys.json"));
    await expect(readStockEntryProvisioningSecrets(root)).rejects.toMatchObject(
      {
        code: "BUNDLE_INPUT_INVALID",
      },
    );

    await rm(join(root, "keys.json"));
    await writeFile(join(root, "keys.json"), bundleJson(), { mode: 0o600 });
    await chmod(join(root, "keys.json"), 0o600);
    await expect(readStockEntryProvisioningSecrets(root)).rejects.toMatchObject(
      {
        code: "BUNDLE_INPUT_INVALID",
      },
    );
  });

  it("recusa raiz gravável por grupo/outros e raiz que seja symlink", async () => {
    const root = await directory();
    await writeFile(join(root, "keys.json"), bundleJson(), { mode: 0o400 });
    await chmod(root, 0o770);
    await expect(readStockEntryProvisioningSecrets(root)).rejects.toMatchObject(
      {
        code: "BUNDLE_INPUT_INVALID",
      },
    );

    await chmod(root, 0o700);
    const parent = await directory();
    const alias = join(parent, "alias");
    await symlink(root, alias, "dir");
    await expect(
      readStockEntryProvisioningSecrets(alias),
    ).rejects.toMatchObject({
      code: "BUNDLE_INPUT_INVALID",
    });
  });
});
