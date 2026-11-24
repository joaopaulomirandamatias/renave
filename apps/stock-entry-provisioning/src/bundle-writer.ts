import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
  serializeStockEntryKeyBundle,
  type StockEntryKeyRandomBytes,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import { provisioningError, StockEntryProvisioningError } from "./errors.js";

export const STOCK_ENTRY_BUNDLE_FILE_NAME = "keys.json";
const MAXIMUM_BUNDLE_BYTES = 64 * 1_024;

export interface GeneratedBundleReceipt {
  fingerprintHex: string;
  generationId: string;
}

export interface BundleWriterFilesystem {
  chmod: typeof chmod;
  link: typeof link;
  lstat: typeof lstat;
  open: typeof open;
  realpath: typeof realpath;
  stat: typeof stat;
  unlink: typeof unlink;
}

/** @internal Exportado para testes de falha após a publicação atômica. */
export const nodeBundleWriterFilesystem: BundleWriterFilesystem = Object.freeze(
  {
    chmod,
    link,
    lstat,
    open,
    realpath,
    stat,
    unlink,
  },
);

async function hasGitMarker(
  path: string,
  filesystem: BundleWriterFilesystem,
): Promise<boolean> {
  let current = path;
  for (;;) {
    try {
      await filesystem.lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") {
        throw new StockEntryProvisioningError("BUNDLE_OUTPUT_INSECURE");
      }
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return false;
    current = parent;
  }
}

async function secureOutputDirectory(
  directory: string,
  filesystem: BundleWriterFilesystem,
): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new StockEntryProvisioningError("BUNDLE_OUTPUT_INSECURE");
  }
  const normalized = resolve(directory);
  let root: string;
  try {
    root = await filesystem.realpath(normalized);
  } catch {
    throw new StockEntryProvisioningError("BUNDLE_OUTPUT_INSECURE");
  }
  if (root !== normalized || (await hasGitMarker(root, filesystem))) {
    throw new StockEntryProvisioningError("BUNDLE_OUTPUT_INSECURE");
  }
  const metadata = await filesystem.stat(root);
  const permissions = metadata.mode & 0o777;
  const currentUid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    (permissions & 0o022) !== 0 ||
    (currentUid !== undefined && metadata.uid !== currentUid)
  ) {
    throw new StockEntryProvisioningError("BUNDLE_OUTPUT_INSECURE");
  }
  return root;
}

function outputExists(error: unknown): boolean {
  try {
    return (error as { code?: unknown })?.code === "EEXIST";
  } catch {
    return false;
  }
}

async function syncDirectory(
  directory: string,
  filesystem: BundleWriterFilesystem,
): Promise<void> {
  const handle = await filesystem.open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyPublishedDestination(
  destination: string,
  expected: Buffer,
  filesystem: BundleWriterFilesystem,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  let observed: Buffer | undefined;
  try {
    handle = await filesystem.open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o400 ||
      metadata.size !== expected.byteLength
    ) {
      return false;
    }
    observed = Buffer.alloc(expected.byteLength + 1);
    let offset = 0;
    while (offset < observed.byteLength) {
      const { bytesRead } = await handle.read(
        observed,
        offset,
        observed.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return (
      offset === expected.byteLength &&
      timingSafeEqual(expected, observed.subarray(0, expected.byteLength))
    );
  } catch {
    return false;
  } finally {
    observed?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Publica o bundle por hard link para que um destino existente jamais seja
 * substituído. O temporário reside no mesmo filesystem do arquivo final.
 */
export async function generateBundleFile(input: {
  generationId: string;
  outputDirectory: string;
  random?: StockEntryKeyRandomBytes;
  /** @internal Injeção usada apenas para provar falhas pós-publicação. */
  filesystem?: BundleWriterFilesystem;
}): Promise<GeneratedBundleReceipt> {
  const filesystem = input.filesystem ?? nodeBundleWriterFilesystem;
  const directory = await secureOutputDirectory(
    input.outputDirectory,
    filesystem,
  );
  const destination = join(directory, STOCK_ENTRY_BUNDLE_FILE_NAME);
  const temporary = join(
    directory,
    `.${STOCK_ENTRY_BUNDLE_FILE_NAME}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let bundle: ReturnType<typeof generateStockEntryKeyBundle> | undefined;
  let payload: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let temporaryCreated = false;
  try {
    bundle = generateStockEntryKeyBundle(input.generationId, input.random);
    payload = Buffer.from(`${serializeStockEntryKeyBundle(bundle)}\n`, "utf8");
    if (payload.byteLength < 2 || payload.byteLength > MAXIMUM_BUNDLE_BYTES) {
      throw new StockEntryProvisioningError("BUNDLE_GENERATION_FAILED");
    }
    try {
      handle = await filesystem.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      await handle.writeFile(payload);
      await handle.sync();
      await handle.chmod(0o400);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await filesystem.link(temporary, destination);
      published = true;
    } catch (error) {
      if (outputExists(error)) {
        throw new StockEntryProvisioningError("BUNDLE_OUTPUT_EXISTS");
      }
      throw error;
    }
    const receipt = Object.freeze({
      fingerprintHex: bundle.digests.fingerprint.toString("hex"),
      generationId: bundle.digests.generationId,
    });
    try {
      await filesystem.unlink(temporary);
      temporaryCreated = false;
      await filesystem.chmod(destination, 0o400);
      await syncDirectory(directory, filesystem);
      return receipt;
    } catch {
      const valid = await verifyPublishedDestination(
        destination,
        payload,
        filesystem,
      );
      if (published && valid) {
        throw new StockEntryProvisioningError(
          "BUNDLE_PUBLISHED_DURABILITY_UNCERTAIN",
        );
      }
      throw new StockEntryProvisioningError("BUNDLE_GENERATION_FAILED");
    }
  } catch (error) {
    throw provisioningError(error, "BUNDLE_GENERATION_FAILED");
  } finally {
    payload?.fill(0);
    destroyStockEntryKeyBundle(bundle);
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await filesystem.unlink(temporary).catch(() => undefined);
    }
  }
}
