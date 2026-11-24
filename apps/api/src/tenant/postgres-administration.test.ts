import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresTenantEstablishmentAdministration } from "./postgres-administration.js";

describe("PostgresTenantEstablishmentAdministration", () => {
  it("não mantém material HMAC observável no adaptador", () => {
    const key = Buffer.alloc(32, 19);
    const administration = new PostgresTenantEstablishmentAdministration(key);

    key.fill(0);

    expect(JSON.stringify(administration)).not.toContain("19");
    for (const property of Reflect.ownKeys(administration)) {
      expect(
        Buffer.isBuffer(
          Reflect.get(administration as object, property) as unknown,
        ),
      ).toBe(false);
    }
  });

  it("delega destroy de forma idempotente e falha antes de consultar", async () => {
    const administration = new PostgresTenantEstablishmentAdministration(
      Buffer.alloc(32, 19),
    );
    const query = vi.fn();

    administration.destroy();
    expect(() => administration.destroy()).not.toThrow();
    await expect(
      administration.create({ query } as unknown as PoolClient, {
        actorIp: "203.0.113.10",
        actorSubject: "oidc|admin",
        cnpj: "11222333000181",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        traceId: "44444444-4444-4444-8444-444444444444",
        tradeName: "Loja Teste",
      }),
    ).rejects.toThrow("Administração do tenant indisponível");
    expect(query).not.toHaveBeenCalled();
  });
});
