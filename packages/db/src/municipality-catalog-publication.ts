import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MIN_MUNICIPALITIES = 5_000;
const MAX_MUNICIPALITIES = 10_000;
const MAX_MUNICIPALITY_NAME_LENGTH = 256;
const MAX_APPROVAL_REFERENCE_LENGTH = 256;
const SHA256 = /^[0-9a-f]{64}$/u;
const MUNICIPALITY_ID = /^[1-9][0-9]{6}$/u;
const OFFICIAL_SOURCE_URL =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/municipios";
const ARTIFACT_FORMAT = "renave-municipality-code-lf-v1";
const RELEASE_PREFIX = "renave-municipios-v1-";

const MUNICIPALITY_UFS = new Set([
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SP",
  "SC",
  "SE",
  "TO",
]);

const SENTINELS = new Set([1_501_402, 2_611_533, 5_101_837, 3_303_807]);

export class MunicipalityCatalogSnapshotInvalidError extends Error {
  readonly code = "MUNICIPALITY_CATALOG_SNAPSHOT_INVALID";

  constructor() {
    super("O snapshot municipal RENAVE é inválido.");
    this.name = "MunicipalityCatalogSnapshotInvalidError";
  }
}

export interface VerifiedMunicipalityCatalogSnapshot {
  readonly artifactSha256: string;
  readonly codes: readonly number[];
  readonly manifestSha256: string;
  readonly observedAt: string;
  readonly rowCount: number;
  readonly sourceSha256: string;
  readonly version: string;
}

function invalid(): never {
  throw new MunicipalityCatalogSnapshotInvalidError();
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const present = Object.keys(record);
  if (
    present.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) {
    invalid();
  }
  return record;
}

function strictUtf8(bytes: Uint8Array, maximum: number): string {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximum ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    invalid();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  }
}

function parseJson(bytes: Uint8Array, maximum: number): unknown {
  try {
    return JSON.parse(strictUtf8(bytes, maximum));
  } catch (error) {
    if (error instanceof MunicipalityCatalogSnapshotInvalidError) throw error;
    return invalid();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/\p{C}/u.test(value)
  );
}

function parseManifest(value: unknown) {
  const manifest = exactObject(value, [
    "schemaVersion",
    "source",
    "artifact",
    "release",
    "provenance",
  ]);
  const source = exactObject(manifest.source, [
    "kind",
    "environment",
    "url",
    "observedAt",
    "sha256",
  ]);
  const artifact = exactObject(manifest.artifact, [
    "format",
    "rowCount",
    "sha256",
  ]);
  const release = exactObject(manifest.release, ["version"]);
  const provenance = exactObject(manifest.provenance, [
    "captureToolDigest",
    "approvalReference",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    source.kind !== "RENAVE_MUNICIPIOS" ||
    source.environment !== "homologation" ||
    source.url !== OFFICIAL_SOURCE_URL ||
    !canonicalUtc(source.observedAt) ||
    typeof source.sha256 !== "string" ||
    !SHA256.test(source.sha256) ||
    artifact.format !== ARTIFACT_FORMAT ||
    !Number.isSafeInteger(artifact.rowCount) ||
    (artifact.rowCount as number) < MIN_MUNICIPALITIES ||
    (artifact.rowCount as number) > MAX_MUNICIPALITIES ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256) ||
    typeof release.version !== "string" ||
    release.version !== `${RELEASE_PREFIX}${source.sha256}` ||
    typeof provenance.captureToolDigest !== "string" ||
    !SHA256.test(provenance.captureToolDigest) ||
    !safeText(provenance.approvalReference, MAX_APPROVAL_REFERENCE_LENGTH)
  ) {
    invalid();
  }
  return {
    artifactSha256: artifact.sha256,
    observedAt: source.observedAt,
    rowCount: artifact.rowCount as number,
    sourceSha256: source.sha256,
    version: release.version,
  };
}

function parseMunicipalities(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < MIN_MUNICIPALITIES ||
    value.length > MAX_MUNICIPALITIES
  ) {
    invalid();
  }
  const codes = new Set<number>();
  const sentinels = new Set<number>();
  for (const item of value) {
    const municipality = exactObject(item, ["id", "nome", "uf"]);
    if (
      typeof municipality.id !== "string" ||
      !MUNICIPALITY_ID.test(municipality.id) ||
      !safeText(municipality.nome, MAX_MUNICIPALITY_NAME_LENGTH) ||
      typeof municipality.uf !== "string" ||
      !MUNICIPALITY_UFS.has(municipality.uf)
    ) {
      invalid();
    }
    const code = Number(municipality.id);
    if (
      !Number.isSafeInteger(code) ||
      code > 2_147_483_647 ||
      codes.has(code)
    ) {
      invalid();
    }
    codes.add(code);
    if (SENTINELS.has(code)) sentinels.add(code);
  }
  if (sentinels.size !== SENTINELS.size) invalid();
  return [...codes].sort((left, right) => left - right);
}

export function verifyMunicipalityCatalogSnapshot(input: {
  expectedManifestSha256: string;
  manifestBytes: Uint8Array;
  sourceBytes: Uint8Array;
}): VerifiedMunicipalityCatalogSnapshot {
  try {
    if (
      typeof input?.expectedManifestSha256 !== "string" ||
      !SHA256.test(input.expectedManifestSha256) ||
      sha256(input.manifestBytes) !== input.expectedManifestSha256
    ) {
      invalid();
    }
    const manifest = parseManifest(
      parseJson(input.manifestBytes, MAX_MANIFEST_BYTES),
    );
    if (sha256(input.sourceBytes) !== manifest.sourceSha256) invalid();
    const codes = parseMunicipalities(
      parseJson(input.sourceBytes, MAX_SOURCE_BYTES),
    );
    const artifact = Buffer.from(
      codes.map((code) => `${String(code)}\n`).join(""),
      "utf8",
    );
    const artifactSha256 = sha256(artifact);
    if (
      codes.length !== manifest.rowCount ||
      artifactSha256 !== manifest.artifactSha256
    ) {
      artifact.fill(0);
      invalid();
    }
    artifact.fill(0);
    return Object.freeze({
      artifactSha256,
      codes: Object.freeze(codes),
      manifestSha256: input.expectedManifestSha256,
      observedAt: manifest.observedAt,
      rowCount: manifest.rowCount,
      sourceSha256: manifest.sourceSha256,
      version: manifest.version,
    });
  } catch (error) {
    if (error instanceof MunicipalityCatalogSnapshotInvalidError) throw error;
    invalid();
  }
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  if (typeof path !== "string" || path.length === 0) invalid();
  let handle;
  let bytes: Buffer | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) {
      invalid();
    }
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) invalid();
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(overflowProbe, 0, 1, before.size);
    overflowProbe.fill(0);
    const after = await handle.stat();
    if (
      overflow.bytesRead !== 0 ||
      !after.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      invalid();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof MunicipalityCatalogSnapshotInvalidError) throw error;
    return invalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function verifyMunicipalityCatalogSnapshotFiles(input: {
  expectedManifestSha256: string;
  manifestPath: string;
  sourcePath: string;
}): Promise<VerifiedMunicipalityCatalogSnapshot> {
  let manifestBytes: Buffer | undefined;
  let sourceBytes: Buffer | undefined;
  try {
    manifestBytes = await readBoundedFile(
      input?.manifestPath,
      MAX_MANIFEST_BYTES,
    );
    sourceBytes = await readBoundedFile(input?.sourcePath, MAX_SOURCE_BYTES);
    return verifyMunicipalityCatalogSnapshot({
      expectedManifestSha256: input.expectedManifestSha256,
      manifestBytes,
      sourceBytes,
    });
  } finally {
    manifestBytes?.fill(0);
    sourceBytes?.fill(0);
  }
}

export const municipalityCatalogSnapshotContract = Object.freeze({
  artifactFormat: ARTIFACT_FORMAT,
  maximumManifestBytes: MAX_MANIFEST_BYTES,
  maximumSourceBytes: MAX_SOURCE_BYTES,
  sourceUrl: OFFICIAL_SOURCE_URL,
});
