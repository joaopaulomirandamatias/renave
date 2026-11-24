import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const INITIAL_KEY_IDS = Object.freeze({
  establishmentEmailEncryption: "email-encryption-v1",
  establishmentEmailHmac: "email-hmac-v1",
  operatorCpfEncryption: "operator-encryption-v1",
  operatorCpfHmac: "operator-hmac-v1",
  projection: "projection-v1",
  request: "request-v1",
});

export interface StockEntryKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface StockEntryKeyBundle {
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

/** Nome histórico mantido para os consumidores existentes da API. */
export type StockEntrySecretBundle = StockEntryKeyBundle;

export class StockEntryKeyBundleError extends Error {
  override name = "StockEntrySecretBundleError";

  constructor() {
    super("O bundle criptográfico da entrada de estoque é inválido.");
  }
}

interface SerializedKeyring {
  activeKeyId: string;
  keys: Record<string, string>;
}

interface SerializedStockEntryKeyBundle {
  schemaVersion: 1;
  operatorCpf: {
    encryption: SerializedKeyring;
    hmac: SerializedKeyring;
  };
  establishmentEmail: {
    encryption: SerializedKeyring;
    hmac: SerializedKeyring;
  };
  request: SerializedKeyring;
  projection: SerializedKeyring;
  digests: {
    actor: string;
    generationId: string;
    idempotency: string;
    vehicle: string;
  };
  limiterHmacKey: string;
}

/** @internal Test seam. Production callers must omit the RNG argument. */
export type StockEntryKeyRandomBytes = (size: number) => Uint8Array;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  const actual = Object.keys(value).sort(asciiCompare);
  const required = [...expected].sort(asciiCompare);
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
    throw new StockEntryKeyBundleError();
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== value) {
    key.fill(0);
    throw new StockEntryKeyBundleError();
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
    asciiCompare(left, right),
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
    throw new StockEntryKeyBundleError();
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(value.keys)) {
    if (!KEY_ID.test(keyId)) throw new StockEntryKeyBundleError();
    keys.set(keyId, decodeCollected(encoded, collected));
  }
  if (!keys.has(value.activeKeyId)) throw new StockEntryKeyBundleError();
  return { activeKeyId: value.activeKeyId, keys };
}

function parsePrincipalPurpose(
  value: unknown,
  collected: Buffer[],
): { encryption: StockEntryKeyring; hmac: StockEntryKeyring } {
  if (!plainRecord(value) || !exactKeys(value, ["encryption", "hmac"])) {
    throw new StockEntryKeyBundleError();
  }
  return {
    encryption: parseKeyring(value.encryption, collected),
    hmac: parseKeyring(value.hmac, collected),
  };
}

function assertDistinct(keys: readonly Buffer[]): void {
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      if (timingSafeEqual(keys[left]!, keys[right]!)) {
        throw new StockEntryKeyBundleError();
      }
    }
  }
}

export function destroyStockEntryKeyBundle(
  bundle: StockEntryKeyBundle | undefined,
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

export function parseStockEntryKeyBundle(text: string): StockEntryKeyBundle {
  const collected: Buffer[] = [];
  let fingerprint: Buffer | undefined;
  try {
    let source: unknown;
    try {
      source = JSON.parse(text) as unknown;
    } catch {
      throw new StockEntryKeyBundleError();
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
      throw new StockEntryKeyBundleError();
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
    assertDistinct(collected);
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
    return Object.freeze({
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
    });
  } catch (error) {
    fingerprint?.fill(0);
    for (const key of collected) key.fill(0);
    if (error instanceof StockEntryKeyBundleError) throw error;
    throw new StockEntryKeyBundleError();
  }
}

function copyRandomKey(
  random: StockEntryKeyRandomBytes,
  collected: Buffer[],
): Buffer {
  let source: Uint8Array;
  try {
    source = random(KEY_BYTES);
  } catch {
    throw new StockEntryKeyBundleError();
  }
  if (!(source instanceof Uint8Array)) {
    throw new StockEntryKeyBundleError();
  }
  try {
    if (source.byteLength !== KEY_BYTES) {
      throw new StockEntryKeyBundleError();
    }
    const key = Buffer.from(source);
    collected.push(key);
    return key;
  } finally {
    source.fill(0);
  }
}

function keyring(keyId: string, key: Buffer): StockEntryKeyring {
  return { activeKeyId: keyId, keys: new Map([[keyId, key]]) };
}

export function generateStockEntryKeyBundle(
  generationId: string,
  /** @internal Test seam. Production callers must use the default CSPRNG. */
  random: StockEntryKeyRandomBytes = randomBytes,
): StockEntryKeyBundle {
  if (typeof generationId !== "string" || !GENERATION_ID.test(generationId)) {
    throw new StockEntryKeyBundleError();
  }
  const collected: Buffer[] = [];
  let fingerprint: Buffer | undefined;
  try {
    const operatorCpf = {
      encryption: keyring(
        INITIAL_KEY_IDS.operatorCpfEncryption,
        copyRandomKey(random, collected),
      ),
      hmac: keyring(
        INITIAL_KEY_IDS.operatorCpfHmac,
        copyRandomKey(random, collected),
      ),
    };
    const establishmentEmail = {
      encryption: keyring(
        INITIAL_KEY_IDS.establishmentEmailEncryption,
        copyRandomKey(random, collected),
      ),
      hmac: keyring(
        INITIAL_KEY_IDS.establishmentEmailHmac,
        copyRandomKey(random, collected),
      ),
    };
    const request = keyring(
      INITIAL_KEY_IDS.request,
      copyRandomKey(random, collected),
    );
    const projection = keyring(
      INITIAL_KEY_IDS.projection,
      copyRandomKey(random, collected),
    );
    const actor = copyRandomKey(random, collected);
    const idempotency = copyRandomKey(random, collected);
    const vehicle = copyRandomKey(random, collected);
    const limiterHmacKey = copyRandomKey(random, collected);
    assertDistinct(collected);
    fingerprint = runtimeKeyGenerationFingerprint({
      actor,
      establishmentEmail,
      generationId,
      idempotency,
      limiter: limiterHmacKey,
      operatorCpf,
      projection,
      request,
      vehicle,
    });
    return Object.freeze({
      operatorCpf,
      establishmentEmail,
      request,
      projection,
      digests: {
        actor,
        fingerprint,
        generationId,
        idempotency,
        vehicle,
      },
      limiterHmacKey,
    });
  } catch (error) {
    fingerprint?.fill(0);
    for (const key of collected) key.fill(0);
    if (error instanceof StockEntryKeyBundleError) throw error;
    throw new StockEntryKeyBundleError();
  }
}

function serializeKeyring(keyringValue: StockEntryKeyring): SerializedKeyring {
  if (
    !KEY_ID.test(keyringValue.activeKeyId) ||
    keyringValue.keys.size < 1 ||
    !keyringValue.keys.has(keyringValue.activeKeyId)
  ) {
    throw new StockEntryKeyBundleError();
  }
  const keys: Record<string, string> = {};
  for (const [keyId, key] of [...keyringValue.keys.entries()].sort(
    ([left], [right]) => asciiCompare(left, right),
  )) {
    if (!KEY_ID.test(keyId) || key.byteLength !== KEY_BYTES) {
      throw new StockEntryKeyBundleError();
    }
    keys[keyId] = key.toString("base64");
  }
  return { activeKeyId: keyringValue.activeKeyId, keys };
}

export function serializeStockEntryKeyBundle(
  bundle: StockEntryKeyBundle,
): string {
  if (!GENERATION_ID.test(bundle.digests.generationId)) {
    throw new StockEntryKeyBundleError();
  }
  const serialized: SerializedStockEntryKeyBundle = {
    schemaVersion: 1,
    operatorCpf: {
      encryption: serializeKeyring(bundle.operatorCpf.encryption),
      hmac: serializeKeyring(bundle.operatorCpf.hmac),
    },
    establishmentEmail: {
      encryption: serializeKeyring(bundle.establishmentEmail.encryption),
      hmac: serializeKeyring(bundle.establishmentEmail.hmac),
    },
    request: serializeKeyring(bundle.request),
    projection: serializeKeyring(bundle.projection),
    digests: {
      actor: bundle.digests.actor.toString("base64"),
      generationId: bundle.digests.generationId,
      idempotency: bundle.digests.idempotency.toString("base64"),
      vehicle: bundle.digests.vehicle.toString("base64"),
    },
    limiterHmacKey: bundle.limiterHmacKey.toString("base64"),
  };
  const reparsed = parseStockEntryKeyBundle(JSON.stringify(serialized));
  try {
    if (
      !timingSafeEqual(reparsed.digests.fingerprint, bundle.digests.fingerprint)
    ) {
      throw new StockEntryKeyBundleError();
    }
  } finally {
    destroyStockEntryKeyBundle(reparsed);
  }
  return JSON.stringify(serialized);
}
