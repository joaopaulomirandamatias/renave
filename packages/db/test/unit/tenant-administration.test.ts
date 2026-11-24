import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { TenantClient } from "../../src/tenant-context.js";
import {
  PostgresTenantAdministration,
  TenantAdminInputError,
  type CreateAdminEstablishmentInput,
} from "../../src/tenant-administration.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const establishmentId = "22222222-2222-4222-8222-222222222222";
const request: CreateAdminEstablishmentInput = {
  actorIp: "203.0.113.10",
  actorSubject: "oidc|tenant-admin-test",
  cnpj: "11222333000181",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  tradeName: "Loja Teste",
};

describe("PostgresTenantAdministration", () => {
  it("oculta e copia a chave e zera os digests derivados", async () => {
    const inputKey = Buffer.alloc(32, 11);
    const expectedKey = Buffer.from(inputKey);
    let actorDigest: Buffer | undefined;
    let keyDigest: Buffer | undefined;
    let requestDigest: Buffer | undefined;
    let actorSnapshot: Buffer | undefined;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("lock_current_tenant_admin")) {
        return { rows: [{ allowed: true }] };
      }
      if (sql.includes("current_tenant_id()::text")) {
        return { rows: [{ tenant_id: tenantId }] };
      }
      if (sql.includes("insert into renave.admin_mutation_idempotency")) {
        keyDigest = values?.[0] as Buffer;
        actorDigest = values?.[1] as Buffer;
        requestDigest = values?.[2] as Buffer;
        actorSnapshot = Buffer.from(actorDigest);
        return { rows: [{ claimed: true }] };
      }
      if (sql.includes("insert into renave.establishment")) {
        return {
          rows: [
            {
              id: establishmentId,
              tenant_id: tenantId,
              cnpj: request.cnpj,
              cnpj_root: request.cnpj.slice(0, 8),
              cnpj_branch: request.cnpj.slice(8, 12),
              trade_name: request.tradeName,
              status: "active",
            },
          ],
        };
      }
      if (sql.includes("insert into renave.audit_event")) {
        return { rows: [{}] };
      }
      if (sql.includes("update renave.admin_mutation_idempotency")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Query inesperada: ${sql}`);
    });
    const repository = new PostgresTenantAdministration(inputKey);

    expect(Reflect.ownKeys(repository)).toEqual([]);
    inputKey.fill(0);
    await expect(
      repository.create({ query } as unknown as TenantClient, request),
    ).resolves.toMatchObject({
      establishment: { id: establishmentId },
      replayed: false,
    });

    const expectedActorDigest = createHmac("sha256", expectedKey)
      .update("tenant-admin-idempotency-actor-v1\0", "utf8")
      .update(tenantId, "utf8")
      .update("\0", "utf8")
      .update(request.actorSubject, "utf8")
      .digest();
    expect(actorSnapshot).toEqual(expectedActorDigest);
    expect(actorDigest!.every((byte) => byte === 0)).toBe(true);
    expect(keyDigest!.every((byte) => byte === 0)).toBe(true);
    expect(requestDigest!.every((byte) => byte === 0)).toBe(true);
    expectedActorDigest.fill(0);
    expectedKey.fill(0);
  });

  it("destroy é idempotente e bloqueia uso antes de validar ou consultar", async () => {
    const query = vi.fn();
    const repository = new PostgresTenantAdministration(Buffer.alloc(32, 11));

    repository.destroy();
    expect(() => repository.destroy()).not.toThrow();
    await expect(
      repository.create({ query } as unknown as TenantClient, {
        ...request,
        actorSubject: "",
      }),
    ).rejects.toBeInstanceOf(TenantAdminInputError);
    expect(query).not.toHaveBeenCalled();
  });
});
