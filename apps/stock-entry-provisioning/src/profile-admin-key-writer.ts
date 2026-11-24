import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";

import {
  nodeBundleWriterFilesystem,
  secureOutputDirectory,
  syncDirectory,
  type BundleWriterFilesystem,
} from "./bundle-writer.js";
import { provisioningError, StockEntryProvisioningError } from "./errors.js";
import {
  destroyProfileAdminMasterKey,
  generateProfileAdminMasterKey,
  serializeProfileAdminMasterKey,
} from "./profile-admin-key.js";

export const PROFILE_ADMIN_KEY_FILE_NAME = "profile-admin-key.json";

function exists(error: unknown): boolean {
  try {
    return (error as { code?: unknown })?.code === "EEXIST";
  } catch {
    return false;
  }
}

/** Publicação no-overwrite por hard link, no mesmo filesystem do destino. */
export async function generateProfileAdminKeyFile(input: {
  keyId: string;
  outputDirectory: string;
  random?: (size: number) => Uint8Array;
  /** @internal seam de teste. */
  filesystem?: BundleWriterFilesystem;
}): Promise<{ keyId: string }> {
  const filesystem = input.filesystem ?? nodeBundleWriterFilesystem;
  const directory = await secureOutputDirectory(
    input.outputDirectory,
    filesystem,
  );
  const destination = join(directory, PROFILE_ADMIN_KEY_FILE_NAME);
  const temporary = join(
    directory,
    `.${PROFILE_ADMIN_KEY_FILE_NAME}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let master: ReturnType<typeof generateProfileAdminMasterKey> | undefined;
  let payload: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof filesystem.open>> | undefined;
  let published = false;
  let temporaryCreated = false;
  try {
    master = generateProfileAdminMasterKey(input.keyId, input.random);
    payload = Buffer.from(
      `${serializeProfileAdminMasterKey(master)}\n`,
      "utf8",
    );
    handle = await filesystem.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    await handle.writeFile(payload);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await filesystem.link(temporary, destination);
      published = true;
    } catch (error) {
      if (exists(error))
        throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_EXISTS");
      throw error;
    }
    await filesystem.unlink(temporary);
    temporaryCreated = false;
    await filesystem.chmod(destination, 0o400);
    await syncDirectory(directory, filesystem);
    return Object.freeze({ keyId: master.keyId });
  } catch (error) {
    if (published && !(error instanceof StockEntryProvisioningError)) {
      throw new StockEntryProvisioningError(
        "PROFILE_ADMIN_KEY_PUBLISHED_DURABILITY_UNCERTAIN",
      );
    }
    throw provisioningError(error, "PROFILE_ADMIN_KEY_GENERATION_FAILED");
  } finally {
    payload?.fill(0);
    destroyProfileAdminMasterKey(master);
    await handle?.close().catch(() => undefined);
    if (temporaryCreated)
      await filesystem.unlink(temporary).catch(() => undefined);
  }
}
