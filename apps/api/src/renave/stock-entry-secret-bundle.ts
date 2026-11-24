import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

export const STOCK_ENTRY_SECRET_BUNDLE_PATH =
  "/run/secrets/seu-renave/api-stock-entry/keys.json";

const MAXIMUM_BUNDLE_BYTES = 64 * 1_024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface StockEntryKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface StockEntrySecretBundle {
  digests: {
    actor: Buffer;
    fingerprint: Buffer;
    generationId: string;
    idempotency: Buffer;
    vehicle: Buffer;
  };
  establishmentEmail: {
    encryption: StockEntryKeyring;
    hmac: StockEntryKeyring;
  };
  limiterHmacKey: Buffer;
  operatorCpf: {
    encryption: StockEntryKeyring;
    hmac: StockEntryKeyring;
  };
  projection: StockEntryKeyring;
  request: StockEntryKeyring;
}

export class StockEntrySecretBundleError extends Error {
  override name = "StockEntrySecretBundleError";

  constructor() {
    super("O bundle criptográfico da entrada de estoque é inválido.");
  }
}

function safelyInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function decodeKey(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new StockEntrySecretBundleError();
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new StockEntrySecretBundleError();
  }
  return key;
}

function decodeCollected(value: unknown, collected: Buffer[]): Buffer {
  const key = decodeKey(value);
  collected.push(key);
  return key;
}

function hashBytes(
  hash: ReturnType<typeof createHash>,
  value: Uint8Array,
): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  hash.update(length).update(value);
  length.fill(0);
}

function hashText(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  try {
    hashBytes(hash, bytes);
  } finally {
    bytes.fill(0);
  }
}

function hashKeyring(
  hash: ReturnType<typeof createHash>,
  domain: string,
  keyring: StockEntryKeyring,
): void {
  hashText(hash, domain);
  hashText(hash, keyring.activeKeyId);
  const entries = [...keyring.keys.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(entries.length);
  hash.update(count);
  count.fill(0);
  for (const [keyId, key] of entries) {
    hashText(hash, keyId);
    hashBytes(hash, key);
  }
}

function runtimeKeyGenerationFingerprint(input: {
  actor: Buffer;
  establishmentEmail: {
    encryption: StockEntryKeyring;
    hmac: StockEntryKeyring;
  };
  generationId: string;
  idempotency: Buffer;
  limiter: Buffer;
  operatorCpf: {
    encryption: StockEntryKeyring;
    hmac: StockEntryKeyring;
  };
  projection: StockEntryKeyring;
  request: StockEntryKeyring;
  vehicle: Buffer;
}): Buffer {
  const hash = createHash("sha256");
  hashText(hash, "seu-renave-stock-entry-runtime-key-generation-v1");
  hashText(hash, input.generationId);
  hashKeyring(hash, "operator-cpf/encryption", input.operatorCpf.encryption);
  hashKeyring(hash, "operator-cpf/hmac", input.operatorCpf.hmac);
  hashKeyring(
    hash,
    "establishment-email/encryption",
    input.establishmentEmail.encryption,
  );
  hashKeyring(hash, "establishment-email/hmac", input.establishmentEmail.hmac);
  hashKeyring(hash, "operation-request", input.request);
  hashKeyring(hash, "reconciliation-projection", input.projection);
  for (const [domain, key] of [
    ["digest/actor", input.actor],
    ["digest/idempotency", input.idempotency],
    ["digest/vehicle", input.vehicle],
    ["limiter/hmac", input.limiter],
  ] as const) {
    hashText(hash, domain);
    hashBytes(hash, key);
  }
  return hash.digest();
}

function parseKeyring(value: unknown, collected: Buffer[]): StockEntryKeyring {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["activeKeyId", "keys"]) ||
    typeof value.activeKeyId !== "string" ||
    !KEY_ID.test(value.activeKeyId) ||
    !plainRecord(value.keys) ||
    Object.keys(value.keys).length === 0
  ) {
    throw new StockEntrySecretBundleError();
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(value.keys)) {
    if (!KEY_ID.test(keyId)) throw new StockEntrySecretBundleError();
    const key = decodeKey(encoded);
    collected.push(key);
    keys.set(keyId, key);
  }
  if (!keys.has(value.activeKeyId)) throw new StockEntrySecretBundleError();
  return { activeKeyId: value.activeKeyId, keys };
}

function parsePrincipalPurpose(
  value: unknown,
  collected: Buffer[],
): { encryption: StockEntryKeyring; hmac: StockEntryKeyring } {
  if (!plainRecord(value) || !exactKeys(value, ["encryption", "hmac"])) {
    throw new StockEntrySecretBundleError();
  }
  return {
    encryption: parseKeyring(value.encryption, collected),
    hmac: parseKeyring(value.hmac, collected),
  };
}

export function destroyStockEntrySecretBundle(
  bundle: StockEntrySecretBundle | undefined,
): void {
  if (!bundle) return;
  const keys = [
    ...bundle.operatorCpf.encryption.keys.values(),
    ...bundle.operatorCpf.hmac.keys.values(),
    ...bundle.establishmentEmail.encryption.keys.values(),
    ...bundle.establishmentEmail.hmac.keys.values(),
    ...bundle.request.keys.values(),
    ...bundle.projection.keys.values(),
    bundle.digests.actor,
    bundle.digests.fingerprint,
    bundle.digests.idempotency,
    bundle.digests.vehicle,
    bundle.limiterHmacKey,
  ];
  for (const key of keys) key.fill(0);
}

export function parseStockEntrySecretBundle(
  text: string,
): StockEntrySecretBundle {
  const collected: Buffer[] = [];
  let fingerprint: Buffer | undefined;
  try {
    let source: unknown;
    try {
      source = JSON.parse(text) as unknown;
    } catch {
      throw new StockEntrySecretBundleError();
    }
    if (
      !plainRecord(source) ||
      !exactKeys(source, [
        "schemaVersion",
        "operatorCpf",
        "establishmentEmail",
        "request",
        "projection",
        "digests",
        "limiterHmacKey",
      ]) ||
      source.schemaVersion !== 1 ||
      !plainRecord(source.digests) ||
      !exactKeys(source.digests, [
        "actor",
        "generationId",
        "idempotency",
        "vehicle",
      ]) ||
      typeof source.digests.generationId !== "string" ||
      !GENERATION_ID.test(source.digests.generationId)
    ) {
      throw new StockEntrySecretBundleError();
    }
    const actor = decodeCollected(source.digests.actor, collected);
    const idempotency = decodeCollected(source.digests.idempotency, collected);
    const vehicle = decodeCollected(source.digests.vehicle, collected);
    const limiterHmacKey = decodeCollected(source.limiterHmacKey, collected);
    const operatorCpf = parsePrincipalPurpose(source.operatorCpf, collected);
    const establishmentEmail = parsePrincipalPurpose(
      source.establishmentEmail,
      collected,
    );
    const request = parseKeyring(source.request, collected);
    const projection = parseKeyring(source.projection, collected);
    fingerprint = runtimeKeyGenerationFingerprint({
      actor,
      establishmentEmail,
      generationId: source.digests.generationId,
      idempotency,
      limiter: limiterHmacKey,
      operatorCpf,
      projection,
      request,
      vehicle,
    });
    const bundle: StockEntrySecretBundle = {
      operatorCpf,
      establishmentEmail,
      request,
      projection,
      digests: {
        actor,
        fingerprint,
        generationId: source.digests.generationId,
        idempotency,
        vehicle,
      },
      limiterHmacKey,
    };
    for (let left = 0; left < collected.length; left += 1) {
      for (let right = left + 1; right < collected.length; right += 1) {
        if (timingSafeEqual(collected[left]!, collected[right]!)) {
          throw new StockEntrySecretBundleError();
        }
      }
    }
    return Object.freeze(bundle);
  } catch (error) {
    fingerprint?.fill(0);
    for (const key of collected) key.fill(0);
    if (error instanceof StockEntrySecretBundleError) throw error;
    throw new StockEntrySecretBundleError();
  }
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
    if (!isAbsolute(path)) throw new StockEntrySecretBundleError();
    const root = await realpath(dirname(path));
    const rootMetadata = await stat(root);
    if (!rootMetadata.isDirectory()) throw new StockEntrySecretBundleError();
    const entryMetadata = await lstat(path);
    if (!entryMetadata.isFile() && !entryMetadata.isSymbolicLink()) {
      throw new StockEntrySecretBundleError();
    }
    const target = await realpath(path);
    if (!safelyInside(root, target)) throw new StockEntrySecretBundleError();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      (permissions !== 0o400 && permissions !== 0o440) ||
      metadata.size < 2 ||
      metadata.size > MAXIMUM_BUNDLE_BYTES + 1
    ) {
      throw new StockEntrySecretBundleError();
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
      throw new StockEntrySecretBundleError();
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw new StockEntrySecretBundleError();
    }
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (
      text.length === 0 ||
      text.includes("\0") ||
      Buffer.byteLength(text, "utf8") > MAXIMUM_BUNDLE_BYTES
    ) {
      throw new StockEntrySecretBundleError();
    }
    return parseStockEntrySecretBundle(text);
  } catch (error) {
    if (error instanceof StockEntrySecretBundleError) throw error;
    throw new StockEntrySecretBundleError();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
