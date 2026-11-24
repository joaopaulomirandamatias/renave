import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  destroyStockEntryKeyBundle,
  parseStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BundleWriterFilesystem,
  generateBundleFile,
  nodeBundleWriterFilesystem,
  STOCK_ENTRY_BUNDLE_FILE_NAME,
} from "./bundle-writer.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "renave-stock-entry-keys-"));
  directories.push(path);
  await chmod(path, 0o700);
  return path;
}

function deterministicRandom() {
  let seed = 0;
  return (size: number): Uint8Array => Buffer.alloc(size, ++seed);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("escrita do bundle HELD_LOCAL", () => {
  it("publica arquivo 0400 aceito pelo parser compartilhado", async () => {
    const root = await directory();
    const receipt = await generateBundleFile({
      generationId: "hml-2026-11",
      outputDirectory: root,
      random: deterministicRandom(),
    });
    const path = join(root, STOCK_ENTRY_BUNDLE_FILE_NAME);
    const metadata = await lstat(path);
    expect(metadata.mode & 0o777).toBe(0o400);
    const bundle = parseStockEntryKeyBundle(await readFile(path, "utf8"));
    try {
      expect(bundle.digests.generationId).toBe(receipt.generationId);
      expect(bundle.digests.fingerprint.toString("hex")).toBe(
        receipt.fingerprintHex,
      );
    } finally {
      destroyStockEntryKeyBundle(bundle);
    }
  });

  it("nunca sobrescreve destino existente", async () => {
    const root = await directory();
    const path = join(root, STOCK_ENTRY_BUNDLE_FILE_NAME);
    await writeFile(path, "preserve", { mode: 0o400 });
    await expect(
      generateBundleFile({
        generationId: "hml-existing",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_OUTPUT_EXISTS" });
    expect(await readFile(path, "utf8")).toBe("preserve");
  });

  it("permite exatamente um vencedor concorrente", async () => {
    const root = await directory();
    const settled = await Promise.allSettled([
      generateBundleFile({
        generationId: "hml-race",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
      generateBundleFile({
        generationId: "hml-race",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("recusa diretório dentro de worktree Git e diretório gravável pelo grupo", async () => {
    const root = await directory();
    await writeFile(join(root, ".git"), "gitdir: somewhere\n", { mode: 0o600 });
    await expect(
      generateBundleFile({
        generationId: "hml-git",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_OUTPUT_INSECURE" });

    await rm(join(root, ".git"));
    await chmod(root, 0o770);
    await expect(
      generateBundleFile({
        generationId: "hml-permissions",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_OUTPUT_INSECURE" });
  });

  it("preserva destino válido e sinaliza durabilidade incerta se cleanup pós-link falha", async () => {
    const root = await directory();
    let firstTemporaryUnlink = true;
    const filesystem: BundleWriterFilesystem = {
      ...nodeBundleWriterFilesystem,
      unlink: async (path) => {
        if (firstTemporaryUnlink && String(path).endsWith(".tmp")) {
          firstTemporaryUnlink = false;
          throw new Error("falha injetada");
        }
        return nodeBundleWriterFilesystem.unlink(path);
      },
    };
    await expect(
      generateBundleFile({
        filesystem,
        generationId: "hml-post-link-unlink",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ).rejects.toMatchObject({
      code: "BUNDLE_PUBLISHED_DURABILITY_UNCERTAIN",
    });
    const destination = join(root, STOCK_ENTRY_BUNDLE_FILE_NAME);
    const parsed = parseStockEntryKeyBundle(
      await readFile(destination, "utf8"),
    );
    try {
      expect(parsed.digests.generationId).toBe("hml-post-link-unlink");
      expect((await lstat(destination)).mode & 0o777).toBe(0o400);
      expect(
        (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      destroyStockEntryKeyBundle(parsed);
    }
  });

  it("não apaga destino válido quando chmod pós-link falha", async () => {
    const root = await directory();
    const filesystem: BundleWriterFilesystem = {
      ...nodeBundleWriterFilesystem,
      chmod: async (path, mode) => {
        if (String(path).endsWith(STOCK_ENTRY_BUNDLE_FILE_NAME)) {
          throw new Error("falha injetada");
        }
        return nodeBundleWriterFilesystem.chmod(path, mode);
      },
    };
    await expect(
      generateBundleFile({
        filesystem,
        generationId: "hml-post-link-chmod",
        outputDirectory: root,
        random: deterministicRandom(),
      }),
    ).rejects.toMatchObject({
      code: "BUNDLE_PUBLISHED_DURABILITY_UNCERTAIN",
    });
    const destination = join(root, STOCK_ENTRY_BUNDLE_FILE_NAME);
    expect((await lstat(destination)).mode & 0o777).toBe(0o400);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
