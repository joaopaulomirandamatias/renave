import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const API_SECRET_DIRECTORY = "/run/secrets/seu-renave/api";

const SECRET_FILES = Object.freeze({
  databaseCa: "database-ca.pem",
  databaseUrl: "database-url",
  platformReaderDatabaseCa: "platform-reader-database-ca.pem",
  platformReaderDatabaseUrl: "platform-reader-database-url",
  evidenceKeyringJson: "evidence-keyring.json",
  identityDatabaseCa: "identity-database-ca.pem",
  identityDatabaseUrl: "identity-database-url",
  loginRateLimitHmacKeyBase64: "login-rate-limit-hmac-key",
  mtlsCa: "mtls-ca.pem",
  mtlsCertificate: "mtls-cert.pem",
  mtlsKey: "mtls-key.pem",
  mtlsKeyPassphrase: "mtls-passphrase",
  oidcClientSecret: "oidc-client-secret",
  platformOperatorHmacKeyBase64: "platform-operator-hmac-key",
  serproQueryLimitHmacKeyBase64: "serpro-query-limit-hmac-key",
  tenantAdminHmacKeyBase64: "tenant-admin-hmac-key",
});

const LIMITS = Object.freeze({
  databaseCa: 256 * 1_024,
  databaseUrl: 4_096,
  platformReaderDatabaseCa: 256 * 1_024,
  platformReaderDatabaseUrl: 4_096,
  evidenceKeyringJson: 16 * 1_024,
  identityDatabaseCa: 256 * 1_024,
  identityDatabaseUrl: 4_096,
  loginRateLimitHmacKeyBase64: 256,
  mtlsCa: 256 * 1_024,
  mtlsCertificate: 64 * 1_024,
  mtlsKey: 64 * 1_024,
  mtlsKeyPassphrase: 4_096,
  oidcClientSecret: 4_096,
  platformOperatorHmacKeyBase64: 256,
  serproQueryLimitHmacKeyBase64: 256,
  tenantAdminHmacKeyBase64: 256,
});

export interface ApiSecretFiles {
  databaseCa: string | undefined;
  databaseUrl: string | undefined;
  platformReaderDatabaseCa: string | undefined;
  platformReaderDatabaseUrl: string | undefined;
  evidenceKeyringJson: string | undefined;
  identityDatabaseCa: string | undefined;
  identityDatabaseUrl: string | undefined;
  loginRateLimitHmacKeyBase64: string | undefined;
  mtlsCa: string | undefined;
  mtlsCertificate: string | undefined;
  mtlsKey: string | undefined;
  mtlsKeyPassphrase: string | undefined;
  oidcClientSecret: string | undefined;
  platformOperatorHmacKeyBase64: string | undefined;
  serproQueryLimitHmacKeyBase64: string | undefined;
  tenantAdminHmacKeyBase64: string | undefined;
}

export class ApiSecretFilesError extends Error {
  override name = "ApiSecretFilesError";

  constructor() {
    super("Os arquivos secretos da API são inválidos");
  }
}

function safelyInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function missing(error: unknown): boolean {
  try {
    return (error as { code?: unknown })?.code === "ENOENT";
  } catch {
    return false;
  }
}

function normalizeText(bytes: Uint8Array, allowEmbeddedNewlines: boolean) {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiSecretFilesError();
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    /^\s|\s$/u.test(value) ||
    (!allowEmbeddedNewlines && /[\r\n]/u.test(value))
  ) {
    throw new ApiSecretFilesError();
  }
  return value;
}

async function readBoundedFile(
  root: string,
  name: string,
  maximumBytes: number,
  allowEmbeddedNewlines: boolean,
): Promise<Readonly<{ target: string; value: string }> | undefined> {
  const entry = join(root, name);
  let entryMetadata;
  try {
    entryMetadata = await lstat(entry);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ApiSecretFilesError();
  }
  if (!entryMetadata.isFile()) throw new ApiSecretFilesError();

  let target: string;
  try {
    target = await realpath(entry);
  } catch {
    throw new ApiSecretFilesError();
  }
  if (!safelyInside(root, target)) throw new ApiSecretFilesError();

  let handle;
  try {
    const before = await stat(target);
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      metadata.dev !== entryMetadata.dev ||
      metadata.ino !== entryMetadata.ino ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino ||
      (permissions !== 0o400 && permissions !== 0o440) ||
      metadata.size > maximumBytes + 2
    ) {
      throw new ApiSecretFilesError();
    }

    const buffer = Buffer.alloc(maximumBytes + 3);
    let offset = 0;
    try {
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximumBytes + 2) throw new ApiSecretFilesError();
      const value = normalizeText(
        buffer.subarray(0, offset),
        allowEmbeddedNewlines,
      );
      if (Buffer.byteLength(value, "utf8") > maximumBytes) {
        throw new ApiSecretFilesError();
      }
      return Object.freeze({ target, value });
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof ApiSecretFilesError) throw error;
    throw new ApiSecretFilesError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Lê somente o mount fixo da API. Todos os arquivos são opcionais aqui; a
 * composição valida o subconjunto exigido pela capability ativada.
 */
export function readApiSecretFiles(): Promise<ApiSecretFiles> {
  return readApiSecretFilesFromDirectory(API_SECRET_DIRECTORY);
}

/** @internal Exportado exclusivamente para testes de filesystem. */
export async function readApiSecretFilesFromDirectory(
  directory: string,
): Promise<ApiSecretFiles> {
  try {
    if (!isAbsolute(directory)) throw new ApiSecretFilesError();
    const root = await realpath(directory);
    const rootMetadata = await stat(root);
    if (!rootMetadata.isDirectory()) throw new ApiSecretFilesError();
    let snapshotRoot = root;
    const dataLink = join(root, "..data");
    try {
      const linkMetadata = await lstat(dataLink);
      if (!linkMetadata.isSymbolicLink()) throw new ApiSecretFilesError();
      const resolved = await realpath(dataLink);
      const resolvedMetadata = await stat(resolved);
      if (!safelyInside(root, resolved) || !resolvedMetadata.isDirectory()) {
        throw new ApiSecretFilesError();
      }
      snapshotRoot = resolved;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const reads = await Promise.all(
      (Object.keys(SECRET_FILES) as Array<keyof typeof SECRET_FILES>).map(
        async (
          field,
        ): Promise<
          readonly [
            keyof typeof SECRET_FILES,
            Readonly<{ target: string; value: string }> | undefined,
          ]
        > =>
          [
            field,
            await readBoundedFile(
              snapshotRoot,
              SECRET_FILES[field],
              LIMITS[field],
              field.endsWith("Ca") ||
                field === "mtlsCertificate" ||
                field === "mtlsKey" ||
                field === "evidenceKeyringJson",
            ),
          ] as const,
      ),
    );
    const present = reads.filter(
      (
        entry,
      ): entry is readonly [
        keyof typeof SECRET_FILES,
        Readonly<{ target: string; value: string }>,
      ] => entry[1] !== undefined,
    );
    const snapshotDirectories = new Set(
      present.map(([, read]) => dirname(read.target)),
    );
    if (
      snapshotDirectories.size > 1 ||
      (snapshotDirectories.size === 1 && !snapshotDirectories.has(snapshotRoot))
    ) {
      throw new ApiSecretFilesError();
    }
    return Object.freeze(
      Object.fromEntries(reads.map(([field, read]) => [field, read?.value])),
    ) as unknown as ApiSecretFiles;
  } catch (error) {
    if (error instanceof ApiSecretFilesError) throw error;
    throw new ApiSecretFilesError();
  }
}
