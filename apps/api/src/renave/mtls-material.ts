import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type RenaveMtlsMaterialField = "ca" | "cert" | "key";

export class RenaveMtlsMaterialReadError extends Error {
  readonly code = "RENAVE_MTLS_MATERIAL_UNAVAILABLE";

  constructor(readonly field: RenaveMtlsMaterialField) {
    super(`Material mTLS indisponível: ${field}`);
    this.name = "RenaveMtlsMaterialReadError";
  }
}

async function readMaterialFile(
  path: string,
  field: RenaveMtlsMaterialField,
): Promise<string> {
  const maximumBytes = field === "ca" ? 256 * 1_024 : 64 * 1_024;
  let handle;
  try {
    if (!isAbsolute(path)) throw new RenaveMtlsMaterialReadError(field);
    const before = await lstat(path);
    if (!before.isFile()) throw new RenaveMtlsMaterialReadError(field);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino ||
      (permissions !== 0o400 && permissions !== 0o440) ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new RenaveMtlsMaterialReadError(field);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
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
      if (offset > maximumBytes) throw new RenaveMtlsMaterialReadError(field);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
      if (!value || value.includes("\0")) {
        throw new RenaveMtlsMaterialReadError(field);
      }
      return value;
    } finally {
      buffer.fill(0);
    }
  } catch {
    throw new RenaveMtlsMaterialReadError(field);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readRenaveMtlsMaterial(paths: {
  caFile: string;
  certificateFile: string;
  keyFile: string;
}): Promise<{ ca: string; cert: string; key: string }> {
  const [ca, cert, key] = await Promise.all([
    readMaterialFile(paths.caFile, "ca"),
    readMaterialFile(paths.certificateFile, "cert"),
    readMaterialFile(paths.keyFile, "key"),
  ]);
  return { ca, cert, key };
}
