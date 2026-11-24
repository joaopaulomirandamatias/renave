import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { OperationPromoterError } from "./errors.js";

export const OPERATION_PROMOTER_SECRET_DIRECTORY =
  "/run/secrets/seu-renave/operation-promoter";

const FILES = Object.freeze({
  ca: ["database-ca.pem", 256 * 1_024],
  databaseUrl: ["database-url", 4 * 1_024],
  decision: ["promotion-decision.json", 32 * 1_024],
  keyring: ["decision-keyring.json", 64 * 1_024],
  target: ["target.json", 4 * 1_024],
} as const);

export interface OperationPromoterFiles {
  ca: Buffer;
  databaseUrl: Buffer;
  decision: Buffer;
  destroy(): void;
  keyring: Buffer;
  target: Buffer;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function confined(root: string, target: string): boolean {
  return target === root || inside(root, target);
}

function allowedOwnership(metadata: Stats): boolean {
  const mode = metadata.mode & 0o777;
  const uid = process.getuid?.();
  const groups = new Set([
    process.getgid?.(),
    ...(process.getgroups?.() ?? []),
  ]);
  return (
    (mode === 0o400 && (uid === undefined || metadata.uid === uid)) ||
    (mode === 0o440 && groups.has(metadata.gid))
  );
}

async function resolvedParentsAreSafeDirectories(
  root: string,
  target: string,
): Promise<boolean> {
  let current = dirname(target);
  while (current !== root) {
    if (!inside(root, current)) return false;
    const metadata = await lstat(current).catch(() => undefined);
    if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      return false;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return true;
}

async function resolveConfinedSymlinks(
  root: string,
  entry: string,
): Promise<string | undefined> {
  let current = root;
  const pending = relative(root, entry).split(sep);
  let followedLinks = 0;

  while (pending.length > 0) {
    const component = pending.shift();
    if (!component || component === ".") continue;
    const candidate = resolve(current, component);
    if (!confined(root, candidate)) return undefined;
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata) return undefined;

    if (metadata.isSymbolicLink()) {
      followedLinks += 1;
      if (followedLinks > 16) return undefined;
      const link = await readlink(candidate).catch(() => "");
      if (!link) return undefined;
      const destination = resolve(dirname(candidate), link);
      if (!confined(root, destination)) return undefined;
      pending.unshift(...relative(root, destination).split(sep));
      current = root;
      continue;
    }

    if (pending.length > 0 && !metadata.isDirectory()) return undefined;
    current = candidate;
  }

  return current;
}

async function readBounded(
  root: string,
  name: string,
  maximumBytes: number,
): Promise<Buffer> {
  const entry = join(root, name);
  const entryMetadata = await lstat(entry).catch(() => undefined);
  if (
    !entryMetadata ||
    (!entryMetadata.isFile() && !entryMetadata.isSymbolicLink())
  ) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const confinedTarget = await resolveConfinedSymlinks(root, entry);
  const target = confinedTarget ? await realpath(entry).catch(() => "") : "";
  const targetMetadata = target
    ? await lstat(target).catch(() => undefined)
    : undefined;
  if (
    !target ||
    target !== confinedTarget ||
    !inside(root, target) ||
    !(await resolvedParentsAreSafeDirectories(root, target)) ||
    !targetMetadata?.isFile() ||
    targetMetadata.isSymbolicLink()
  ) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let output: Buffer | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== targetMetadata.dev ||
      metadata.ino !== targetMetadata.ino ||
      !allowedOwnership(metadata) ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
    }
    output = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < output.byteLength) {
      const { bytesRead } = await handle.read(
        output,
        offset,
        output.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== output.byteLength || output.includes(0)) {
      throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
    }
    const result = output;
    output = undefined;
    return result;
  } catch (error) {
    if (error instanceof OperationPromoterError) throw error;
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  } finally {
    output?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function readOperationPromoterFiles(
  directory = OPERATION_PROMOTER_SECRET_DIRECTORY,
): Promise<OperationPromoterFiles> {
  const requested = resolve(directory);
  if (!isAbsolute(directory) || requested !== directory) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const rootEntry = await lstat(requested).catch(() => undefined);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const root = await realpath(requested).catch(() => "");
  const metadata = root ? await stat(root).catch(() => undefined) : undefined;
  if (
    root !== requested ||
    !metadata?.isDirectory() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const buffers: Buffer[] = [];
  try {
    for (const [name, maximum] of Object.values(FILES)) {
      buffers.push(await readBounded(root, name, maximum));
    }
    const [ca, databaseUrl, decision, keyring, target] = buffers as [
      Buffer,
      Buffer,
      Buffer,
      Buffer,
      Buffer,
    ];
    let destroyed = false;
    return Object.freeze({
      ca,
      databaseUrl,
      decision,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const buffer of buffers) buffer.fill(0);
      },
      keyring,
      target,
    });
  } catch (error) {
    for (const buffer of buffers) buffer.fill(0);
    if (error instanceof OperationPromoterError) throw error;
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
}
