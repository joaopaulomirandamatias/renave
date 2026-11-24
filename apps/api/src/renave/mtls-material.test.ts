import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRenaveMtlsMaterial,
  RenaveMtlsMaterialReadError,
} from "./mtls-material.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function materialDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "renave-mtls-material-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("readRenaveMtlsMaterial", () => {
  it("lê os três arquivos sem transformar o conteúdo", async () => {
    const directory = await materialDirectory();
    const paths = {
      caFile: join(directory, "ca.pem"),
      certificateFile: join(directory, "cert.pem"),
      keyFile: join(directory, "key.pem"),
    };
    await Promise.all([
      writeFile(paths.caFile, "CA"),
      writeFile(paths.certificateFile, "CERT"),
      writeFile(paths.keyFile, "KEY"),
    ]);
    await Promise.all(Object.values(paths).map((path) => chmod(path, 0o400)));

    await expect(readRenaveMtlsMaterial(paths)).resolves.toEqual({
      ca: "CA",
      cert: "CERT",
      key: "KEY",
    });
  });

  it("oculta o caminho do secret quando a leitura falha", async () => {
    const directory = await materialDirectory();
    const secretPath = join(directory, "segredo-certificado.pem");

    let error: unknown;
    try {
      await readRenaveMtlsMaterial({
        caFile: secretPath,
        certificateFile: secretPath,
        keyFile: secretPath,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RenaveMtlsMaterialReadError);
    expect(error).toMatchObject({
      code: "RENAVE_MTLS_MATERIAL_UNAVAILABLE",
    });
    expect(String(error)).not.toContain(secretPath);
  });

  it("recusa symlink, permissão ampla e conteúdo acima do limite", async () => {
    const directory = await materialDirectory();
    const target = join(directory, "target.pem");
    await writeFile(target, "SECRET");
    await chmod(target, 0o400);
    const link = join(directory, "link.pem");
    await symlink("target.pem", link);
    await expect(
      readRenaveMtlsMaterial({
        caFile: link,
        certificateFile: link,
        keyFile: link,
      }),
    ).rejects.toBeInstanceOf(RenaveMtlsMaterialReadError);

    const broad = join(directory, "broad.pem");
    await writeFile(broad, "SECRET");
    await chmod(broad, 0o444);
    await expect(
      readRenaveMtlsMaterial({
        caFile: broad,
        certificateFile: broad,
        keyFile: broad,
      }),
    ).rejects.toBeInstanceOf(RenaveMtlsMaterialReadError);

    const huge = join(directory, "huge.pem");
    await writeFile(huge, "x".repeat(64 * 1_024 + 1));
    await chmod(huge, 0o400);
    await expect(
      readRenaveMtlsMaterial({
        caFile: huge,
        certificateFile: huge,
        keyFile: huge,
      }),
    ).rejects.toBeInstanceOf(RenaveMtlsMaterialReadError);
  });
});
