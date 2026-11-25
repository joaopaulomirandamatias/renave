import { createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { TenantActionRunner } from "../auth/request-access-guard.js";
import {
  composeStockExitRuntime,
  createStockExitTemporalGuard,
} from "./stock-exit-runtime.js";
import { parseStockEntrySecretBundle } from "./stock-entry-secret-bundle.js";

function encoded(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

function bundle() {
  return parseStockEntrySecretBundle(
    JSON.stringify({
      schemaVersion: 1,
      operatorCpf: {
        encryption: { activeKeyId: "oe", keys: { oe: encoded(1) } },
        hmac: { activeKeyId: "oh", keys: { oh: encoded(2) } },
      },
      establishmentEmail: {
        encryption: { activeKeyId: "ee", keys: { ee: encoded(3) } },
        hmac: { activeKeyId: "eh", keys: { eh: encoded(4) } },
      },
      request: { activeKeyId: "request", keys: { request: encoded(5) } },
      projection: {
        activeKeyId: "projection",
        keys: { projection: encoded(6) },
      },
      digests: {
        actor: encoded(7),
        generationId: "held-local-v1",
        idempotency: encoded(8),
        vehicle: encoded(9),
      },
      limiterHmacKey: encoded(10),
    }),
  );
}

describe("composição da saída HELD_LOCAL", () => {
  it("falha fechado quando MFA ou certificado expiram durante o GET", () => {
    const now = new Date("2026-11-24T18:00:00.000Z");
    const certificate = { isCertificateValidAt: vi.fn(() => true) };
    const guard = createStockExitTemporalGuard({
      certificate,
      clock: { now: () => now },
      mfaMaxAgeSeconds: 300,
    });
    const baseSession = {
      expiresAt: now.getTime() + 60_000,
      issuer: "https://idp.test",
      mfaVerified: true,
      roles: [],
      subject: "operator",
    };
    expect(() =>
      guard.assert({ ...baseSession, mfaVerifiedAt: now.getTime() - 300_000 }),
    ).not.toThrow();
    expect(() =>
      guard.assert({
        ...baseSession,
        mfaVerifiedAt: now.getTime() - 300_001,
      }),
    ).toThrowError(expect.objectContaining({ code: "MFA_RECENT_REQUIRED" }));
    expect(() =>
      guard.assert({ ...baseSession, mfaVerifiedAt: now.getTime() + 1 }),
    ).toThrowError(expect.objectContaining({ code: "MFA_RECENT_REQUIRED" }));
    expect(() =>
      guard.assert({
        ...baseSession,
        expiresAt: now.getTime(),
        mfaVerifiedAt: now.getTime(),
      }),
    ).toThrowError(expect.objectContaining({ code: "MFA_RECENT_REQUIRED" }));

    certificate.isCertificateValidAt.mockReturnValue(false);
    expect(() =>
      guard.assert({ ...baseSession, mfaVerifiedAt: now.getTime() }),
    ).toThrowError(
      expect.objectContaining({ code: "STOCK_EXIT_CERTIFICATE_UNAVAILABLE" }),
    );
    expect(() =>
      createStockExitTemporalGuard({
        certificate,
        clock: { now: () => now },
        mfaMaxAgeSeconds: Number.NaN,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "STOCK_EXIT_OPERATION_NOT_CONFIGURED" }),
    );
  });

  it("deriva domínio próprio, revalida catálogo e destrói cópias", async () => {
    const source = bundle();
    const master = Buffer.alloc(32, 10);
    const calls: Array<readonly unknown[]> = [];
    const query = vi.fn(
      async (sql: string, values: readonly unknown[] = []) => {
        calls.push([
          sql,
          ...values.map((value) =>
            Buffer.isBuffer(value) ? Buffer.from(value) : value,
          ),
        ]);
        if (sql.includes("municipality_catalog_ready")) {
          return { rows: [{ ready: true }] };
        }
        return {
          rows: [
            { allowed: true, limited_scope: null, retry_after_seconds: 0 },
          ],
        };
      },
    );
    const composition = composeStockExitRuntime({
      bundle: source,
      certificate: { isCertificateValidAt: vi.fn(() => true) },
      mfaMaxAgeSeconds: 300,
      pool: { query } as unknown as Pool,
      queryLimiter: { acquire: vi.fn() } as never,
      runner: { run: vi.fn() } as unknown as TenantActionRunner,
      stockQuery: {
        authorize: vi.fn(),
        executeStockExitPreflight: vi.fn(),
      } as never,
    });
    const tenantId = "11111111-1111-4111-8111-111111111111";
    await expect(
      composition.mutationRateLimiter.acquire({ subject: "subject", tenantId }),
    ).resolves.toEqual({ allowed: true });
    await expect(composition.ready()).resolves.toBe(true);
    query.mockResolvedValueOnce({ rows: [{ ready: false }] });
    await expect(composition.ready()).resolves.toBe(false);
    const derived = createHmac("sha256", master)
      .update("stock-exit-rate-limit-key-v1")
      .digest();
    const expectedTenant = createHmac("sha256", derived)
      .update("stock-exit-limit-tenant-v1")
      .update("\0")
      .update(tenantId)
      .digest();
    expect(calls[0]?.[1]).toEqual(expectedTenant);
    expect(source.limiterHmacKey.every((byte) => byte === 0)).toBe(true);
    composition.destroy();
    await expect(
      composition.mutationRateLimiter.acquire({ subject: "subject", tenantId }),
    ).rejects.toThrow();
    derived.fill(0);
    expectedTenant.fill(0);
    master.fill(0);
  });
});
