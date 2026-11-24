import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const RECONCILIATION_WORKER_SECRET_DIRECTORY =
  "/run/secrets/seu-renave/reconciliation-worker";

const SECRET_FILES = Object.freeze({
  databaseCa: "database-ca.pem",
  databaseUrl: "database-url",
  limiterHmacKeyBase64: "limiter-hmac-key",
  mtlsCa: "mtls-ca.pem",
  mtlsCertificate: "mtls-cert.pem",
  mtlsKey: "mtls-key.pem",
  mtlsKeyPassphrase: "mtls-passphrase",
  projectionKeysJson: "projection-keys.json",
});

const LIMITS = Object.freeze({
  databaseCa: 256 * 1_024,
  databaseUrl: 4_096,
  limiterHmacKeyBase64: 256,
  mtlsCa: 256 * 1_024,
  mtlsCertificate: 64 * 1_024,
  mtlsKey: 64 * 1_024,
  mtlsKeyPassphrase: 4_096,
  projectionKeysJson: 64 * 1_024,
});

export interface ReconciliationWorkerSecretFiles {
  databaseCa: string | undefined;
  databaseUrl: string;
  limiterHmacKeyBase64: string;
  mtlsCa: string;
  mtlsCertificate: string;
  mtlsKey: string;
  mtlsKeyPassphrase: string | undefined;
  projectionKeysJson: string;
}

export class ReconciliationWorkerSecretFilesError extends Error {
  override name = "ReconciliationWorkerSecretFilesError";

  constructor() {
    super("Os arquivos secretos do worker de reconciliação são inválidos");
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

function normalizeText(
  bytes: Uint8Array,
  allowEmbeddedNewlines: boolean,
): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReconciliationWorkerSecretFilesError();
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    /^\s|\s$/u.test(value) ||
    (!allowEmbeddedNewlines && /[\r\n]/u.test(value))
  ) {
    throw new ReconciliationWorkerSecretFilesError();
  }
  return value;
}

async function readBoundedFile(
  root: string,
  name: string,
  maximumBytes: number,
  allowEmbeddedNewlines: boolean,
  optional: boolean,
  visibility: "public" | "sensitive",
): Promise<string | undefined> {
  const entry = join(root, name);
  let entryMetadata;
  try {
    entryMetadata = await lstat(entry);
  } catch (error) {
    if (optional && missing(error)) return undefined;
    throw new ReconciliationWorkerSecretFilesError();
  }
  if (!entryMetadata.isFile() && !entryMetadata.isSymbolicLink()) {
    throw new ReconciliationWorkerSecretFilesError();
  }

  let target: string;
  try {
    target = await realpath(entry);
  } catch {
    throw new ReconciliationWorkerSecretFilesError();
  }
  if (!safelyInside(root, target)) {
    throw new ReconciliationWorkerSecretFilesError();
  }

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    const allowedPermissions =
      visibility === "sensitive"
        ? permissions === 0o400 || permissions === 0o440
        : permissions === 0o400 ||
          permissions === 0o440 ||
          permissions === 0o444;
    if (
      !metadata.isFile() ||
      !allowedPermissions ||
      metadata.size > maximumBytes + 2
    ) {
      throw new ReconciliationWorkerSecretFilesError();
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
      if (offset > maximumBytes + 2) {
        throw new ReconciliationWorkerSecretFilesError();
      }
      const value = normalizeText(
        buffer.subarray(0, offset),
        allowEmbeddedNewlines,
      );
      if (Buffer.byteLength(value, "utf8") > maximumBytes) {
        throw new ReconciliationWorkerSecretFilesError();
      }
      return value;
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof ReconciliationWorkerSecretFilesError) throw error;
    throw new ReconciliationWorkerSecretFilesError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Leitura usada pelo processo. O diretório é fixo e não pode ser escolhido por
 * variável de ambiente. Symlinks atômicos são aceitos apenas se resolverem para
 * um arquivo regular dentro do próprio mount de secrets.
 */
export async function readReconciliationWorkerSecretFiles(): Promise<ReconciliationWorkerSecretFiles> {
  return readReconciliationWorkerSecretFilesFromDirectory(
    RECONCILIATION_WORKER_SECRET_DIRECTORY,
  );
}

/** @internal Exportado apenas para testes de filesystem com diretório efêmero. */
export async function readReconciliationWorkerSecretFilesFromDirectory(
  directory: string,
): Promise<ReconciliationWorkerSecretFiles> {
  try {
    if (!isAbsolute(directory)) {
      throw new ReconciliationWorkerSecretFilesError();
    }
    const root = await realpath(directory);
    const rootMetadata = await stat(root);
    if (!rootMetadata.isDirectory()) {
      throw new ReconciliationWorkerSecretFilesError();
    }
    const [
      databaseCa,
      databaseUrl,
      limiterHmacKeyBase64,
      mtlsCa,
      mtlsCertificate,
      mtlsKey,
      mtlsKeyPassphrase,
      projectionKeysJson,
    ] = await Promise.all([
      readBoundedFile(
        root,
        SECRET_FILES.databaseCa,
        LIMITS.databaseCa,
        true,
        true,
        "public",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.databaseUrl,
        LIMITS.databaseUrl,
        false,
        false,
        "sensitive",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.limiterHmacKeyBase64,
        LIMITS.limiterHmacKeyBase64,
        false,
        false,
        "sensitive",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.mtlsCa,
        LIMITS.mtlsCa,
        true,
        false,
        "public",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.mtlsCertificate,
        LIMITS.mtlsCertificate,
        true,
        false,
        "public",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.mtlsKey,
        LIMITS.mtlsKey,
        true,
        false,
        "sensitive",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.mtlsKeyPassphrase,
        LIMITS.mtlsKeyPassphrase,
        false,
        true,
        "sensitive",
      ),
      readBoundedFile(
        root,
        SECRET_FILES.projectionKeysJson,
        LIMITS.projectionKeysJson,
        true,
        false,
        "sensitive",
      ),
    ]);
    return Object.freeze({
      databaseCa,
      databaseUrl: databaseUrl!,
      limiterHmacKeyBase64: limiterHmacKeyBase64!,
      mtlsCa: mtlsCa!,
      mtlsCertificate: mtlsCertificate!,
      mtlsKey: mtlsKey!,
      mtlsKeyPassphrase,
      projectionKeysJson: projectionKeysJson!,
    });
  } catch (error) {
    if (error instanceof ReconciliationWorkerSecretFilesError) throw error;
    throw new ReconciliationWorkerSecretFilesError();
  }
}
