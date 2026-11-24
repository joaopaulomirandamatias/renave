import { createHmac, hkdfSync, randomBytes } from "node:crypto";

import { StockEntryProvisioningError } from "./errors.js";

const KEY_BYTES = 32;
// Reserva espaço para o maior sufixo derivado (`.idempotency`) sem exceder
// o limite de 64 caracteres aceito pelo contrato do banco.
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,50}$/u;

export interface ProfileAdminMasterKey {
  key: Buffer;
  keyId: string;
}

export interface ProfileAdminDerivedKeys {
  actor: Buffer;
  evidence: Buffer;
  idempotency: Buffer;
  keyIds: Readonly<{
    actor: string;
    evidence: string;
    idempotency: string;
  }>;
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
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== value) {
    key.fill(0);
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  return key;
}

export function parseProfileAdminMasterKey(
  text: string,
): ProfileAdminMasterKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  if (
    !plainRecord(parsed) ||
    !exactKeys(parsed, ["schemaVersion", "keyId", "key"]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.keyId !== "string" ||
    !KEY_ID.test(parsed.keyId)
  ) {
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  return Object.freeze({ key: decodeKey(parsed.key), keyId: parsed.keyId });
}

export function generateProfileAdminMasterKey(
  keyId: string,
  random: (size: number) => Uint8Array = randomBytes,
): ProfileAdminMasterKey {
  if (!KEY_ID.test(keyId))
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  const source = random(KEY_BYTES);
  if (!(source instanceof Uint8Array) || source.byteLength !== KEY_BYTES) {
    throw new StockEntryProvisioningError(
      "PROFILE_ADMIN_KEY_GENERATION_FAILED",
    );
  }
  try {
    return Object.freeze({ key: Buffer.from(source), keyId });
  } finally {
    source.fill(0);
  }
}

export function serializeProfileAdminMasterKey(
  master: ProfileAdminMasterKey,
): string {
  if (!KEY_ID.test(master.keyId) || master.key.byteLength !== KEY_BYTES) {
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  return JSON.stringify({
    schemaVersion: 1,
    keyId: master.keyId,
    key: master.key.toString("base64"),
  });
}

export function destroyProfileAdminMasterKey(
  master: ProfileAdminMasterKey | undefined,
): void {
  master?.key.fill(0);
}

function derive(master: Buffer, domain: string): Buffer {
  const salt = Buffer.from("seu-renave/profile-admin/hkdf/v1", "utf8");
  const info = Buffer.from(domain, "utf8");
  try {
    return Buffer.from(hkdfSync("sha256", master, salt, info, KEY_BYTES));
  } finally {
    salt.fill(0);
    info.fill(0);
  }
}

export function deriveProfileAdminKeys(
  master: ProfileAdminMasterKey,
): ProfileAdminDerivedKeys {
  if (!KEY_ID.test(master.keyId) || master.key.byteLength !== KEY_BYTES) {
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  }
  let actor: Buffer | undefined;
  let evidence: Buffer | undefined;
  let idempotency: Buffer | undefined;
  try {
    actor = derive(master.key, "actor-digest/v1");
    evidence = derive(master.key, "evidence-digest/v1");
    idempotency = derive(master.key, "idempotency-digest/v1");
    return Object.freeze({
      actor,
      evidence,
      idempotency,
      keyIds: Object.freeze({
        actor: `${master.keyId}.actor`,
        evidence: `${master.keyId}.evidence`,
        idempotency: `${master.keyId}.idempotency`,
      }),
    });
  } catch (error) {
    actor?.fill(0);
    evidence?.fill(0);
    idempotency?.fill(0);
    throw error;
  }
}

export function destroyProfileAdminDerivedKeys(
  keys: ProfileAdminDerivedKeys | undefined,
): void {
  keys?.actor.fill(0);
  keys?.evidence.fill(0);
  keys?.idempotency.fill(0);
}

/** HMAC de campos length-prefixed, sem concatenações ambíguas. */
export function profileAdminDigest(
  key: Buffer,
  domain: string,
  fields: readonly string[],
): Buffer {
  if (key.byteLength !== KEY_BYTES || !domain)
    throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
  const hmac = createHmac("sha256", key);
  for (const field of [domain, ...fields]) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    try {
      length.writeUInt32BE(value.byteLength);
      hmac.update(length).update(value);
    } finally {
      length.fill(0);
      value.fill(0);
    }
  }
  return hmac.digest();
}
