import { readFile } from "node:fs/promises";

export type RenaveMtlsMaterialField = "ca" | "cert" | "key";

export class RenaveMtlsMaterialReadError extends Error {
  readonly code = "RENAVE_MTLS_MATERIAL_UNAVAILABLE";

  constructor(readonly field: RenaveMtlsMaterialField) {
    super(`Material mTLS indisponível: ${field}`);
    this.name = "RenaveMtlsMaterialReadError";
  }
}

async function readMaterialFile(
  path: string,
  field: RenaveMtlsMaterialField,
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new RenaveMtlsMaterialReadError(field);
  }
}

export async function readRenaveMtlsMaterial(paths: {
  caFile: string;
  certificateFile: string;
  keyFile: string;
}): Promise<{ ca: string; cert: string; key: string }> {
  const [ca, cert, key] = await Promise.all([
    readMaterialFile(paths.caFile, "ca"),
    readMaterialFile(paths.certificateFile, "cert"),
    readMaterialFile(paths.keyFile, "key"),
  ]);
  return { ca, cert, key };
}
