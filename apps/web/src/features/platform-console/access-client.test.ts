import { afterEach, describe, expect, it, vi } from "vitest";

import { browserPlatformAccessClient } from "./access-client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("browserPlatformAccessClient", () => {
  it("consulta a capability sem cache, cookie cross-origin ou dados operacionais", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(browserPlatformAccessClient.load()).resolves.toEqual({
      status: "authorized",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/platform/access", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  });

  it.each([
    [
      "sessão ausente",
      jsonResponse({ code: "AUTHENTICATION_REQUIRED" }, 401),
      { status: "auth_required" },
    ],
    [
      "MFA ausente",
      jsonResponse({ code: "MFA_REQUIRED" }, 403),
      { code: "MFA_REQUIRED", status: "mfa_required" },
    ],
    [
      "MFA antiga",
      jsonResponse({ code: "MFA_RECENT_REQUIRED" }, 403),
      { code: "MFA_RECENT_REQUIRED", status: "mfa_required" },
    ],
    [
      "grant ausente",
      jsonResponse({ code: "PLATFORM_RESOURCE_NOT_FOUND" }, 404),
      { status: "not_found" },
    ],
    [
      "serviço indisponível",
      jsonResponse(
        { code: "PLATFORM_ACCESS_UNAVAILABLE", traceId: "trace-safe" },
        503,
      ),
      { status: "unavailable" },
    ],
  ])(
    "mapeia %s sem refletir o corpo remoto",
    async (_label, response, result) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => response),
      );

      await expect(browserPlatformAccessClient.load()).resolves.toEqual(result);
    },
  );

  it.each([
    [
      "204 com corpo",
      {
        status: 204,
        text: vi.fn(async () => "unexpected"),
      } as unknown as Response,
    ],
    [
      "204 ilegível",
      {
        status: 204,
        text: vi.fn(async () => {
          throw new Error("falha de leitura");
        }),
      } as unknown as Response,
    ],
    ["401 desconhecido", jsonResponse({ code: "OTHER" }, 401)],
    ["403 sem MFA", jsonResponse({ code: "ACCESS_DENIED" }, 403)],
    [
      "404 com campo extra",
      jsonResponse(
        { code: "PLATFORM_RESOURCE_NOT_FOUND", detail: "interno" },
        404,
      ),
    ],
    [
      "503 sem trace seguro",
      jsonResponse({ code: "PLATFORM_ACCESS_UNAVAILABLE", traceId: "" }, 503),
    ],
    ["status inesperado", jsonResponse({ code: "OTHER" }, 418)],
  ])("falha fechado diante de %s", async (_label, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );

    await expect(browserPlatformAccessClient.load()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("falha fechado quando a rede não responde", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("detalhe sensível");
      }),
    );

    await expect(browserPlatformAccessClient.load()).resolves.toEqual({
      status: "unavailable",
    });
  });
});
