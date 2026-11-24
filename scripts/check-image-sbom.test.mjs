import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ImageSbomValidationError,
  validateImageSbom,
  validateImageSbomFile,
} from "./check-image-sbom.mjs";

function safeSbom() {
  return {
    bomFormat: "CycloneDX",
    components: [
      { name: "@seu-renave/api", type: "library", version: "1.0.0" },
    ],
    metadata: {
      component: {
        "bom-ref": "root-image",
        name: "/scan/image.tar",
        type: "container",
        version: `sha256:${"a".repeat(64)}`,
      },
    },
    serialNumber: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    specVersion: "1.7",
  };
}

function codeFor(value) {
  try {
    validateImageSbom(value);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof ImageSbomValidationError);
    return error.code;
  }
}

test("aceita CycloneDX da imagem e retorna somente a contagem", () => {
  assert.deepEqual(validateImageSbom(safeSbom()), { componentCount: 1 });
});

for (const [name, mutate, expected] of [
  ["formato", (value) => (value.bomFormat = "SPDX"), "SBOM_FORMAT_INVALID"],
  [
    "versão",
    (value) => (value.specVersion = "1.6"),
    "SBOM_SPEC_VERSION_INVALID",
  ],
  [
    "serial",
    (value) => (value.serialNumber = "fixture"),
    "SBOM_SERIAL_NUMBER_INVALID",
  ],
  [
    "raiz",
    (value) => delete value.metadata.component,
    "SBOM_ROOT_COMPONENT_MISSING",
  ],
  [
    "tipo",
    (value) => (value.metadata.component.type = "application"),
    "SBOM_ROOT_TYPE_INVALID",
  ],
  [
    "fonte",
    (value) => (value.metadata.component.name = "/workspace"),
    "SBOM_SOURCE_INVALID",
  ],
  [
    "referência",
    (value) => (value.metadata.component["bom-ref"] = ""),
    "SBOM_ROOT_REFERENCE_INVALID",
  ],
  [
    "versão da raiz",
    (value) => (value.metadata.component.version = "latest"),
    "SBOM_ROOT_VERSION_INVALID",
  ],
  ["componentes", (value) => (value.components = []), "SBOM_COMPONENTS_EMPTY"],
]) {
  test(`recusa ${name} inválido`, () => {
    const value = safeSbom();
    mutate(value);
    assert.equal(codeFor(value), expected);
  });
}

for (const sensitive of [
  "-----BEGIN PRIVATE KEY-----",
  "AKIA1234567890ABCDEF",
  "RENAVE_RELEASE_SENTINEL_DO_NOT_SHIP",
  "postgresql://operator:secret@example.invalid/database",
]) {
  test(`recusa conteúdo sensível: ${sensitive.slice(0, 12)}`, () => {
    const value = safeSbom();
    value.components[0].description = sensitive;
    assert.equal(codeFor(value), "SBOM_SENSITIVE_CONTENT_FORBIDDEN");
  });
}

test("valida arquivo, calcula hash e não retorna o documento", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "renave-sbom-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, "image.cdx.json");
  await writeFile(file, JSON.stringify(safeSbom()), "utf8");
  const result = await validateImageSbomFile(file);
  assert.equal(result.componentCount, 1);
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(result).sort(), ["componentCount", "sha256"]);
});

test("recusa JSON inválido e arquivo vazio", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "renave-sbom-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const invalid = path.join(directory, "invalid.json");
  const empty = path.join(directory, "empty.json");
  await writeFile(invalid, "{", "utf8");
  await writeFile(empty, "", "utf8");
  await assert.rejects(
    validateImageSbomFile(invalid),
    (error) => error.code === "SBOM_JSON_INVALID",
  );
  await assert.rejects(
    validateImageSbomFile(empty),
    (error) => error.code === "SBOM_FILE_SIZE_INVALID",
  );
});
