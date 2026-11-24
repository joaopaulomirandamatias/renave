import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type BundleWriterFilesystem,
  nodeBundleWriterFilesystem,
} from "./bundle-writer.js";
import {
  generateProfileAdminKeyFile,
  PROFILE_ADMIN_KEY_FILE_NAME,
} from "./profile-admin-key-writer.js";
import {
  deriveProfileAdminKeys,
  destroyProfileAdminDerivedKeys,
  destroyProfileAdminMasterKey,
  generateProfileAdminMasterKey,
  parseProfileAdminMasterKey,
  profileAdminDigest,
} from "./profile-admin-key.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "renave-profile-admin-"));
  directories.push(path);
  await chmod(path, 0o700);
  return path;
}

describe("chave mestra administrativa de perfis", () => {
  it("deriva domínios distintos e permite zerar todo material", () => {
    const randomSource = Buffer.alloc(32, 7);
    const master = generateProfileAdminMasterKey(
      "profile-admin-v1",
      () => randomSource,
    );
    expect(randomSource.every((byte) => byte === 0)).toBe(true);
    const keys = deriveProfileAdminKeys(master);
    expect(
      new Set([
        keys.actor.toString("hex"),
        keys.evidence.toString("hex"),
        keys.idempotency.toString("hex"),
      ]).size,
    ).toBe(3);
    const digest = profileAdminDigest(keys.actor, "changed-by/v1", [
      "tenant",
      "actor",
    ]);
    expect(digest).toHaveLength(32);
    digest.fill(0);
    destroyProfileAdminDerivedKeys(keys);
    destroyProfileAdminMasterKey(master);
    expect(keys.actor.every((byte) => byte === 0)).toBe(true);
    expect(keys.evidence.every((byte) => byte === 0)).toBe(true);
    expect(keys.idempotency.every((byte) => byte === 0)).toBe(true);
    expect(master.key.every((byte) => byte === 0)).toBe(true);
  });

  it("publica 0400, parseia e nunca sobrescreve", async () => {
    const root = await directory();
    await generateProfileAdminKeyFile({
      keyId: "profile-admin-v1",
      outputDirectory: root,
      random: (size) => Buffer.alloc(size, 9),
    });
    const path = join(root, PROFILE_ADMIN_KEY_FILE_NAME);
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
    const parsed = parseProfileAdminMasterKey(await readFile(path, "utf8"));
    try {
      expect(parsed.keyId).toBe("profile-admin-v1");
    } finally {
      destroyProfileAdminMasterKey(parsed);
    }
    await expect(
      generateProfileAdminKeyFile({
        keyId: "profile-admin-v2",
        outputDirectory: root,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_ADMIN_KEY_EXISTS" });
  });

  it("não altera destino preexistente", async () => {
    const root = await directory();
    const path = join(root, PROFILE_ADMIN_KEY_FILE_NAME);
    await writeFile(path, "preserve", { mode: 0o400 });
    await expect(
      generateProfileAdminKeyFile({
        keyId: "profile-admin-v1",
        outputDirectory: root,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_ADMIN_KEY_EXISTS" });
    expect(await readFile(path, "utf8")).toBe("preserve");
  });

  it("sinaliza publicação possivelmente concluída após falha de durabilidade", async () => {
    const root = await directory();
    let firstTemporaryUnlink = true;
    const filesystem: BundleWriterFilesystem = {
      ...nodeBundleWriterFilesystem,
      unlink: async (path) => {
        if (firstTemporaryUnlink && String(path).endsWith(".tmp")) {
          firstTemporaryUnlink = false;
          throw new Error("falha injetada");
        }
        return nodeBundleWriterFilesystem.unlink(path);
      },
    };
    await expect(
      generateProfileAdminKeyFile({
        filesystem,
        keyId: "profile-admin-v1",
        outputDirectory: root,
        random: (size) => Buffer.alloc(size, 4),
      }),
    ).rejects.toMatchObject({
      code: "PROFILE_ADMIN_KEY_PUBLISHED_DURABILITY_UNCERTAIN",
    });
    expect(
      (await lstat(join(root, PROFILE_ADMIN_KEY_FILE_NAME))).mode & 0o777,
    ).toBe(0o400);
  });
});
