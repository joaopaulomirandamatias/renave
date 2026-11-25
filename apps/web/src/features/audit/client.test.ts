import { describe, expect, it, vi } from "vitest";

import {
  createTenantAuditClient,
  parseTenantAuditEventsPage,
  TenantAuditClientError,
} from "./client.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: "stock-entry.held-local.created",
    entityType: "stock_entry",
    establishmentId: ESTABLISHMENT_ID,
    eventHashPrefix: "abcdef012345",
    occurredAt: "2026-11-24T15:00:00.000Z",
    outcome: "succeeded",
    sequence: 42,
    traceId: "trace-abc-123",
    ...overrides,
  };
}

describe("tenant audit client", () => {
  it("carrega eventos com query params sanitizados e parser allowlist estrito", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            hasMore: true,
            items: [validEvent()],
            nextBeforeSequence: 42,
          }),
          { status: 200 },
        ),
    );

    const client = createTenantAuditClient(fetchMock);
    const result = await client.loadEvents({
      beforeSequence: 100,
      establishmentId: ESTABLISHMENT_ID.toUpperCase(),
      limit: 20,
      outcome: "succeeded",
      tenantId: TENANT_ID.toUpperCase(),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `/api/tenants/${TENANT_ID}/audit-events?establishmentId=${ESTABLISHMENT_ID}&outcome=succeeded&beforeSequence=100&limit=20`,
    );
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      redirect: "error",
    });
    expect(result).toEqual({
      page: {
        hasMore: true,
        items: [validEvent()],
        nextBeforeSequence: 42,
      },
      status: "ready",
    });
  });

  it.each([403, 404])(
    "trata status HTTP %s como acesso negado (fail-closed)",
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ code: "TENANT_RESOURCE_NOT_FOUND" }), {
            status,
          }),
      );
      const client = createTenantAuditClient(fetchMock);
      await expect(client.loadEvents({ tenantId: TENANT_ID })).resolves.toEqual(
        { status: "denied" },
      );
    },
  );

  it("lança TenantAuditClientError em erro 503", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: "TENANT_AUDIT_UNAVAILABLE" }), {
          status: 503,
        }),
    );
    const client = createTenantAuditClient(fetchMock);
    await expect(
      client.loadEvents({ tenantId: TENANT_ID }),
    ).rejects.toMatchObject({
      code: "TENANT_AUDIT_UNAVAILABLE",
      status: 503,
    });
  });

  it("rejeita campos extras ou inesperados em modo fail-closed", () => {
    expect(() =>
      parseTenantAuditEventsPage({
        extra: "forbidden",
        hasMore: false,
        items: [],
      }),
    ).toThrow();

    expect(() =>
      parseTenantAuditEventsPage({
        hasMore: false,
        items: [validEvent({ actorIp: "10.0.0.1" })],
      }),
    ).toThrow();

    expect(() =>
      parseTenantAuditEventsPage({
        hasMore: false,
        items: [validEvent({ eventHashPrefix: "curto" })],
      }),
    ).toThrow();

    expect(() =>
      parseTenantAuditEventsPage({
        hasMore: true,
        items: [validEvent()],
      }),
    ).toThrow();

    expect(() =>
      parseTenantAuditEventsPage({
        hasMore: false,
        items: [validEvent()],
        nextBeforeSequence: 42,
      }),
    ).toThrow();
  });

  it("rejeita resposta 200 malformada como INVALID_RESPONSE", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            hasMore: false,
            items: [validEvent({ actorSubject: "sensivel" })],
          }),
          { status: 200 },
        ),
    );
    const client = createTenantAuditClient(fetchMock);
    await expect(
      client.loadEvents({ tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(TenantAuditClientError);
  });
});
