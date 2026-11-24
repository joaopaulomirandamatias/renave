import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserPlatformConsoleClient,
  PlatformConsoleClientError,
} from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const establishmentId = "22222222-2222-4222-8222-222222222222";

function item(overrides: Record<string, unknown> = {}) {
  return {
    establishment: { id: establishmentId, tradeName: "Loja Norte" },
    renaveLink: {
      status: "pending",
      updatedAt: "2026-11-24T12:34:56.000Z",
    },
    tenant: { displayName: "Grupo Norte", id: tenantId },
    ...overrides,
  };
}

describe("browserPlatformConsoleClient", () => {
  it("envia o chamado somente no cabeçalho e o cursor somente na query codificada", async () => {
    const cursor = `page_2.${"a".repeat(43)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [item()], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserPlatformConsoleClient.loadQueue({
        cursor,
        reasonTicket: "SEC-1234",
      }),
    ).resolves.toMatchObject({ items: [{ tenant: { id: tenantId } }] });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/platform/renave-link-queue?limit=50&cursor=${cursor}`,
    );
    expect(String(url)).not.toContain("SEC-1234");
    expect(init).toEqual(
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: expect.objectContaining({
          accept: "application/json",
          "x-renave-reason-ticket": "SEC-1234",
        }),
      }),
    );
  });

  it("recusa chamado inválido antes de qualquer acesso à rede", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserPlatformConsoleClient.loadQueue({ reasonTicket: "não válido" }),
    ).rejects.toMatchObject({
      code: "INVALID_PLATFORM_REQUEST",
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserva nomes legítimos de até 512 caracteres conforme o contrato do reader", async () => {
    const displayName = ` ${"A".repeat(510)} `;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          items: [
            item({
              establishment: { id: establishmentId, tradeName: displayName },
              tenant: { displayName, id: tenantId },
            }),
          ],
          truncated: false,
        }),
      ),
    );

    await expect(
      browserPlatformConsoleClient.loadQueue({ reasonTicket: "SEC-1234" }),
    ).resolves.toMatchObject({
      items: [
        {
          establishment: { tradeName: displayName },
          tenant: { displayName },
        },
      ],
    });
  });

  it.each([
    ["campo extra na raiz", { items: [], secret: "x", truncated: false }],
    [
      "CNPJ na projeção",
      {
        items: [
          item({
            establishment: {
              cnpj: "11222333000181",
              id: establishmentId,
              tradeName: "Loja Norte",
            },
          }),
        ],
        truncated: false,
      },
    ],
    [
      "UUID inválido",
      {
        items: [item({ tenant: { displayName: "Grupo Norte", id: "tenant" } })],
        truncated: false,
      },
    ],
    [
      "status desconhecido",
      {
        items: [
          item({
            renaveLink: {
              status: "unknown",
              updatedAt: "2026-11-24T12:34:56.000Z",
            },
          }),
        ],
        truncated: false,
      },
    ],
    [
      "data sem fuso",
      {
        items: [
          item({
            renaveLink: {
              status: "pending",
              updatedAt: "2026-11-24T12:34:56",
            },
          }),
        ],
        truncated: false,
      },
    ],
    [
      "mais de cinquenta itens",
      {
        items: Array.from({ length: 51 }, (_, index) =>
          item({
            establishment: {
              id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
              tradeName: `Loja ${index}`,
            },
          }),
        ),
        truncated: false,
      },
    ],
  ])("falha fechado diante de %s", async (_case, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json(payload)),
    );

    await expect(
      browserPlatformConsoleClient.loadQueue({ reasonTicket: "SEC-1234" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 0 });
  });

  it("aceita Retry-After limitado e não incorpora o detalhe remoto no erro", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            code: "PLATFORM_CONSOLE_RATE_LIMITED",
            detail: "segredo interno",
          },
          { headers: { "retry-after": "37" }, status: 429 },
        ),
      ),
    );

    let failure: unknown;
    try {
      await browserPlatformConsoleClient.loadQueue({
        reasonTicket: "SEC-1234",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PlatformConsoleClientError);
    expect(failure).toMatchObject({
      code: "PLATFORM_CONSOLE_RATE_LIMITED",
      retryAfterSeconds: 37,
      status: 429,
    });
    expect(String(failure)).not.toContain("segredo interno");
  });
});
