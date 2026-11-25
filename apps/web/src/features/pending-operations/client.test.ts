import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserPendingOperationsClient,
  PendingOperationsClientError,
} from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const establishmentId = "22222222-2222-4222-8222-222222222222";
const operationId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const correlationId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-11-24T12:34:56.000Z";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    correlationId,
    createdAt: timestamp,
    kind: "USED_STOCK_ENTRY",
    operationId,
    reasonCode: null,
    sentAt: timestamp,
    status: "PENDING_RECONCILIATION",
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("browserPendingOperationsClient", () => {
  it("consulta a fila somente no escopo tenant e estabelecimento", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [summary()], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserPendingOperationsClient.loadPage({
        establishmentId,
        tenantId,
      }),
    ).resolves.toMatchObject({
      items: [{ operationId, status: "PENDING_RECONCILIATION" }],
      truncated: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/${tenantId}/establishments/${establishmentId}/pending-operations?limit=50`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it("aceita detalhe resolvido e versões bigint-safe como texto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          operation: {
            ...summary({ status: "CONFIRMED" }),
            finalizedAt: timestamp,
            remoteRecordId: 71,
            remoteState: "CONFIRMADO",
            version: "9007199254740993",
          },
          timeline: [
            {
              changedAt: timestamp,
              previousStatus: null,
              reasonCode: "HELD_LOCAL_CREATED",
              status: "HELD_LOCAL",
              version: "1",
            },
            {
              changedAt: timestamp,
              previousStatus: "PENDING_RECONCILIATION",
              reasonCode: "RENAVE_RECONCILIATION_CONFIRMED",
              status: "CONFIRMED",
              version: "9007199254740993",
            },
          ],
        }),
      ),
    );

    await expect(
      browserPendingOperationsClient.loadDetail({
        establishmentId,
        operationId,
        tenantId,
      }),
    ).resolves.toMatchObject({
      operation: {
        remoteState: "CONFIRMADO",
        status: "CONFIRMED",
        version: "9007199254740993",
      },
      timeline: [{ version: "1" }, { version: "9007199254740993" }],
    });
  });

  it.each([
    [
      "campo protegido na lista",
      {
        items: [summary({ requestCiphertext: "segredo" })],
        truncated: false,
      },
    ],
    [
      "tipo ainda não publicado",
      {
        items: [summary({ kind: "USED_STOCK_EXIT" })],
        truncated: false,
      },
    ],
    [
      "status fora da fila",
      {
        items: [summary({ status: "CONFIRMED" })],
        truncated: false,
      },
    ],
    [
      "data sem fuso",
      {
        items: [summary({ updatedAt: "2026-11-24T12:34:56" })],
        truncated: false,
      },
    ],
    ["duplicidade", { items: [summary(), summary()], truncated: false }],
  ])("falha fechado diante de %s", async (_case, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json(payload)),
    );

    await expect(
      browserPendingOperationsClient.loadPage({ establishmentId, tenantId }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 0 });
  });

  it("recusa UUID não canônico antes de acessar a rede", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserPendingOperationsClient.loadDetail({
        establishmentId,
        operationId: operationId.toUpperCase(),
        tenantId,
      }),
    ).rejects.toMatchObject({
      code: "TENANT_RESOURCE_NOT_FOUND",
      status: 404,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não incorpora detalhes remotos no erro", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { code: "TENANT_RESOURCE_NOT_FOUND", detail: "CPF 12345678909" },
          { status: 404 },
        ),
      ),
    );

    let failure: unknown;
    try {
      await browserPendingOperationsClient.loadPage({
        establishmentId,
        tenantId,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PendingOperationsClientError);
    expect(failure).toMatchObject({
      code: "TENANT_RESOURCE_NOT_FOUND",
      status: 404,
    });
    expect(String(failure)).not.toContain("12345678909");
  });
});
