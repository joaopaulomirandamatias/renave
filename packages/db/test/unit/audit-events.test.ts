import { describe, expect, it, vi } from "vitest";

import {
  listTenantAuditEvents,
  TenantAuditQueryInputError,
  type AuditOutcome,
} from "../../src/audit-events.js";
import type { TenantClient } from "../../src/tenant-context.js";

const ESTABLISHMENT_A = "22222222-2222-4222-8222-222222222222";
const ESTABLISHMENT_B = "33333333-3333-4333-8333-333333333333";

function fakeClient(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async () => ({ rows }));
  return {
    client: { query } as unknown as TenantClient,
    query,
  };
}

describe("listTenantAuditEvents", () => {
  it("ordena por sequence desc, aplica limit padrão 20 e retorna somente projeção sanitizada", async () => {
    const occurredAt = new Date("2026-11-24T12:00:00.000Z");
    const { client, query } = fakeClient([
      {
        action: "renave.stock.read",
        actor_ip: "198.51.100.7",
        actor_subject: "oidc|secret-user",
        cnpj_sent: "11222333000181",
        establishment_id: ESTABLISHMENT_A,
        event_hash_prefix: "abcdef0123456789",
        occurred_at: occurredAt,
        outcome: "succeeded",
        payload_reference: "pev1_secret",
        sequence: "42",
        trace_id: "trace-42",
      },
    ]);

    const page = await listTenantAuditEvents(client);

    expect(page).toEqual({
      hasMore: false,
      items: [
        {
          action: "renave.stock.read",
          entityType: "renave",
          establishmentId: ESTABLISHMENT_A,
          eventHashPrefix: "abcdef012345",
          occurredAt: "2026-11-24T12:00:00.000Z",
          outcome: "succeeded",
          sequence: 42,
          traceId: "trace-42",
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("order by sequence desc");
    expect(sql).not.toContain("actor_subject");
    expect(sql).not.toContain("actor_ip");
    expect(sql).not.toContain("payload_reference");
    expect(sql).not.toContain("cnpj_sent");
    expect(params).toEqual([21]);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "action",
      "entityType",
      "establishmentId",
      "eventHashPrefix",
      "occurredAt",
      "outcome",
      "sequence",
      "traceId",
    ]);
  });

  it("calcula hasMore e nextBeforeSequence corretamente ao paginar", async () => {
    const { client, query } = fakeClient([
      {
        action: "tenant.establishment.created",
        establishment_id: ESTABLISHMENT_A,
        event_hash_prefix: "111111111111",
        occurred_at: new Date("2026-11-24T12:02:00.000Z"),
        outcome: "succeeded",
        sequence: "10",
        trace_id: null,
      },
      {
        action: "tenant.establishment.updated",
        establishment_id: ESTABLISHMENT_A,
        event_hash_prefix: "222222222222",
        occurred_at: new Date("2026-11-24T12:01:00.000Z"),
        outcome: "succeeded",
        sequence: "9",
        trace_id: "trace-9",
      },
      {
        action: "audit.read",
        establishment_id: ESTABLISHMENT_A,
        event_hash_prefix: "333333333333",
        occurred_at: new Date("2026-11-24T12:00:00.000Z"),
        outcome: "succeeded",
        sequence: "8",
        trace_id: null,
      },
    ]);

    const page = await listTenantAuditEvents(client, {
      beforeSequence: 11,
      limit: 2,
    });

    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSequence).toBe(9);
    expect(page.items.map((item) => item.sequence)).toEqual([10, 9]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("sequence < $1");
    expect(params).toEqual([11, 3]);
  });

  it("aplica filtros de establishmentId, action, outcome e allowedEstablishmentIds", async () => {
    const { client, query } = fakeClient([]);
    await listTenantAuditEvents(client, {
      action: "renave.stock-exit.request",
      establishmentId: ESTABLISHMENT_A.toUpperCase(),
      limit: 50,
      outcome: "manual_review",
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("establishment_id = $1");
    expect(sql).toContain("action = $2");
    expect(sql).toContain("outcome = $3");
    expect(params).toEqual([
      ESTABLISHMENT_A,
      "renave.stock-exit.request",
      "manual_review",
      51,
    ]);
  });

  it("restringe por allowedEstablishmentIds quando establishmentId não é informado", async () => {
    const { client, query } = fakeClient([]);
    await listTenantAuditEvents(client, {
      allowedEstablishmentIds: [ESTABLISHMENT_A, ESTABLISHMENT_B],
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("establishment_id = any($1::uuid[])");
    expect(params).toEqual([[ESTABLISHMENT_A, ESTABLISHMENT_B], 21]);
  });

  it("retorna página vazia sem consultar banco quando allowedEstablishmentIds é vazio ou exclui o filtro", async () => {
    const empty = fakeClient([]);
    expect(
      await listTenantAuditEvents(empty.client, {
        allowedEstablishmentIds: [],
      }),
    ).toEqual({ hasMore: false, items: [] });
    expect(empty.query).not.toHaveBeenCalled();

    const outside = fakeClient([]);
    expect(
      await listTenantAuditEvents(outside.client, {
        allowedEstablishmentIds: [ESTABLISHMENT_A],
        establishmentId: ESTABLISHMENT_B,
      }),
    ).toEqual({ hasMore: false, items: [] });
    expect(outside.query).not.toHaveBeenCalled();
  });

  it.each([
    ["limit zero", { limit: 0 }],
    ["limit acima de 50", { limit: 51 }],
    ["limit decimal", { limit: 1.5 }],
    ["beforeSequence zero", { beforeSequence: 0 }],
    ["beforeSequence negativo", { beforeSequence: -1 }],
    ["establishmentId inválido", { establishmentId: "not-a-uuid" }],
    ["action inválida", { action: "INVALID ACTION" }],
    ["outcome inválido", { outcome: "unknown" as AuditOutcome }],
  ])("rejeita parâmetro inválido (%s) fail-closed", async (_label, input) => {
    const { client, query } = fakeClient([]);
    await expect(listTenantAuditEvents(client, input)).rejects.toThrow(
      TenantAuditQueryInputError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
