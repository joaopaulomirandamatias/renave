import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  destroyStockEntrySecretBundle,
  parseStockEntrySecretBundle,
  readStockEntrySecretBundleFromPath,
  StockEntrySecretBundleError,
} from "./stock-entry-secret-bundle.js";

const directories: string[] = [];

function encoded(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    operatorCpf: {
      encryption: {
        activeKeyId: "operator-encryption-v1",
        keys: { "operator-encryption-v1": encoded(1) },
      },
      hmac: {
        activeKeyId: "operator-hmac-v1",
        keys: { "operator-hmac-v1": encoded(2) },
      },
    },
    establishmentEmail: {
      encryption: {
        activeKeyId: "email-encryption-v1",
        keys: { "email-encryption-v1": encoded(3) },
      },
      hmac: {
        activeKeyId: "email-hmac-v1",
        keys: { "email-hmac-v1": encoded(4) },
      },
    },
    request: {
      activeKeyId: "request-v1",
      keys: { "request-v1": encoded(5), "request-v0": encoded(6) },
    },
    projection: {
      activeKeyId: "projection-v1",
      keys: { "projection-v1": encoded(7) },
    },
    digests: {
      actor: encoded(8),
      generationId: "held-local-v1",
      idempotency: encoded(9),
      vehicle: encoded(10),
    },
    limiterHmacKey: encoded(11),
    ...overrides,
  });
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "renave-api-stock-entry-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("bundle secreto da entrada de estoque", () => {
  it("falha fechado quando o arquivo configurado pelo runtime não existe", async () => {
    const root = await directory();
    await expect(
      readStockEntrySecretBundleFromPath(join(root, "keys.json")),
    ).rejects.toMatchObject({
      message: "O bundle criptográfico da entrada de estoque é inválido.",
      name: "StockEntrySecretBundleError",
    });
  });

  it("aceita keyrings históricos e zera todo material decodificado", () => {
    const bundle = parseStockEntrySecretBundle(source());
    expect(bundle.request.activeKeyId).toBe("request-v1");
    expect(bundle.request.keys.size).toBe(2);
    expect(bundle.digests.fingerprint).toHaveLength(32);
    expect(bundle.digests.generationId).toBe("held-local-v1");
    expect(bundle.limiterHmacKey.byteLength).toBe(32);

    destroyStockEntrySecretBundle(bundle);
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
    expect(keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });

  it("recusa campos extras, base64 não canônico e reutilização entre domínios", () => {
    expect(() =>
      parseStockEntrySecretBundle(source({ unexpected: "value" })),
    ).toThrow(StockEntrySecretBundleError);
    expect(() =>
      parseStockEntrySecretBundle(
        source({
          limiterHmacKey: "not-base64",
        }),
      ),
    ).toThrow(StockEntrySecretBundleError);
    expect(() =>
      parseStockEntrySecretBundle(
        source({
          limiterHmacKey: encoded(8),
        }),
      ),
    ).toThrow(StockEntrySecretBundleError);
  });

  it("canonicaliza keyIds e inclui todo o bundle no fingerprint", () => {
    const first = parseStockEntrySecretBundle(source());
    const reordered = parseStockEntrySecretBundle(
      source({
        request: {
          activeKeyId: "request-v1",
          keys: { "request-v0": encoded(6), "request-v1": encoded(5) },
        },
      }),
    );
    const changedLimiter = parseStockEntrySecretBundle(
      source({ limiterHmacKey: encoded(12) }),
    );
    const changedRequest = parseStockEntrySecretBundle(
      source({
        request: {
          activeKeyId: "request-v1",
          keys: { "request-v1": encoded(12), "request-v0": encoded(6) },
        },
      }),
    );
    const changedPrincipal = parseStockEntrySecretBundle(
      source({
        operatorCpf: {
          encryption: {
            activeKeyId: "operator-encryption-v1",
            keys: { "operator-encryption-v1": encoded(12) },
          },
          hmac: {
            activeKeyId: "operator-hmac-v1",
            keys: { "operator-hmac-v1": encoded(2) },
          },
        },
      }),
    );
    const changedProjection = parseStockEntrySecretBundle(
      source({
        projection: {
          activeKeyId: "projection-v1",
          keys: { "projection-v1": encoded(12) },
        },
      }),
    );

    expect(reordered.digests.fingerprint).toEqual(first.digests.fingerprint);
    for (const changed of [
      changedLimiter,
      changedRequest,
      changedPrincipal,
      changedProjection,
    ]) {
      expect(changed.digests.fingerprint).not.toEqual(
        first.digests.fingerprint,
      );
    }
    for (const bundle of [
      first,
      reordered,
      changedLimiter,
      changedRequest,
      changedPrincipal,
      changedProjection,
    ]) {
      destroyStockEntrySecretBundle(bundle);
    }
  });

  it("zera imediatamente os digests já decodificados se o próximo falha", () => {
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      expect(() =>
        parseStockEntrySecretBundle(
          source({
            digests: {
              actor: encoded(8),
              generationId: "held-local-v1",
              idempotency: encoded(9),
              vehicle: "inválido",
            },
          }),
        ),
      ).toThrow(StockEntrySecretBundleError);
      expect(fill).toHaveBeenCalledTimes(2);
    } finally {
      fill.mockRestore();
    }
  });

  it("lê apenas arquivo 0400/0440 e permite symlink interno", async () => {
    const root = await directory();
    const target = join(root, "generation-1.json");
    const entry = join(root, "keys.json");
    await writeFile(target, `${source()}\n`, { mode: 0o400 });
    await symlink(target, entry);

    const bundle = await readStockEntrySecretBundleFromPath(entry);
    expect(bundle.request.activeKeyId).toBe("request-v1");
    destroyStockEntrySecretBundle(bundle);

    await chmod(target, 0o600);
    await expect(
      readStockEntrySecretBundleFromPath(entry),
    ).rejects.toBeInstanceOf(StockEntrySecretBundleError);
  });

  it("recusa symlink que escapa do mount e UTF-8 inválido", async () => {
    const root = await directory();
    const outside = await directory();
    const outsideTarget = join(outside, "keys.json");
    const escapingEntry = join(root, "escaping.json");
    await writeFile(outsideTarget, source(), { mode: 0o400 });
    await symlink(outsideTarget, escapingEntry);
    await expect(
      readStockEntrySecretBundleFromPath(escapingEntry),
    ).rejects.toBeInstanceOf(StockEntrySecretBundleError);

    const invalid = join(root, "invalid.json");
    await writeFile(invalid, Buffer.from([0xc3, 0x28]), { mode: 0o400 });
    await expect(
      readStockEntrySecretBundleFromPath(invalid),
    ).rejects.toBeInstanceOf(StockEntrySecretBundleError);
  });
});
