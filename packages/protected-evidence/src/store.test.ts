import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { EvidenceCipher } from "./crypto.js";
import {
  PostgresProtectedEvidenceStore,
  ProtectedEvidenceInputError,
  ProtectedEvidenceTransitionError,
} from "./store.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const establishmentId = "22222222-2222-4222-8222-222222222222";
const action = "renave.vehicle.eligibility.read" as const;
type EvidenceAction =
  | "renave.identity.verify"
  | "renave.stock.read"
  | "renave.vehicle.eligibility.read";

function setup(
  rowCounts: number[] = [1, 1],
  bindingAction: EvidenceAction = action,
) {
  const query = vi.fn(async (_text: string, _params?: readonly unknown[]) => ({
    rowCount: rowCounts.shift() ?? 1,
    rows: [],
  }));
  const transactionQuery = vi.fn(
    async (text: string, params?: readonly unknown[]) => {
      if (
        text === "begin" ||
        text === "commit" ||
        text === "rollback" ||
        text.startsWith("select set_config")
      ) {
        return { rowCount: 1, rows: [] };
      }
      return query(text, params);
    },
  );
  const release = vi.fn();
  const client = { query: transactionQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  const cipher = new EvidenceCipher({
    activeKeyId: "active-key",
    keys: new Map([["active-key", Buffer.alloc(32, 5)]]),
  });
  const store = new PostgresProtectedEvidenceStore(pool, cipher, {
    action: bindingAction,
    establishmentId,
    tenantId,
  });
  return { connect, query, release, store, transactionQuery };
}

describe("PostgresProtectedEvidenceStore", () => {
  it("aceita consulta de estoque e persiste a placa somente cifrada", async () => {
    const stockAction = "renave.stock.read" as const;
    const { query, store } = setup([1], stockAction);

    await store.begin({
      action: stockAction,
      actorSubject: "oidc|stock-operator",
      establishmentId,
      request: { placa: "ABC1D23" },
      tenantId,
    });

    const insertParams = query.mock.calls[0]?.[1] as unknown[];
    const persisted = JSON.stringify(insertParams, (_key, value) =>
      Buffer.isBuffer(value) ? value.toString("base64") : value,
    );
    expect(insertParams[3]).toBe(stockAction);
    expect(persisted).not.toContain("ABC1D23");
    expect(persisted).not.toContain("stock-operator");
  });

  it("recusa ação fora da allowlist antes de abrir conexão", () => {
    expect(() => setup([1], "renave.stock.export" as never)).toThrow(
      ProtectedEvidenceInputError,
    );
  });

  it("insere somente ciphertext e finaliza pending atomicamente", async () => {
    const { connect, query, release, store } = setup();
    const result = await store.begin({
      action,
      actorSubject: "oidc|operator",
      establishmentId,
      request: { placa: "ABC1D23", tipoCrv: "DIGITAL" },
      tenantId,
      traceId: "trace-public",
    });

    expect(result.payloadReference).toMatch(/^pev1_[0-9a-f-]{36}$/u);
    const insertParams = query.mock.calls[0]?.[1] as unknown[];
    const persisted = JSON.stringify(insertParams, (_key, value) =>
      Buffer.isBuffer(value) ? value.toString("base64") : value,
    );
    expect(persisted).not.toContain("ABC1D23");
    expect(persisted).not.toContain("oidc|operator");
    expect(insertParams[5]).toBeInstanceOf(Buffer);
    expect(insertParams[6]).toBeInstanceOf(Buffer);
    expect(insertParams[7]).toBeInstanceOf(Buffer);

    await store.complete({
      payloadReference: result.payloadReference,
      response: { diagnostico: { veiculoApto: true } },
    });
    expect(query.mock.calls[1]?.[0]).toContain("status = 'completed'");
    expect(query.mock.calls[1]?.[0]).toContain("status = 'pending'");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("registra apenas código fechado na falha", async () => {
    const { query, store } = setup();
    const result = await store.begin({
      action,
      actorSubject: "subject",
      establishmentId,
      request: { placa: "ABC1D23" },
      tenantId,
    });
    await store.fail({
      errorCode: "RENAVE_PROTOCOL_ERROR",
      payloadReference: result.payloadReference,
    });

    expect(query.mock.calls[1]?.[1]?.[4]).toBe("RENAVE_PROTOCOL_ERROR");
    await expect(
      store.fail({
        errorCode: "erro com dados pessoais",
        payloadReference: result.payloadReference,
      }),
    ).rejects.toBeInstanceOf(ProtectedEvidenceInputError);
  });

  it("falha fechado quando a transição não atualiza exatamente uma linha", async () => {
    const { store } = setup([1, 0]);
    const result = await store.begin({
      action,
      actorSubject: "subject",
      establishmentId,
      request: { placa: "ABC1D23" },
      tenantId,
    });

    await expect(
      store.complete({
        payloadReference: result.payloadReference,
        response: { diagnostico: { veiculoApto: true } },
      }),
    ).rejects.toBeInstanceOf(ProtectedEvidenceTransitionError);
  });

  it("recusa referência e binding divergentes antes do update", async () => {
    const { query, store } = setup();
    await expect(
      store.begin({
        action,
        actorSubject: "subject",
        establishmentId,
        request: {},
        tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toBeInstanceOf(ProtectedEvidenceInputError);
    await expect(
      store.complete({ payloadReference: "evidence:raw", response: {} }),
    ).rejects.toBeInstanceOf(ProtectedEvidenceInputError);
    expect(query).not.toHaveBeenCalled();
  });
});
