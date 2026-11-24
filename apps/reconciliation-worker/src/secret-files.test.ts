import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECONCILIATION_WORKER_SECRET_DIRECTORY,
  readReconciliationWorkerSecretFilesFromDirectory,
  ReconciliationWorkerSecretFilesError,
} from "./secret-files.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "renave-worker-secrets-"));
  directories.push(result);
  return result;
}

async function writeRequired(root: string): Promise<void> {
  await Promise.all([
    writeFile(
      join(root, "database-url"),
      "postgres://worker:redacted@db/renave\n",
    ),
    writeFile(join(root, "projection-keys.json"), '{"key-1":"value"}\n'),
    writeFile(join(root, "limiter-hmac-key"), "hmac-value\n"),
    writeFile(
      join(root, "mtls-ca.pem"),
      "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
    ),
    writeFile(
      join(root, "mtls-cert.pem"),
      "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n",
    ),
    writeFile(
      join(root, "mtls-key.pem"),
      "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
    ),
  ]);
  await Promise.all([
    chmod(join(root, "database-url"), 0o400),
    chmod(join(root, "projection-keys.json"), 0o400),
    chmod(join(root, "limiter-hmac-key"), 0o400),
    chmod(join(root, "mtls-ca.pem"), 0o444),
    chmod(join(root, "mtls-cert.pem"), 0o444),
    chmod(join(root, "mtls-key.pem"), 0o400),
  ]);
}

async function replaceSensitive(
  root: string,
  name: string,
  value: string | Buffer,
): Promise<void> {
  const path = join(root, name);
  await chmod(path, 0o600);
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

describe("arquivos secretos do worker", () => {
  it("mantém o diretório operacional fixo e não configurável", () => {
    expect(RECONCILIATION_WORKER_SECRET_DIRECTORY).toBe(
      "/run/secrets/seu-renave/reconciliation-worker",
    );
  });

  it("lê arquivos regulares com um único newline final controlado", async () => {
    const root = await directory();
    await writeRequired(root);
    await writeFile(join(root, "database-ca.pem"), "database-ca\n");
    await writeFile(join(root, "mtls-passphrase"), "passphrase\r\n");
    await chmod(join(root, "database-ca.pem"), 0o444);
    await chmod(join(root, "mtls-passphrase"), 0o400);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(root),
    ).resolves.toMatchObject({
      databaseCa: "database-ca",
      databaseUrl: "postgres://worker:redacted@db/renave",
      limiterHmacKeyBase64: "hmac-value",
      mtlsKeyPassphrase: "passphrase",
      projectionKeysJson: '{"key-1":"value"}',
    });
  });

  it("aceita symlink atômico somente para alvo regular dentro do mount", async () => {
    const root = await directory();
    await writeRequired(root);
    const version = join(root, "..data-2026-11-24");
    await mkdir(version);
    await writeFile(
      join(version, "database-url"),
      "postgres://worker@db/renave",
    );
    await chmod(join(version, "database-url"), 0o400);
    await rm(join(root, "database-url"));
    await symlink("..data-2026-11-24", join(root, "..data"));
    await symlink("..data/database-url", join(root, "database-url"));
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(root),
    ).resolves.toMatchObject({ databaseUrl: "postgres://worker@db/renave" });
  });

  it("recusa symlink externo, diretório, limite excedido e whitespace ambíguo", async () => {
    const outside = await directory();
    await writeFile(join(outside, "secret"), "outside-secret");

    for (const corrupt of [
      async (root: string) => {
        await rm(join(root, "database-url"));
        await symlink(join(outside, "secret"), join(root, "database-url"));
      },
      async (root: string) => {
        await rm(join(root, "database-url"));
        await mkdir(join(root, "database-url"));
      },
      async (root: string) => {
        await writeFile(join(root, "mtls-passphrase"), "x".repeat(4_097));
        await chmod(join(root, "mtls-passphrase"), 0o400);
      },
      async (root: string) => {
        await replaceSensitive(root, "limiter-hmac-key", " value\n");
      },
      async (root: string) => {
        await replaceSensitive(root, "limiter-hmac-key", "value\n\n");
      },
    ]) {
      const root = await directory();
      await writeRequired(root);
      await corrupt(root);
      const error = await readReconciliationWorkerSecretFilesFromDirectory(root)
        .then(() => undefined)
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(ReconciliationWorkerSecretFilesError);
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain(outside);
      expect(String(error)).not.toContain("outside-secret");
    }
  });

  it("aceita exatamente o limite e recusa o byte seguinte", async () => {
    const exact = await directory();
    await writeRequired(exact);
    await writeFile(join(exact, "mtls-passphrase"), "x".repeat(4_096));
    await chmod(join(exact, "mtls-passphrase"), 0o400);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(exact),
    ).resolves.toMatchObject({ mtlsKeyPassphrase: "x".repeat(4_096) });

    const exceeded = await directory();
    await writeRequired(exceeded);
    await writeFile(join(exceeded, "mtls-passphrase"), "x".repeat(4_097));
    await chmod(join(exceeded, "mtls-passphrase"), 0o400);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(exceeded),
    ).rejects.toBeInstanceOf(ReconciliationWorkerSecretFilesError);
  });

  it("recusa obrigatório ausente, NUL e UTF-8 inválido sem revelar conteúdo", async () => {
    for (const corrupt of [
      async (root: string) => rm(join(root, "mtls-key.pem")),
      async (root: string) =>
        replaceSensitive(root, "limiter-hmac-key", Buffer.from("value\0tail")),
      async (root: string) =>
        replaceSensitive(root, "limiter-hmac-key", Buffer.from([0xff, 0xfe])),
    ]) {
      const root = await directory();
      await writeRequired(root);
      await corrupt(root);
      const error = await readReconciliationWorkerSecretFilesFromDirectory(root)
        .then(() => undefined)
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(ReconciliationWorkerSecretFilesError);
      expect(String(error)).toBe(
        "ReconciliationWorkerSecretFilesError: Os arquivos secretos do worker de reconciliação são inválidos",
      );
      expect(String(error)).not.toContain(root);
    }
  });

  it("valida permissões no arquivo final após resolver o symlink", async () => {
    const valid = await directory();
    await writeRequired(valid);
    await chmod(join(valid, "database-url"), 0o440);
    await chmod(join(valid, "mtls-cert.pem"), 0o444);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(valid),
    ).resolves.toMatchObject({
      databaseUrl: "postgres://worker:redacted@db/renave",
    });

    const worldReadableSecret = await directory();
    await writeRequired(worldReadableSecret);
    await chmod(join(worldReadableSecret, "database-url"), 0o444);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(worldReadableSecret),
    ).rejects.toBeInstanceOf(ReconciliationWorkerSecretFilesError);

    const writableCertificate = await directory();
    await writeRequired(writableCertificate);
    await chmod(join(writableCertificate, "mtls-cert.pem"), 0o464);
    await expect(
      readReconciliationWorkerSecretFilesFromDirectory(writableCertificate),
    ).rejects.toBeInstanceOf(ReconciliationWorkerSecretFilesError);
  });
});
