import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { TenantActionRunner } from "../auth/request-access-guard.js";
import { composeStockEntryRuntime } from "./stock-entry-runtime.js";
import { parseStockEntrySecretBundle } from "./stock-entry-secret-bundle.js";

function encoded(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

function bundle() {
  return parseStockEntrySecretBundle(
    JSON.stringify({
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
        keys: { "request-v1": encoded(5) },
      },
      projection: {
        activeKeyId: "projection-v1",
        keys: { "projection-v1": encoded(6) },
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

describe("composição HELD_LOCAL", () => {
  it("entrega operação e limitador juntos e destrói recursos idempotentemente", async () => {
    const source = bundle();
    const query = vi.fn();
    const runner: TenantActionRunner = {
      run: vi.fn(),
    } as unknown as TenantActionRunner;
    const composition = composeStockEntryRuntime({
      bundle: source,
      pool: { query } as unknown as Pool,
      runner,
    });

    expect(composition.operation).toBeDefined();
    expect(composition.mutationRateLimiter).toBeDefined();
    expect(source.limiterHmacKey.every((byte) => byte === 0)).toBe(true);

    composition.destroy();
    composition.destroy();
    await expect(
      composition.operation.execute({
        business: {} as never,
        establishmentId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        session: {
          expiresAt: Date.now() + 60_000,
          issuer: "https://idp.test",
          mfaVerified: true,
          roles: [],
          subject: "subject",
        },
        tenantId: "33333333-3333-4333-8333-333333333333",
        traceId: "trace",
      }),
    ).rejects.toMatchObject({ code: "STOCK_ENTRY_OPERATION_UNAVAILABLE" });
    await expect(
      composition.mutationRateLimiter.acquire({
        subject: "subject",
        tenantId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("limpa o bundle e recursos parciais quando a composição falha", () => {
    const source = bundle();
    const runner: TenantActionRunner = {
      run: vi.fn(),
    } as unknown as TenantActionRunner;

    expect(() =>
      composeStockEntryRuntime({
        bundle: source,
        pool: {} as Pool,
        runner,
      }),
    ).toThrow();

    const keys = [
      ...source.operatorCpf.encryption.keys.values(),
      ...source.operatorCpf.hmac.keys.values(),
      ...source.establishmentEmail.encryption.keys.values(),
      ...source.establishmentEmail.hmac.keys.values(),
      ...source.request.keys.values(),
      ...source.projection.keys.values(),
      source.digests.actor,
      source.digests.fingerprint,
      source.digests.idempotency,
      source.digests.vehicle,
      source.limiterHmacKey,
    ];
    expect(keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
});
