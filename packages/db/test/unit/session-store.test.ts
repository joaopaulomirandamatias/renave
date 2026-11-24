import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  IdentitySessionStoreInputError,
  PostgresIdentitySessionStore,
} from "../../src/session-store.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function poolWithQuery(query = vi.fn().mockResolvedValue({ rows: [] })): {
  pool: Pool;
  query: typeof query;
} {
  return { pool: { query } as unknown as Pool, query };
}

describe("PostgresIdentitySessionStore", () => {
  it("encaminha somente a operação específica à função autorizada", async () => {
    const { pool, query } = poolWithQuery();
    const store = new PostgresIdentitySessionStore(pool);

    await store.saveLoginAttempt(hash("state"), {
      bindingHash: hash("binding"),
      codeVerifier: "v".repeat(86),
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
      nonceHash: hash("nonce"),
      returnTo: "/painel",
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "renave_identity.save_login_attempt",
    );
  });

  it("recusa identificador bruto antes de alcançar o banco", async () => {
    const { pool, query } = poolWithQuery();
    const store = new PostgresIdentitySessionStore(pool);

    await expect(store.deleteSession("cookie-bruto")).rejects.toBeInstanceOf(
      IdentitySessionStoreInputError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("recusa lote de limpeza fora do limite antes de alcançar o banco", async () => {
    const { pool, query } = poolWithQuery();
    const store = new PostgresIdentitySessionStore(pool);

    await expect(store.purgeExpiredRecords(0)).rejects.toBeInstanceOf(
      IdentitySessionStoreInputError,
    );
    await expect(store.purgeExpiredRecords(10_001)).rejects.toBeInstanceOf(
      IdentitySessionStoreInputError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
