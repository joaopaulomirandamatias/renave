import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseStockEntryKeyBundle,
  type StockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import { StockEntryProvisioningError } from "./errors.js";

export const STOCK_ENTRY_PROVISIONING_SECRET_DIRECTORY =
  "/run/secrets/seu-renave/stock-entry-provisioning";

const FILES = Object.freeze({
  bundle: "keys.json",
  databaseCa: "database-ca.pem",
});

function inside(root: string, target: string): boolean {
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

async function readBounded(
  root: string,
  file: string,
  maximumBytes: number,
  optional: boolean,
  sensitive: boolean,
): Promise<string | undefined> {
  const entry = join(root, file);
  let entryMetadata;
  try {
    entryMetadata = await lstat(entry);
  } catch (error) {
    if (optional && missing(error)) return undefined;
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  }
  if (!entryMetadata.isFile() && !entryMetadata.isSymbolicLink()) {
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  }
  const target = await realpath(entry).catch(() => "");
  if (!target || !inside(root, target)) {
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    const permissionsAllowed = sensitive
      ? permissions === 0o400 || permissions === 0o440
      : permissions === 0o400 || permissions === 0o440 || permissions === 0o444;
    if (
      !metadata.isFile() ||
      !permissionsAllowed ||
      metadata.size < 1 ||
      metadata.size > maximumBytes + 2
    ) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    bytes = Buffer.alloc(maximumBytes + 3);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes + 2) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumBytes
    ) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    return value;
  } catch (error) {
    if (error instanceof StockEntryProvisioningError) throw error;
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export interface StockEntryProvisioningSecrets {
  bundle: StockEntryKeyBundle;
  databaseCa: string | undefined;
}

export async function readStockEntryProvisioningSecrets(
  directory = STOCK_ENTRY_PROVISIONING_SECRET_DIRECTORY,
): Promise<StockEntryProvisioningSecrets> {
  try {
    if (!isAbsolute(directory)) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    const requested = resolve(directory);
    const rootEntry = await lstat(requested);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    const root = await realpath(requested);
    const metadata = await stat(root);
    const permissions = metadata.mode & 0o777;
    const currentUid = process.getuid?.();
    if (
      root !== requested ||
      !metadata.isDirectory() ||
      (permissions & 0o022) !== 0 ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    const [bundleJson, databaseCa] = await Promise.all([
      readBounded(root, FILES.bundle, 64 * 1_024, false, true),
      readBounded(root, FILES.databaseCa, 256 * 1_024, true, false),
    ]);
    return Object.freeze({
      bundle: parseStockEntryKeyBundle(bundleJson!),
      databaseCa,
    });
  } catch (error) {
    if (error instanceof StockEntryProvisioningError) throw error;
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  }
}
