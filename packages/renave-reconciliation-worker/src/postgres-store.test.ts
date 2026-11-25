import { RuntimeDatabaseContractError } from "@seu-renave/db";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresReconciliationDatabase } from "./postgres-store.js";

function guardedPool(currentUser = "renave_operation_worker") {
  const connect = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from pg_catalog.pg_roles roles")) {
      return {
        rows: [
          {
            current_user: currentUser,
            has_database_connect: true,
            has_database_create: false,
            has_database_ownership: false,
            has_database_temporary: false,
            has_protected_object_ownership: false,
            has_set_role: false,
            rolbypassrls: false,
            rolcanlogin: true,
            rolcreatedb: false,
            rolcreaterole: false,
            rolinherit: false,
            rolreplication: false,
            rolsuper: false,
            session_user: currentUser,
          },
        ],
      };
    }
    if (sql.includes("operation_worker_contract_ready")) {
      return { rows: [{ ready: true }] };
    }
    throw new Error("consulta inesperada");
  });
  return {
    connect,
    pool: { connect, query } as unknown as Pool,
    query,
  };
}

describe("PostgresReconciliationDatabase", () => {
  it("só compõe o adapter depois de atestar o papel worker", async () => {
    const fake = guardedPool();

    const adapter = await PostgresReconciliationDatabase.create(fake.pool);
    expect(adapter).toBeInstanceOf(PostgresReconciliationDatabase);
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("recusa fail-closed um pool de outro papel", async () => {
    const fake = guardedPool("renave_app");

    await expect(
      PostgresReconciliationDatabase.create(fake.pool),
    ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
    expect(fake.query).toHaveBeenCalledOnce();
  });

  it("mantém pool inacessível e recusa construção forjada", async () => {
    const fake = guardedPool();
    const adapter = await PostgresReconciliationDatabase.create(fake.pool);
    expect(Object.keys(adapter)).toEqual([]);
    expect(JSON.stringify(adapter)).toBe("{}");
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(PostgresReconciliationDatabase.prototype)).toBe(
      true,
    );
    expect(Object.isFrozen(PostgresReconciliationDatabase)).toBe(true);

    const Constructor = PostgresReconciliationDatabase as unknown as new (
      ...args: unknown[]
    ) => PostgresReconciliationDatabase;
    expect(() => new Constructor()).toThrow("Adapter PostgreSQL inválido");
    expect(() =>
      Reflect.construct(Constructor, [Symbol("forged"), fake.pool], class {}),
    ).toThrow("Adapter PostgreSQL inválido");
    class Subclass extends Constructor {}
    expect(() => new Subclass(Symbol("forged"), fake.pool)).toThrow(
      "Adapter PostgreSQL inválido",
    );
    const forged = Object.create(
      PostgresReconciliationDatabase.prototype,
    ) as PostgresReconciliationDatabase;
    expect(() =>
      forged.begin({
        leaseOwner: "55555555-5555-4555-8555-555555555555",
        leaseToken: "66666666-6666-4666-8666-666666666666",
        operationVersion: "1",
        outboxId: "44444444-4444-4444-8444-444444444444",
        tenantId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("Adapter PostgreSQL inválido");
  });

  it("executa os seis métodos no mesmo pool sempre dentro de withTenant", async () => {
    const fake = guardedPool();
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("renew_operation_reconciliation_lease")) {
        return { rows: [{ value: true }] };
      }
      if (sql.includes("release_operation_reconciliation_lease")) {
        return { rows: [{ value: true }] };
      }
      return { rows: [] };
    });
    const releaseClient = vi.fn();
    const client = { query, release: releaseClient };
    fake.connect.mockResolvedValue(client);
    const adapter = await PostgresReconciliationDatabase.create(fake.pool);
    const fence = {
      leaseOwner: "55555555-5555-4555-8555-555555555555",
      leaseToken: "66666666-6666-4666-8666-666666666666",
      operationVersion: "1",
      outboxId: "44444444-4444-4444-8444-444444444444",
      tenantId: "11111111-1111-4111-8111-111111111111",
    };

    await adapter.claim({
      leaseOwner: fence.leaseOwner,
      limit: 1,
      tenantId: fence.tenantId,
    });
    await adapter.begin(fence);
    await adapter.renew(fence);
    await adapter.release({
      ...fence,
      retryAt: new Date("2026-11-24T10:01:00.000Z"),
    });
    await adapter.completeConfirmed({
      ...fence,
      remoteRecordId: 7,
      remoteState: "CONFIRMADO",
    });
    await adapter.completeManual({
      ...fence,
      reason: "RENAVE_RECONCILIATION_AMBIGUOUS",
    });

    expect(fake.connect).toHaveBeenCalledTimes(6);
    expect(releaseClient).toHaveBeenCalledTimes(6);
    const setTenant = query.mock.calls.filter(([sql]) =>
      sql.includes("set_config"),
    );
    expect(setTenant).toHaveLength(6);
    expect(
      setTenant.every(([, values]) => values?.[1] === fence.tenantId),
    ).toBe(true);
    expect(query.mock.calls.filter(([sql]) => sql === "begin")).toHaveLength(6);
    expect(query.mock.calls.filter(([sql]) => sql === "commit")).toHaveLength(
      6,
    );
  });
});
