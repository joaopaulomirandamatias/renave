import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import {
  destroyStockEntryKeyBundle,
  parseStockEntryKeyBundle,
  StockEntryKeyBundleError,
  type StockEntryKeyBundle,
  type StockEntryKeyring,
} from "@seu-renave/protected-evidence";

export const STOCK_ENTRY_SECRET_BUNDLE_PATH =
  "/run/secrets/seu-renave/api-stock-entry/keys.json";

const MAXIMUM_BUNDLE_BYTES = 64 * 1_024;

export type StockEntrySecretBundle = StockEntryKeyBundle;
export type { StockEntryKeyring };

/** Nomes públicos históricos mantidos para os consumidores da API. */
export const StockEntrySecretBundleError = StockEntryKeyBundleError;
export const destroyStockEntrySecretBundle = destroyStockEntryKeyBundle;
export const parseStockEntrySecretBundle = parseStockEntryKeyBundle;

function safelyInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

export async function readStockEntrySecretBundle(): Promise<StockEntrySecretBundle> {
  return readStockEntrySecretBundleFromPath(STOCK_ENTRY_SECRET_BUNDLE_PATH);
}

/** @internal Exportado apenas para testes de filesystem com caminho efêmero. */
export async function readStockEntrySecretBundleFromPath(
  path: string,
): Promise<StockEntrySecretBundle> {
  let handle;
  let bytes: Buffer | undefined;
  try {
    if (!isAbsolute(path)) throw new StockEntryKeyBundleError();
    const root = await realpath(dirname(path));
    const rootMetadata = await stat(root);
    if (!rootMetadata.isDirectory()) throw new StockEntryKeyBundleError();
    const entryMetadata = await lstat(path);
    if (!entryMetadata.isFile() && !entryMetadata.isSymbolicLink()) {
      throw new StockEntryKeyBundleError();
    }
    const target = await realpath(path);
    if (!safelyInside(root, target)) throw new StockEntryKeyBundleError();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      (permissions !== 0o400 && permissions !== 0o440) ||
      metadata.size < 2 ||
      metadata.size > MAXIMUM_BUNDLE_BYTES + 1
    ) {
      throw new StockEntryKeyBundleError();
    }
    bytes = Buffer.alloc(MAXIMUM_BUNDLE_BYTES + 2);
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
    if (offset > MAXIMUM_BUNDLE_BYTES + 1) {
      throw new StockEntryKeyBundleError();
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw new StockEntryKeyBundleError();
    }
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (
      text.length === 0 ||
      text.includes("\0") ||
      Buffer.byteLength(text, "utf8") > MAXIMUM_BUNDLE_BYTES
    ) {
      throw new StockEntryKeyBundleError();
    }
    return parseStockEntryKeyBundle(text);
  } catch (error) {
    if (error instanceof StockEntryKeyBundleError) throw error;
    throw new StockEntryKeyBundleError();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
