import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OperationPromoterError } from "./errors.js";
import { readOperationPromoterFiles } from "./secret-files.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "renave-promoter-"));
  directories.push(value);
  await chmod(value, 0o700);
  return value;
}

async function file(root: string, name: string, value: string): Promise<void> {
  const path = join(root, name);
  await writeFile(path, value, { mode: 0o400 });
  await chmod(path, 0o400);
}

async function complete(root: string): Promise<void> {
  await Promise.all([
    file(root, "database-ca.pem", "ca"),
    file(root, "database-url", "url"),
    file(root, "promotion-decision.json", "decision"),
    file(root, "decision-keyring.json", "keyring"),
    file(root, "target.json", "target"),
  ]);
}

async function projectedComplete(root: string): Promise<void> {
  const generation = "..2026_11_24_18_30_00.000000001";
  const generationDirectory = join(root, generation);
  await mkdir(generationDirectory, { mode: 0o700 });
  await complete(generationDirectory);
  await symlink(generation, join(root, "..data"));
  for (const name of [
    "database-ca.pem",
    "database-url",
    "promotion-decision.json",
    "decision-keyring.json",
    "target.json",
  ]) {
    await symlink(join("..data", name), join(root, name));
  }
}

afterEach(async () => {
  for (const value of directories.splice(0)) {
    await rm(value, { force: true, recursive: true });
  }
});

describe("readOperationPromoterFiles", () => {
  it("lê somente arquivos regulares limitados e zera todos no destroy", async () => {
    const root = await directory();
    await complete(root);
    const files = await readOperationPromoterFiles(root);
    expect(files.databaseUrl.toString()).toBe("url");
    files.destroy();
    expect([...files.databaseUrl]).toEqual([0, 0, 0]);
    expect(files.decision.every((value) => value === 0)).toBe(true);
    files.destroy();
  });

  it("aceita o layout de Secret projetado arquivo -> ..data/arquivo", async () => {
    const root = await directory();
    await projectedComplete(root);
    const files = await readOperationPromoterFiles(root);
    expect(files.databaseUrl.toString()).toBe("url");
    expect(files.decision.toString()).toBe("decision");
    files.destroy();
  });

  it("rejeita cadeia ..data que resolve para fora do mount", async () => {
    const root = await directory();
    const outside = await directory();
    await complete(outside);
    await symlink(outside, join(root, "..data"));
    for (const name of [
      "database-ca.pem",
      "database-url",
      "promotion-decision.json",
      "decision-keyring.json",
      "target.json",
    ]) {
      await symlink(join("..data", name), join(root, name));
    }

    await expect(readOperationPromoterFiles(root)).rejects.toMatchObject({
      code: "OPERATION_PROMOTER_CONFIG_INVALID",
    });
  });

  it("rejeita symlink direto que escapa do mount", async () => {
    const root = await directory();
    await complete(root);
    const outside = join(await directory(), "outside");
    await writeFile(outside, "secret", { mode: 0o400 });
    await rm(join(root, "database-url"));
    await symlink(outside, join(root, "database-url"));
    await expect(readOperationPromoterFiles(root)).rejects.toBeInstanceOf(
      OperationPromoterError,
    );
  });

  it("rejeita cadeia que sai do mount mesmo quando o realpath final retorna", async () => {
    const root = await directory();
    await complete(root);
    const internal = join(root, "internal-url");
    await file(root, "internal-url", "url");
    const outside = await directory();
    await symlink(internal, join(outside, "bounce"));
    await rm(join(root, "database-url"));
    await symlink(join(outside, "bounce"), join(root, "database-url"));

    await expect(readOperationPromoterFiles(root)).rejects.toMatchObject({
      code: "OPERATION_PROMOTER_CONFIG_INVALID",
    });
  });

  it("rejeita permissões amplas, arquivo ausente e conteúdo acima do limite", async () => {
    const root = await directory();
    await complete(root);
    await chmod(join(root, "target.json"), 0o644);
    await expect(readOperationPromoterFiles(root)).rejects.toBeInstanceOf(
      OperationPromoterError,
    );
    await chmod(join(root, "target.json"), 0o400);
    await rm(join(root, "decision-keyring.json"));
    await expect(readOperationPromoterFiles(root)).rejects.toBeInstanceOf(
      OperationPromoterError,
    );
    await file(root, "decision-keyring.json", "x".repeat(64 * 1024 + 1));
    await expect(readOperationPromoterFiles(root)).rejects.toBeInstanceOf(
      OperationPromoterError,
    );
  });
});
