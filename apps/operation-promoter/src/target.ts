import { X509Certificate } from "node:crypto";

import { OperationPromoterError } from "./errors.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|[0-9a-f:]+)$/u;
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

export interface OperationPromoterTarget {
  database: Readonly<{ host: string; name: string; port: number }>;
  decisionKeyringDigest: Buffer;
  environment: "homologation" | "production";
  executorWorkloadDigest: Buffer;
  logicalDatabaseId: string;
}

export interface ValidatedDatabaseConfig {
  ca: string;
  connectionString: string;
  servername: string;
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
}

export function parseOperationPromoterTarget(
  bytes: Uint8Array,
): OperationPromoterTarget {
  let value: unknown;
  try {
    value = JSON.parse(text(bytes)) as unknown;
  } catch {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  if (
    !plain(value) ||
    !exact(value, [
      "database",
      "decisionKeyringDigest",
      "environment",
      "executorWorkloadDigest",
      "logicalDatabaseId",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    (value.environment !== "homologation" &&
      value.environment !== "production") ||
    typeof value.logicalDatabaseId !== "string" ||
    !UUID.test(value.logicalDatabaseId) ||
    typeof value.decisionKeyringDigest !== "string" ||
    !BASE64URL_32.test(value.decisionKeyringDigest) ||
    typeof value.executorWorkloadDigest !== "string" ||
    !BASE64URL_32.test(value.executorWorkloadDigest) ||
    !plain(value.database) ||
    !exact(value.database, ["host", "name", "port"]) ||
    typeof value.database.host !== "string" ||
    value.database.host !== value.database.host.toLowerCase() ||
    !HOST.test(value.database.host) ||
    typeof value.database.name !== "string" ||
    !DATABASE_NAME.test(value.database.name) ||
    !Number.isSafeInteger(value.database.port) ||
    (value.database.port as number) < 1 ||
    (value.database.port as number) > 65_535
  ) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const executorWorkloadDigest = Buffer.from(
    value.executorWorkloadDigest,
    "base64url",
  );
  const decisionKeyringDigest = Buffer.from(
    value.decisionKeyringDigest,
    "base64url",
  );
  if (
    executorWorkloadDigest.byteLength !== 32 ||
    executorWorkloadDigest.toString("base64url") !==
      value.executorWorkloadDigest ||
    decisionKeyringDigest.byteLength !== 32 ||
    decisionKeyringDigest.toString("base64url") !== value.decisionKeyringDigest
  ) {
    executorWorkloadDigest.fill(0);
    decisionKeyringDigest.fill(0);
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  return Object.freeze({
    database: Object.freeze({
      host: value.database.host,
      name: value.database.name,
      port: value.database.port as number,
    }),
    decisionKeyringDigest,
    environment: value.environment,
    executorWorkloadDigest,
    logicalDatabaseId: value.logicalDatabaseId,
  });
}

function validateCa(ca: string): void {
  if (/PRIVATE KEY/u.test(ca) || ca.includes("\0")) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const matches = [
    ...ca.matchAll(
      /-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?\r?\n-----END CERTIFICATE-----/gu,
    ),
  ];
  if (matches.length < 1) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  const remainder = ca.replaceAll(
    /-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?\r?\n-----END CERTIFICATE-----/gu,
    "",
  );
  if (remainder.trim() !== "") {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  try {
    for (const match of matches) new X509Certificate(match[0]);
  } catch {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
}

export function validateDatabaseConfig(input: {
  caBytes: Uint8Array;
  databaseUrlBytes: Uint8Array;
  target: OperationPromoterTarget;
}): ValidatedDatabaseConfig {
  const connectionString = text(input.databaseUrlBytes);
  const ca = text(input.caBytes);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  let username: string;
  let password: string;
  let databaseName: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    username !== "renave_operation_promoter" ||
    password.length < 1 ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname.toLowerCase() !== input.target.database.host ||
    url.port === "" ||
    Number(url.port) !== input.target.database.port ||
    databaseName !== input.target.database.name ||
    url.pathname.slice(1).includes("/")
  ) {
    throw new OperationPromoterError("OPERATION_PROMOTER_CONFIG_INVALID");
  }
  validateCa(ca);
  return Object.freeze({
    ca,
    connectionString,
    servername: input.target.database.host,
  });
}
