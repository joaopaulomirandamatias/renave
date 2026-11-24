import { describe, expect, it, vi } from "vitest";

import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
  parseStockEntryKeyBundle,
  serializeStockEntryKeyBundle,
  StockEntryKeyBundleError,
} from "./stock-entry-key-bundle.js";

function encoded(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

function vectorSource(
  requestKeys: Record<string, string> = {
    "request-v1": encoded(5),
    "request-v0": encoded(6),
  },
): string {
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
    request: { activeKeyId: "request-v1", keys: requestKeys },
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
  });
}

describe("stock-entry key bundle", () => {
  it("mantém um vetor estável e independe da ordem dos keyIds", () => {
    const first = parseStockEntryKeyBundle(vectorSource());
    const reordered = parseStockEntryKeyBundle(
      vectorSource({
        "request-v0": encoded(6),
        "request-v1": encoded(5),
      }),
    );
    try {
      expect(first.digests.fingerprint.toString("hex")).toBe(
        "bd44c66f082f2febb0db1c3d93dd9962d91cbe5f0e396faa6a40e2fb68c97cf7",
      );
      expect(reordered.digests.fingerprint).toEqual(first.digests.fingerprint);
    } finally {
      destroyStockEntryKeyBundle(first);
      destroyStockEntryKeyBundle(reordered);
    }
  });

  it("gera dez materiais independentes aceitos pelo mesmo parser", () => {
    let seed = 0;
    const random = vi.fn((size: number) => {
      expect(size).toBe(32);
      seed += 1;
      return new Uint8Array(size).fill(seed);
    });
    const bundle = generateStockEntryKeyBundle("held-local-v1", random);
    const serialized = serializeStockEntryKeyBundle(bundle);
    const parsed = parseStockEntryKeyBundle(serialized);
    try {
      expect(random).toHaveBeenCalledTimes(10);
      expect(parsed.digests.fingerprint).toEqual(bundle.digests.fingerprint);
      expect(parsed.operatorCpf.encryption.activeKeyId).toBe(
        "operator-encryption-v1",
      );
      expect(parsed.request.activeKeyId).toBe("request-v1");
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64 * 1024);
    } finally {
      destroyStockEntryKeyBundle(parsed);
      destroyStockEntryKeyBundle(bundle);
    }
  });

  it("recusa generationId inválido, RNG inválido e colisão", () => {
    expect(() => generateStockEntryKeyBundle(" inválido ")).toThrow(
      StockEntryKeyBundleError,
    );
    expect(() =>
      generateStockEntryKeyBundle("held-local-v1", () => new Uint8Array(31)),
    ).toThrow(StockEntryKeyBundleError);
    expect(() =>
      generateStockEntryKeyBundle("held-local-v1", () =>
        new Uint8Array(32).fill(7),
      ),
    ).toThrow(StockEntryKeyBundleError);
  });

  it("zera materiais já gerados quando uma etapa posterior falha", () => {
    const generated: Uint8Array[] = [];
    expect(() =>
      generateStockEntryKeyBundle("held-local-v1", (size) => {
        const value = new Uint8Array(size).fill(generated.length + 1);
        generated.push(value);
        if (generated.length === 5) throw new Error("falha injetada");
        return value;
      }),
    ).toThrow(StockEntryKeyBundleError);
    expect(
      generated.slice(0, 4).every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it("não serializa bundle destruído ou fingerprint divergente", () => {
    let seed = 0;
    const bundle = generateStockEntryKeyBundle("held-local-v1", (size) =>
      new Uint8Array(size).fill((seed += 1)),
    );
    bundle.digests.fingerprint[0] = bundle.digests.fingerprint[0]! ^ 0xff;
    expect(() => serializeStockEntryKeyBundle(bundle)).toThrow(
      StockEntryKeyBundleError,
    );
    destroyStockEntryKeyBundle(bundle);
    expect(() => serializeStockEntryKeyBundle(bundle)).toThrow(
      StockEntryKeyBundleError,
    );
  });
});
