import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_SBOM_BYTES = 20 * 1024 * 1024;
const UUID_URN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const FORBIDDEN_CONTENT = [
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu,
  /AKIA[0-9A-Z]{16}/u,
  /RENAVE_RELEASE_SENTINEL_DO_NOT_SHIP/u,
  /postgres(?:ql)?:\/\/[^\s"'@/:]+:[^\s"'@/]+@/iu,
];

export class ImageSbomValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ImageSbomValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ImageSbomValidationError(code);
}

export function validateImageSbom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SBOM_DOCUMENT_INVALID");
  }
  if (value.bomFormat !== "CycloneDX") fail("SBOM_FORMAT_INVALID");
  if (value.specVersion !== "1.7") fail("SBOM_SPEC_VERSION_INVALID");
  if (
    typeof value.serialNumber !== "string" ||
    !UUID_URN.test(value.serialNumber)
  ) {
    fail("SBOM_SERIAL_NUMBER_INVALID");
  }

  const component = value.metadata?.component;
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    fail("SBOM_ROOT_COMPONENT_MISSING");
  }
  if (component.type !== "container") fail("SBOM_ROOT_TYPE_INVALID");
  if (component.name !== "/scan/image.tar") fail("SBOM_SOURCE_INVALID");
  if (
    typeof component["bom-ref"] !== "string" ||
    component["bom-ref"].length === 0 ||
    component["bom-ref"].length > 256
  ) {
    fail("SBOM_ROOT_REFERENCE_INVALID");
  }
  if (
    typeof component.version !== "string" ||
    !SHA256.test(component.version)
  ) {
    fail("SBOM_ROOT_VERSION_INVALID");
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    fail("SBOM_COMPONENTS_EMPTY");
  }

  const serialized = JSON.stringify(value);
  if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(serialized))) {
    fail("SBOM_SENSITIVE_CONTENT_FORBIDDEN");
  }
  return Object.freeze({ componentCount: value.components.length });
}

export async function validateImageSbomFile(file) {
  const bytes = await readFile(file);
  if (bytes.length === 0 || bytes.length > MAX_SBOM_BYTES) {
    fail("SBOM_FILE_SIZE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("SBOM_JSON_INVALID");
  }
  const summary = validateImageSbom(value);
  return Object.freeze({
    ...summary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    console.error("Uso: node scripts/check-image-sbom.mjs <sbom.cdx.json>");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await validateImageSbomFile(file);
    console.log(
      `SBOM CycloneDX válido: componentes=${result.componentCount} sha256=${result.sha256}`,
    );
  } catch (error) {
    const code =
      error instanceof ImageSbomValidationError
        ? error.code
        : "SBOM_FILE_READ_FAILED";
    console.error(`SBOM inválido: ${code}`);
    process.exitCode = 1;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await main();
}
