import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_SECRET_DIRECTORY,
  ApiSecretFilesError,
  readApiSecretFilesFromDirectory,
} from "./secret-files.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "renave-api-secrets-"));
  directories.push(result);
  return result;
}

async function secret(
  root: string,
  name: string,
  value: string | Buffer,
): Promise<void> {
  const path = join(root, name);
  await writeFile(path, value);
  await chmod(path, 0o400);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("arquivos secretos da API", () => {
  it("mantém o mount operacional fixo", () => {
    expect(API_SECRET_DIRECTORY).toBe("/run/secrets/seu-renave/api");
  });

  it("lê conteúdo limitado e remove somente um newline final", async () => {
    const root = await directory();
    await Promise.all([
      secret(root, "database-url", "postgres://app@db/renave\n"),
      secret(root, "database-ca.pem", "-----BEGIN CERTIFICATE-----\nca\n"),
      secret(root, "oidc-client-secret", "client-secret\r\n"),
      secret(root, "evidence-keyring.json", '{"version":1}\n'),
    ]);
    await expect(readApiSecretFilesFromDirectory(root)).resolves.toMatchObject({
      databaseCa: "-----BEGIN CERTIFICATE-----\nca",
      databaseUrl: "postgres://app@db/renave",
      evidenceKeyringJson: '{"version":1}',
      oidcClientSecret: "client-secret",
    });
  });

  it("aceita projeção atômica somente quando todos os arquivos vêm da mesma versão", async () => {
    const valid = await directory();
    const version = join(valid, "..data-1");
    await mkdir(version);
    await Promise.all([
      secret(version, "database-url", "postgres://app@db/renave"),
      secret(version, "login-rate-limit-hmac-key", "hmac"),
    ]);
    await symlink("..data-1", join(valid, "..data"));
    await symlink("..data-1/database-url", join(valid, "database-url"));
    await symlink(
      "..data-1/login-rate-limit-hmac-key",
      join(valid, "login-rate-limit-hmac-key"),
    );
    await expect(readApiSecretFilesFromDirectory(valid)).resolves.toMatchObject(
      { databaseUrl: "postgres://app@db/renave" },
    );

    const rotated = await directory();
    const first = join(rotated, "..data-1");
    const second = join(rotated, "..data-2");
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all([
      secret(first, "database-url", "postgres://app@db/one"),
      secret(second, "database-url", "postgres://app@db/two"),
      secret(second, "oidc-client-secret", "new-client-secret"),
    ]);
    await symlink("..data-1", join(rotated, "..data"));
    await expect(
      readApiSecretFilesFromDirectory(rotated),
    ).resolves.toMatchObject({
      databaseUrl: "postgres://app@db/one",
      oidcClientSecret: undefined,
    });
    await symlink("..data-2", join(rotated, "..data-next"));
    await rename(join(rotated, "..data-next"), join(rotated, "..data"));
    await expect(
      readApiSecretFilesFromDirectory(rotated),
    ).resolves.toMatchObject({
      databaseUrl: "postgres://app@db/two",
      oidcClientSecret: "new-client-secret",
    });

    const malformed = await directory();
    await writeFile(join(malformed, "..data"), "not-a-symlink");
    await chmod(join(malformed, "..data"), 0o400);
    await expect(
      readApiSecretFilesFromDirectory(malformed),
    ).rejects.toBeInstanceOf(ApiSecretFilesError);
  });

  it("recusa symlink externo, diretório, FIFO e permissões amplas", async () => {
    const outside = await directory();
    await secret(outside, "outside", "do-not-leak");
    const corruptions = [
      async (root: string) =>
        symlink(join(outside, "outside"), join(root, "database-url")),
      async (root: string) => mkdir(join(root, "database-url")),
      async (root: string) => {
        await execFile("mkfifo", [join(root, "database-url")]);
      },
      async (root: string) => {
        await secret(root, "database-url", "postgres://app@db/renave");
        await chmod(join(root, "database-url"), 0o444);
      },
    ];
    for (const corrupt of corruptions) {
      const root = await directory();
      await corrupt(root);
      const error = await readApiSecretFilesFromDirectory(root)
        .then(() => undefined)
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(ApiSecretFilesError);
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain(outside);
      expect(String(error)).not.toContain("do-not-leak");
    }
  });

  it("recusa limite excedido, NUL, UTF-8 inválido e whitespace ambíguo", async () => {
    const corruptions: Array<[string, string | Buffer]> = [
      ["oidc-client-secret", "x".repeat(4_097)],
      ["oidc-client-secret", Buffer.from("value\0tail")],
      ["oidc-client-secret", Buffer.from([0xff, 0xfe])],
      ["oidc-client-secret", " value\n"],
      ["oidc-client-secret", "value\n\n"],
    ];
    for (const [name, value] of corruptions) {
      const root = await directory();
      await secret(root, name, value);
      await expect(
        readApiSecretFilesFromDirectory(root),
      ).rejects.toBeInstanceOf(ApiSecretFilesError);
    }
  });
});
