import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  browserSessionClient,
  EstablishmentCreationClientError,
  type BrowserEstablishment,
  type BrowserEstablishmentCollection,
  type BrowserRenaveReadiness,
  type BrowserSession,
  type BrowserTenant,
  type SessionClient,
} from "./App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function collection(
  establishments: readonly BrowserEstablishment[] = [],
  establishmentManagement: BrowserEstablishmentCollection["capabilities"]["establishmentManagement"] = "denied",
): BrowserEstablishmentCollection {
  return {
    capabilities: { establishmentManagement },
    establishments,
  };
}

function clientFor(
  session: BrowserSession,
  tenants: readonly BrowserTenant[] = [],
): SessionClient {
  return {
    checkVehicleEligibility: vi.fn(async () => ({
      detranUnavailable: false,
      impediments: [],
      status: "eligible" as const,
    })),
    createEstablishment: vi.fn(async (_tenantId, input) => ({
      establishment: { id: "created-store", tradeName: input.tradeName },
      renaveLink: { status: "not_started" as const },
    })),
    createStockEntry: vi.fn(async () => ({
      createdAt: "2026-11-24T12:00:00.000Z",
      operationId: "11111111-1111-4111-8111-111111111111",
      replayed: false,
      status: "HELD_LOCAL" as const,
    })),
    load: vi.fn(async () => session),
    loadEstablishments: vi.fn(async () => collection()),
    loadCredentialLinkQueue: vi.fn(async () => ({
      items: [],
      truncated: false,
    })),
    loadRenaveLinkStatus: vi.fn(async () => ({
      preflightAvailable: false,
      status: "not_started" as const,
    })),
    loadRenaveReadiness: vi.fn(async () => ({
      certificate: "ready" as const,
      environment: "homologation" as const,
      establishmentContact: "pending" as const,
      integration: "configured" as const,
      link: "not_started" as const,
      mutations: "blocked" as const,
      operatorIdentity: "pending" as const,
      queries: "blocked" as const,
    })),
    loadTenants: vi.fn(async () => tenants),
    logout: vi.fn(async () => ({})),
    lookupVehicle: vi.fn(async () => ({
      placa: "ABC1D23",
      restricoes: [],
    })),
    runRenaveLinkPreflight: vi.fn(async () => undefined),
    searchStocks: vi.fn(async () => []),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("App session boundary", () => {
  it.each(["AZUL", "VERDE", "BRANCO", "DIGITAL"] as const)(
    "envia aptidão com CRV %s somente no corpo POST e aceita o DTO mínimo",
    async (crvType) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({
          detranUnavailable: false,
          impediments: ["CRV_ISSUANCE_PENDING"],
          status: "ineligible",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        browserSessionClient.checkVehicleEligibility(
          "tenant-a",
          "store-a",
          "ABC1D23",
          crvType,
        ),
      ).resolves.toEqual({
        detranUnavailable: false,
        impediments: ["CRV_ISSUANCE_PENDING"],
        status: "ineligible",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tenants/tenant-a/establishments/store-a/vehicle-eligibility",
        expect.objectContaining({
          body: JSON.stringify({ crvType, plate: "ABC1D23" }),
          cache: "no-store",
          credentials: "same-origin",
          method: "POST",
        }),
      );
      expect(fetchMock.mock.calls[0]?.[0]).not.toContain("ABC1D23");
    },
  );

  it("recusa aptidão com campo extra, código desconhecido ou duplicado", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: [],
          renavam: "12345678901",
          status: "eligible",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: ["UNKNOWN_CODE"],
          status: "ineligible",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: ["RECALL_PENDING", "RECALL_PENDING"],
          status: "ineligible",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const check = () =>
      browserSessionClient.checkVehicleEligibility(
        "tenant-a",
        "store-a",
        "ABC1D23",
        "DIGITAL",
      );

    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
  });

  it("recusa combinações semanticamente contraditórias de aptidão", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: true,
          impediments: [],
          status: "eligible",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: ["RECALL_PENDING"],
          status: "eligible",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: true,
          impediments: ["RECALL_PENDING"],
          status: "ineligible",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: [],
          status: "ineligible",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const check = () =>
      browserSessionClient.checkVehicleEligibility(
        "tenant-a",
        "store-a",
        "ABC1D23",
        "DIGITAL",
      );

    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
    await expect(check()).rejects.toThrow("Resposta de aptidão inválida");
  });

  it("envia a placa somente no corpo POST same-origin e minimiza a resposta", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json([{ estado: "CONFIRMADO", id: 71, placa: "ABC1D23" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.searchStocks("tenant-a", "store-a", "ABC1D23"),
    ).resolves.toEqual([{ estado: "CONFIRMADO", id: 71, placa: "ABC1D23" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tenants/tenant-a/establishments/store-a/stocks/search",
      expect.objectContaining({
        body: JSON.stringify({ plate: "ABC1D23" }),
        cache: "no-store",
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("ABC1D23");
  });

  it("recusa resposta de estoque com campo extra ou id duplicado", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            cpfOperadorResponsavel: "12345678901",
            estado: "CONFIRMADO",
            id: 71,
            placa: "ABC1D23",
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json([
          { estado: "CONFIRMADO", id: 71, placa: "ABC1D23" },
          { estado: "FINALIZADO", id: 71, placa: "ABC1D23" },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json([{ estado: "DESCONHECIDO", id: 72, placa: "ABC1D23" }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.searchStocks("tenant-a", "store-a", "ABC1D23"),
    ).rejects.toThrow("Item de estoque inválido");
    await expect(
      browserSessionClient.searchStocks("tenant-a", "store-a", "ABC1D23"),
    ).rejects.toThrow("Item de estoque inválido");
    await expect(
      browserSessionClient.searchStocks("tenant-a", "store-a", "ABC1D23"),
    ).rejects.toThrow("Item de estoque inválido");
  });

  it("cadastra com CNPJ somente no corpo e chave idempotente somente no header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          establishment: { id: "store-created", tradeName: "Loja Centro" },
          renaveLink: { status: "not_started" },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.createEstablishment("tenant-a", {
        cnpj: "11.222.333/0001-81",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        tradeName: "Loja Centro",
      }),
    ).resolves.toEqual({
      establishment: { id: "store-created", tradeName: "Loja Centro" },
      renaveLink: { status: "not_started" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tenants/tenant-a/establishments",
      expect.objectContaining({
        body: JSON.stringify({
          cnpj: "11.222.333/0001-81",
          tradeName: "Loja Centro",
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "idempotency-key": "11111111-1111-4111-8111-111111111111",
        }),
        method: "POST",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("11.222.333");
  });

  it("trata 2xx com resposta ampliada como outcome ambíguo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            establishment: {
              cnpj: "11222333000181",
              id: "store-created",
              tradeName: "Loja Centro",
            },
            renaveLink: { status: "not_started" },
          },
          { status: 201 },
        ),
      ),
    );

    await expect(
      browserSessionClient.createEstablishment("tenant-a", {
        cnpj: "11222333000181",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        tradeName: "Loja Centro",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 0 });
  });

  it("cria entrada local com chave somente no header e corpo contratual fechado", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          createdAt: "2026-11-24T15:00:00.000Z",
          operationId: "11111111-1111-4111-8111-111111111111",
          replayed: false,
          status: "HELD_LOCAL",
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.createStockEntry("tenant-a", "store-a", {
        dataCompra: "2026-11-23",
        emailVendedor: "vendedor@example.com",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        valorCompra: 55_000.5,
        veiculo: {
          codigoSegurancaCrv: "12345678901",
          dataHoraMedicaoHodometro: "2026-11-24T10:30:00-03:00",
          documentoProprietarioAtual: "12345678901",
          numeroCrv: "123456789012",
          placa: "ABC1D23",
          quilometragemHodometro: 12_345,
          renavam: "12345678901",
          tipoCrv: "DIGITAL",
          tipoDocumentoProprietarioAtual: "CPF",
        },
      }),
    ).resolves.toEqual({
      createdAt: "2026-11-24T15:00:00.000Z",
      operationId: "11111111-1111-4111-8111-111111111111",
      replayed: false,
      status: "HELD_LOCAL",
    });

    const request = fetchMock.mock.calls[0]!;
    expect(request[0]).toBe(
      "/api/tenants/tenant-a/establishments/store-a/stock-entry-operations",
    );
    expect(request[1]).toEqual(
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "idempotency-key": "22222222-2222-4222-8222-222222222222",
        }),
        method: "POST",
      }),
    );
    const body = JSON.parse(String(request[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual([
      "dataCompra",
      "emailVendedor",
      "valorCompra",
      "veiculo",
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /cpfOperadorResponsavel|emailEstabelecimento|idempotencyKey/u,
    );
  });

  it("trata 2xx ampliado ou semanticamente inválido como outcome ambíguo", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            createdAt: "2026-11-24T15:00:00.000Z",
            operationId: "11111111-1111-4111-8111-111111111111",
            replayed: false,
            serverField: "unexpected",
            status: "HELD_LOCAL",
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            createdAt: "2026-11-24 15:00:00",
            operationId: "not-an-operation-id",
            replayed: "false",
            status: "HELD_LOCAL",
          },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      dataCompra: "2026-11-23",
      emailVendedor: "vendedor@example.com",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      valorCompra: 55_000.5,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        dataHoraMedicaoHodometro: "2026-11-24T10:30:00-03:00",
        documentoProprietarioAtual: "12345678901",
        placa: "ABC1D23",
        quilometragemHodometro: 12_345,
        tipoCrv: "DIGITAL" as const,
        tipoDocumentoProprietarioAtual: "CPF" as const,
      },
    };

    await expect(
      browserSessionClient.createStockEntry("tenant-a", "store-a", input),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 0 });
    await expect(
      browserSessionClient.createStockEntry("tenant-a", "store-a", input),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 0 });
  });

  it("aceita replay somente com status 200 e confirmação idempotente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            createdAt: "2026-11-24T15:00:00.000Z",
            operationId: "11111111-1111-4111-8111-111111111111",
            replayed: true,
            status: "HELD_LOCAL",
          },
          {
            headers: { "idempotency-replayed": "true" },
            status: 200,
          },
        ),
      ),
    );

    await expect(
      browserSessionClient.createStockEntry("tenant-a", "store-a", {
        dataCompra: "2026-11-23",
        emailVendedor: "vendedor@example.com",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        valorCompra: 55_000.5,
        veiculo: {
          codigoSegurancaCrv: "12345678901",
          dataHoraMedicaoHodometro: "2026-11-24T10:30:00-03:00",
          documentoProprietarioAtual: "12345678901",
          placa: "ABC1D23",
          quilometragemHodometro: 12_345,
          tipoCrv: "DIGITAL",
          tipoDocumentoProprietarioAtual: "CPF",
        },
      }),
    ).resolves.toMatchObject({ replayed: true, status: "HELD_LOCAL" });
  });

  it("aceita capability fechada e recusa roles ou campos extras na listagem", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          capabilities: { establishmentManagement: "available" },
          establishments: [{ id: "store-a", tradeName: "Loja A" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          capabilities: {
            establishmentManagement: "available",
            role: "tenant_admin",
          },
          establishments: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.loadEstablishments("tenant-a"),
    ).resolves.toEqual({
      capabilities: { establishmentManagement: "available" },
      establishments: [{ id: "store-a", tradeName: "Loja A" }],
    });
    await expect(
      browserSessionClient.loadEstablishments("tenant-a"),
    ).rejects.toThrow("Resposta de estabelecimentos inválida");
  });

  it("aceita somente a projeção mínima da fila de vínculos", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              establishment: { id: "store-a", tradeName: "Loja A" },
              renaveLink: {
                status: "pending",
                updatedAt: "2026-11-24T12:30:00.000Z",
              },
            },
          ],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              establishment: {
                cnpj: "11222333000181",
                id: "store-a",
                tradeName: "Loja A",
              },
              renaveLink: { status: "pending" },
            },
          ],
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.loadCredentialLinkQueue("tenant-a"),
    ).resolves.toEqual({
      items: [
        {
          establishment: { id: "store-a", tradeName: "Loja A" },
          renaveLink: {
            status: "pending",
            updatedAt: "2026-11-24T12:30:00.000Z",
          },
        },
      ],
      truncated: false,
    });
    await expect(
      browserSessionClient.loadCredentialLinkQueue("tenant-a"),
    ).rejects.toThrow("Item inválido na fila de vínculos");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("aceita somente o contrato fechado de prontidão RENAVE", async () => {
    const valid: BrowserRenaveReadiness = {
      certificate: "warning",
      environment: "homologation",
      establishmentContact: "pending",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(valid))
      .mockResolvedValueOnce(Response.json({ ...valid, thumbprint: "secret" }))
      .mockResolvedValueOnce(
        Response.json({ ...valid, certificate: "unknown" }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...valid, operatorIdentity: "ready" }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...valid, establishmentContact: "blocked" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).resolves.toEqual(valid);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/tenants/tenant-a/establishments/store-a/renave-readiness",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).rejects.toThrow("Resposta de prontidão RENAVE inválida");
    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).rejects.toThrow("Resposta de prontidão RENAVE inválida");
    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).rejects.toThrow("Resposta de prontidão RENAVE inválida");
    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).rejects.toThrow("Resposta de prontidão RENAVE inválida");
  });

  it("propaga o cancelamento nas cinco consultas do ensaio sem forjar identidade", async () => {
    const readiness: BrowserRenaveReadiness = {
      certificate: "ready",
      environment: "homologation",
      establishmentContact: "verified",
      integration: "configured",
      link: "enabled",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(readiness))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          detranUnavailable: false,
          impediments: [],
          status: "eligible",
        }),
      )
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json({ placa: "ABC1D23", restricoes: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await browserSessionClient.loadRenaveReadiness(
      "tenant-a",
      "store-a",
      controller.signal,
    );
    await browserSessionClient.runRenaveLinkPreflight(
      "tenant-a",
      "store-a",
      controller.signal,
    );
    await browserSessionClient.checkVehicleEligibility(
      "tenant-a",
      "store-a",
      "ABC1D23",
      "DIGITAL",
      controller.signal,
    );
    await browserSessionClient.searchStocks(
      "tenant-a",
      "store-a",
      "ABC1D23",
      controller.signal,
    );
    await browserSessionClient.lookupVehicle(
      "tenant-a",
      "store-a",
      "ABC1D23",
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toEqual(expect.stringMatching(/^\/api\//));
      expect(options).toEqual(
        expect.objectContaining({
          credentials: "same-origin",
          signal: controller.signal,
        }),
      );
      const serializedOptions = JSON.stringify(options).toLowerCase();
      expect(serializedOptions).not.toContain("authorization");
      expect(serializedOptions).not.toContain("cookie");
      expect(serializedOptions).not.toContain("subject");
    }
  });

  it("conecta o ensaio a uma porta sem mutação SERPRO do contexto selecionado", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }], "available"),
    );
    vi.mocked(client.loadRenaveReadiness).mockResolvedValue({
      certificate: "ready",
      environment: "homologation",
      establishmentContact: "verified",
      integration: "configured",
      link: "enabled",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    });
    vi.mocked(client.searchStocks).mockResolvedValue([
      { estado: "CONFIRMADO", id: 1, placa: "ABC1D23" },
    ]);
    render(<App client={client} locationPathname="/compliance" />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Placa sintética" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Executar uma vez" }));

    expect(
      await screen.findByText(
        /Ensaio concluído\. Nenhuma mutação foi enviada ao SERPRO/i,
      ),
    ).toBeVisible();
    expect(client.runRenaveLinkPreflight).toHaveBeenCalledWith(
      "tenant-a",
      "store-a",
      expect.any(AbortSignal),
    );
    expect(client.checkVehicleEligibility).toHaveBeenCalledWith(
      "tenant-a",
      "store-a",
      "ABC1D23",
      "DIGITAL",
      expect.any(AbortSignal),
    );
    expect(client.searchStocks).toHaveBeenCalledWith(
      "tenant-a",
      "store-a",
      "ABC1D23",
      expect.any(AbortSignal),
    );
    expect(client.lookupVehicle).toHaveBeenCalledWith(
      "tenant-a",
      "store-a",
      "ABC1D23",
      expect.any(AbortSignal),
    );
    expect(client.createEstablishment).not.toHaveBeenCalled();
    expect(client.createStockEntry).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "pending",
    "verified",
    "suspended",
    "unavailable",
  ] as const)("aceita o estado sanitizado de perfil %s", async (status) => {
    const readiness: BrowserRenaveReadiness = {
      certificate: "ready",
      environment: "homologation",
      establishmentContact: status,
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: status,
      queries: "ready",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(readiness)),
    );

    await expect(
      browserSessionClient.loadRenaveReadiness("tenant-a", "store-a"),
    ).resolves.toEqual(readiness);
  });

  it("não mostra login nem painel enquanto verifica a sessão", () => {
    const client: SessionClient = {
      checkVehicleEligibility: vi.fn(async () => ({
        detranUnavailable: false,
        impediments: [],
        status: "eligible" as const,
      })),
      createEstablishment: vi.fn(async (_tenantId, input) => ({
        establishment: { id: "created-store", tradeName: input.tradeName },
        renaveLink: { status: "not_started" as const },
      })),
      createStockEntry: vi.fn(async () => ({
        createdAt: "2026-11-24T12:00:00.000Z",
        operationId: "11111111-1111-4111-8111-111111111111",
        replayed: false,
        status: "HELD_LOCAL" as const,
      })),
      load: vi.fn(() => new Promise<BrowserSession>(() => undefined)),
      loadEstablishments: vi.fn(async () => collection()),
      loadCredentialLinkQueue: vi.fn(async () => ({
        items: [],
        truncated: false,
      })),
      loadRenaveLinkStatus: vi.fn(async () => ({
        preflightAvailable: false,
        status: "not_started" as const,
      })),
      loadRenaveReadiness: vi.fn(async () => ({
        certificate: "ready" as const,
        environment: "homologation" as const,
        establishmentContact: "pending" as const,
        integration: "configured" as const,
        link: "not_started" as const,
        mutations: "blocked" as const,
        operatorIdentity: "pending" as const,
        queries: "blocked" as const,
      })),
      loadTenants: vi.fn(async () => []),
      logout: vi.fn(async () => ({})),
      lookupVehicle: vi.fn(async () => ({
        placa: "ABC1D23",
        restricoes: [],
      })),
      runRenaveLinkPreflight: vi.fn(async () => undefined),
      searchStocks: vi.fn(async () => []),
    };
    render(<App client={client} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Verificando sua sessão segura",
    );
    expect(screen.queryByText("Entrar na sua conta")).toBeNull();
    expect(screen.queryByText("Visão operacional")).toBeNull();
  });

  it("recusa rota fora da allowlist sem carregar contratos operacionais", async () => {
    const client = clientFor({
      authenticated: true,
      authMode: "oidc",
      environment: "homologation",
      expiresAt: "2026-11-24T00:00:00.000Z",
      user: { name: "Operadora" },
    });

    render(<App client={client} locationPathname="/rota-desconhecida" />);

    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeVisible();
    expect(client.load).not.toHaveBeenCalled();
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(client.loadRenaveReadiness).not.toHaveBeenCalled();
  });

  it("recusa sincronamente uma rota desconhecida após navegação no mesmo componente", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    const view = render(<App client={client} locationPathname="/painel" />);
    expect(
      await screen.findByRole("heading", { name: "Olá, Operadora" }),
    ).toBeVisible();

    view.rerender(
      <App client={client} locationPathname="/rota-desconhecida" />,
    );

    expect(
      screen.getByRole("heading", { name: "Página não encontrada" }),
    ).toBeVisible();
    expect(screen.queryByText("Visão operacional")).toBeNull();
  });

  it("não revela a entrada por acesso direto quando a feature flag está desligada", async () => {
    const client = clientFor({
      authenticated: true,
      authMode: "oidc",
      environment: "homologation",
      expiresAt: "2026-11-24T00:00:00.000Z",
      user: { name: "Operadora" },
    });

    render(<App client={client} locationPathname="/estoque/entrada" />);

    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeVisible();
    expect(client.load).not.toHaveBeenCalled();
    expect(client.createStockEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Entradas" })).toBeNull();
  });

  it("não revela configurações por acesso direto sem capability administrativa", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }], "denied"),
    );

    render(
      <App
        client={client}
        locationPathname="/configuracoes/estabelecimentos"
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeVisible();
    expect(client.loadTenants).toHaveBeenCalledOnce();
    expect(client.createEstablishment).not.toHaveBeenCalled();
    expect(client.loadRenaveLinkStatus).not.toHaveBeenCalled();
    expect(client.loadRenaveReadiness).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("CNPJ")).toBeNull();
  });

  it("não carrega dados operacionais na configuração administrativa autorizada", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Administradora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }], "available"),
    );

    render(
      <App
        client={client}
        locationPathname="/configuracoes/estabelecimentos"
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Estabelecimentos e certificados",
      }),
    ).toBeVisible();
    expect(client.loadRenaveLinkStatus).not.toHaveBeenCalled();
    expect(client.loadRenaveReadiness).not.toHaveBeenCalled();
    expect(client.loadCredentialLinkQueue).not.toHaveBeenCalled();
  });

  it("mostra login somente quando a sessão não está autenticada", async () => {
    render(
      <App
        client={clientFor({
          authenticated: false,
          authMode: "oidc",
          environment: "homologation",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ambiente: Homologação",
    );
  });

  it("traduz erro OIDC conhecido, consome a query e mantém o login disponível", async () => {
    const onAuthErrorConsumed = vi.fn();
    render(
      <App
        client={clientFor({
          authenticated: false,
          authMode: "oidc",
          environment: "homologation",
        })}
        locationSearch="?auth_error=provider_error&returnTo=%2Festoque"
        onAuthErrorConsumed={onAuthErrorConsumed}
      />,
    );

    const feedback = await screen.findByRole("alert");
    expect(feedback).toHaveTextContent("Acesso não concluído");
    expect(feedback).toHaveTextContent(
      "O provedor corporativo não concluiu o acesso",
    );
    expect(feedback).not.toHaveTextContent("provider_error");
    expect(onAuthErrorConsumed).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: /continuar com acesso seguro/i }),
    ).toHaveAttribute("href", "/api/auth/login");
  });

  it("nunca reflete um auth_error desconhecido recebido pela URL", async () => {
    render(
      <App
        client={clientFor({
          authenticated: false,
          authMode: "oidc",
          environment: "development",
        })}
        locationSearch="?auth_error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
        onAuthErrorConsumed={vi.fn()}
      />,
    );

    const feedback = await screen.findByRole("alert");
    expect(feedback).toHaveTextContent(
      "Nenhum detalhe recebido pela URL foi exibido",
    );
    expect(feedback).not.toHaveTextContent("<img");
    expect(feedback).not.toHaveTextContent("onerror");
  });

  it("remove somente auth_error da URL depois de consumir o retorno", async () => {
    window.history.replaceState(
      { navigation: "preserved" },
      "",
      "/?auth_error=invalid_state&keep=1#activation",
    );
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(
      <App
        client={clientFor({
          authenticated: false,
          authMode: "oidc",
          environment: "development",
        })}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tentativa de acesso expirada",
    );
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(
        { navigation: "preserved" },
        "",
        "/?keep=1#activation",
      ),
    );
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#activation");
  });

  it("preserva a sessão autenticada quando o callback OIDC é rejeitado", async () => {
    const onAuthErrorConsumed = vi.fn();
    render(
      <App
        client={clientFor(
          {
            authenticated: true,
            authMode: "oidc",
            environment: "homologation",
            expiresAt: "2026-11-24T00:00:00.000Z",
            user: { name: "Operadora" },
          },
          [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
        )}
        locationSearch="?auth_error=exchange_failed"
        onAuthErrorConsumed={onAuthErrorConsumed}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Olá, Operadora" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sua sessão anterior, se existir, foi preservada",
    );
    expect(onAuthErrorConsumed).toHaveBeenCalledOnce();
  });

  it("abre painel protegido sem conceder estabelecimento por claim do IdP", async () => {
    render(
      <App
        client={clientFor(
          {
            authenticated: true,
            authMode: "oidc",
            environment: "homologation",
            expiresAt: "2026-11-24T00:00:00.000Z",
            user: { name: "Operadora" },
          },
          [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
        )}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Olá, Operadora" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toBeDisabled();
    expect(screen.getByRole("option")).toHaveTextContent(
      "Nenhum estabelecimento disponível",
    );
  });

  it("resolve a rota de estoque sem recombinar os painéis do dashboard", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus).mockResolvedValue({
      preflightAvailable: false,
      status: "confirmed",
    });
    vi.mocked(client.loadRenaveReadiness).mockResolvedValue({
      certificate: "ready",
      environment: "homologation",
      establishmentContact: "verified",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    });

    render(<App client={client} locationPathname="/estoque" />);

    expect(
      await screen.findByRole("heading", { name: "Estoque RENAVE" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Estoque" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      await screen.findByRole("heading", {
        name: "Consultar aptidão do veículo",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Resumo do estabelecimento" }),
    ).toBeNull();
  });

  it("explica acesso ainda não vinculado sem mostrar navegação operacional", async () => {
    render(
      <App
        client={clientFor({
          authenticated: true,
          authMode: "oidc",
          environment: "homologation",
          expiresAt: "2026-11-24T00:00:00.000Z",
          user: { name: "Operadora" },
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Seu acesso ainda não está vinculado a uma organização",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Visão operacional")).toBeNull();
  });

  it("anuncia falha de logout mesmo quando o usuário ainda não possui tenant", async () => {
    const client = clientFor({
      authenticated: true,
      authMode: "oidc",
      environment: "homologation",
      expiresAt: "2026-11-24T00:00:00.000Z",
      user: { name: "Operadora" },
    });
    vi.mocked(client.logout).mockRejectedValueOnce(
      new Error("sessão indisponível"),
    );
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível encerrar a sessão",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Você continua conectado",
    );
    expect(
      screen.getByRole("heading", {
        name: "Seu acesso ainda não está vinculado a uma organização",
      }),
    ).toBeVisible();
  });

  it("permite alternar explicitamente entre várias organizações", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [
        { displayName: "Revenda Norte", tenantId: "tenant-a" },
        { displayName: "Revenda Sul", tenantId: "tenant-b" },
      ],
    );
    vi.mocked(client.loadEstablishments).mockImplementation(async (tenantId) =>
      tenantId === "tenant-b"
        ? collection([{ id: "store-b", tradeName: "Loja Sul" }])
        : collection([{ id: "store-a", tradeName: "Loja Norte" }]),
    );
    render(<App client={client} />);

    const selector = await screen.findByRole("combobox", {
      name: "Organização ativa",
    });
    fireEvent.change(selector, { target: { value: "tenant-b" } });
    expect(selector).toHaveValue("tenant-b");
    expect(screen.getAllByText("Revenda Sul")).toHaveLength(2);
    expect(
      await screen.findByRole("option", { name: "Loja Sul" }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: "Loja Norte" })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toBeEnabled();
  });

  it("cadastra, incorpora e seleciona a nova loja sem presumir vínculo", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Administradora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([], "available"),
    );
    vi.mocked(client.createEstablishment).mockResolvedValue({
      establishment: { id: "store-created", tradeName: "Loja Centro" },
      renaveLink: { status: "not_started" },
    });
    const view = render(
      <App
        client={client}
        locationPathname="/configuracoes/estabelecimentos"
      />,
    );

    await screen.findByRole("heading", { name: "Cadastrar estabelecimento" });
    fireEvent.change(screen.getByLabelText("CNPJ"), {
      target: { value: "11.222.333/0001-81" },
    });
    fireEvent.change(screen.getByLabelText("Nome comercial"), {
      target: { value: "Loja Centro" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );

    expect(
      await screen.findByRole("option", { name: "Loja Centro" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toHaveValue("store-created");
    expect(client.createEstablishment).toHaveBeenCalledWith("tenant-a", {
      cnpj: "11.222.333/0001-81",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      tradeName: "Loja Centro",
    });
    view.rerender(<App client={client} locationPathname="/compliance" />);
    expect(await screen.findByText("Não iniciado")).toBeVisible();
  });

  it("mostra step-up sem formulário quando a capability exige MFA", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([], "mfa_required"),
    );
    render(
      <App
        client={client}
        locationPathname="/configuracoes/estabelecimentos"
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Confirmar acesso corporativo" }),
    ).toHaveAttribute("href", "/api/auth/login");
    expect(screen.queryByLabelText("CNPJ")).toBeNull();
    expect(client.createEstablishment).not.toHaveBeenCalled();
  });

  it("descarta estabelecimentos de uma resposta atrasada do tenant anterior", async () => {
    const lateSouth = deferred<BrowserEstablishmentCollection>();
    const currentNorth = deferred<BrowserEstablishmentCollection>();
    let northCalls = 0;
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [
        { displayName: "Revenda Norte", tenantId: "tenant-a" },
        { displayName: "Revenda Sul", tenantId: "tenant-b" },
      ],
    );
    vi.mocked(client.loadEstablishments).mockImplementation((tenantId) => {
      if (tenantId === "tenant-b") return lateSouth.promise;
      northCalls += 1;
      return northCalls === 1
        ? Promise.resolve(
            collection([{ id: "store-a", tradeName: "Loja Norte" }]),
          )
        : currentNorth.promise;
    });
    render(<App client={client} />);

    const selector = await screen.findByRole("combobox", {
      name: "Organização ativa",
    });
    fireEvent.change(selector, { target: { value: "tenant-b" } });
    fireEvent.change(selector, { target: { value: "tenant-a" } });
    currentNorth.resolve(
      collection([{ id: "store-a2", tradeName: "Loja Norte 2" }]),
    );
    expect(
      await screen.findByRole("option", { name: "Loja Norte 2" }),
    ).toBeVisible();

    lateSouth.resolve(
      collection([{ id: "store-b", tradeName: "Loja Sul atrasada" }]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Loja Sul atrasada" }),
      ).toBeNull(),
    );
  });

  it("ignora erro tardio do cadastro sem recarregar o tenant anterior", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    const creation = deferred<{
      establishment: BrowserEstablishment;
      renaveLink: { status: "not_started" };
    }>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [
        { displayName: "Revenda Norte", tenantId: "tenant-a" },
        { displayName: "Revenda Sul", tenantId: "tenant-b" },
      ],
    );
    vi.mocked(client.loadEstablishments).mockImplementation(async (tenantId) =>
      tenantId === "tenant-a"
        ? collection([], "available")
        : collection([{ id: "store-b", tradeName: "Loja Sul" }], "available"),
    );
    vi.mocked(client.createEstablishment).mockReturnValue(creation.promise);
    render(
      <App
        client={client}
        locationPathname="/configuracoes/estabelecimentos"
      />,
    );

    await screen.findByRole("heading", { name: "Cadastrar estabelecimento" });
    fireEvent.change(screen.getByLabelText("CNPJ"), {
      target: { value: "11.222.333/0001-81" },
    });
    fireEvent.change(screen.getByLabelText("Nome comercial"), {
      target: { value: "Loja Norte" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Organização ativa" }),
      { target: { value: "tenant-b" } },
    );
    expect(
      await screen.findByRole("option", { name: "Loja Sul" }),
    ).toBeVisible();

    creation.reject(
      new EstablishmentCreationClientError(404, "TENANT_RESOURCE_NOT_FOUND"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Organização ativa" }),
      ).toHaveValue("tenant-b"),
    );
    expect(client.loadEstablishments).toHaveBeenCalledTimes(2);
    expect(client.loadEstablishments).toHaveBeenLastCalledWith("tenant-b");
    expect(screen.queryByText(/contexto anterior foi preservado/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("encerra por callback POST e remove o painel localmente", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "development",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    const redirect = vi.fn();
    vi.mocked(client.logout).mockResolvedValue({
      endSessionUrl: "https://id.example/logout",
    });
    render(<App client={client} redirect={redirect} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));

    await waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(redirect).toHaveBeenCalledWith("https://id.example/logout");
  });

  it("recarrega o estado autoritativo após confirmar o vínculo", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "enabled",
      });
    render(<App client={client} locationPathname="/compliance" />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    await waitFor(() =>
      expect(client.runRenaveLinkPreflight).toHaveBeenCalledWith(
        "tenant-a",
        "store-a",
      ),
    );
    expect(await screen.findByText("Habilitado")).toBeVisible();
  });

  it("ignora resposta atrasada do vínculo da loja anterior", async () => {
    const oldLink = deferred<{
      preflightAvailable: boolean;
      status: "rejected";
    }>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([
        { id: "store-a", tradeName: "Loja A" },
        { id: "store-b", tradeName: "Loja B" },
      ]),
    );
    vi.mocked(client.loadRenaveLinkStatus).mockImplementation(
      async (_tenantId, establishmentId) =>
        establishmentId === "store-a"
          ? oldLink.promise
          : { preflightAvailable: true, status: "confirmed" },
    );
    render(<App client={client} locationPathname="/compliance" />);

    const establishment = await screen.findByRole("combobox", {
      name: "Estabelecimento ativo",
    });
    fireEvent.change(establishment, { target: { value: "store-b" } });
    expect(await screen.findByText("Confirmado")).toBeVisible();

    oldLink.resolve({ preflightAvailable: true, status: "rejected" });
    await waitFor(() => expect(screen.queryByText("Rejeitado")).toBeNull());
  });

  it("ignora prontidão atrasada da loja anterior sem apagar o vínculo atual", async () => {
    const oldReadiness = deferred<BrowserRenaveReadiness>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([
        { id: "store-a", tradeName: "Loja A" },
        { id: "store-b", tradeName: "Loja B" },
      ]),
    );
    vi.mocked(client.loadRenaveLinkStatus).mockResolvedValue({
      preflightAvailable: true,
      status: "confirmed",
    });
    vi.mocked(client.loadRenaveReadiness).mockImplementation(
      async (_tenantId, establishmentId) =>
        establishmentId === "store-a"
          ? oldReadiness.promise
          : {
              certificate: "warning",
              environment: "homologation",
              establishmentContact: "pending",
              integration: "configured",
              link: "confirmed",
              mutations: "blocked",
              operatorIdentity: "verified",
              queries: "ready",
            },
    );
    render(<App client={client} locationPathname="/compliance" />);

    const establishment = await screen.findByRole("combobox", {
      name: "Estabelecimento ativo",
    });
    fireEvent.change(establishment, { target: { value: "store-b" } });
    const readiness = await screen.findByRole("region", {
      name: "Prontidão da integração",
    });
    expect(readiness).toHaveTextContent("Atenção");
    expect(screen.getByText("Confirmado")).toBeVisible();

    oldReadiness.resolve({
      certificate: "blocked",
      environment: "homologation",
      establishmentContact: "unavailable",
      integration: "disabled",
      link: "rejected",
      mutations: "blocked",
      operatorIdentity: "pending",
      queries: "blocked",
    });
    await waitFor(() => {
      expect(readiness).toHaveTextContent("Atenção");
      expect(readiness).not.toHaveTextContent("Desabilitada");
    });
    expect(screen.getByText("Confirmado")).toBeVisible();
  });

  it("preserva o estado e permite repetir quando o preflight falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja A" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      });
    vi.mocked(client.runRenaveLinkPreflight)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce(undefined);
    render(<App client={client} locationPathname="/compliance" />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /a verificação não foi concluída/i,
    );
    expect(screen.getByText("Pendente")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByText("Confirmado")).toBeVisible();
    expect(client.runRenaveLinkPreflight).toHaveBeenCalledTimes(2);
  });

  it("recarrega a rejeição autoritativa mesmo quando o POST falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja A" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "rejected",
      });
    vi.mocked(client.runRenaveLinkPreflight).mockRejectedValueOnce(
      new Error("identity mismatch"),
    );
    render(<App client={client} locationPathname="/compliance" />);

    expect(await screen.findByText("Confirmado")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByText("Rejeitado")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /a verificação não foi concluída/i,
    );
  });

  it("permite recarregar o vínculo quando a leitura falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja A" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      });
    render(<App client={client} locationPathname="/compliance" />);

    const retry = await screen.findByRole("button", {
      name: "Tentar carregar vínculo",
    });
    expect(retry).not.toHaveAccessibleDescription(/exige configuração/i);
    fireEvent.click(retry);
    expect(await screen.findByText("Confirmado")).toBeVisible();
    expect(client.loadRenaveLinkStatus).toHaveBeenCalledTimes(2);
  });

  it("não transfere o spinner do preflight para outra loja", async () => {
    const pendingPreflight = deferred<void>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([
        { id: "store-a", tradeName: "Loja A" },
        { id: "store-b", tradeName: "Loja B" },
      ]),
    );
    vi.mocked(client.loadRenaveLinkStatus).mockResolvedValue({
      preflightAvailable: true,
      status: "pending",
    });
    vi.mocked(client.runRenaveLinkPreflight).mockReturnValue(
      pendingPreflight.promise,
    );
    render(<App client={client} locationPathname="/compliance" />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
      { target: { value: "store-b" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Verificar vínculo" }),
      ).not.toHaveAttribute("data-loading", "true"),
    );
    pendingPreflight.resolve(undefined);
    await waitFor(() => expect(screen.queryByText("Confirmado")).toBeNull());
  });

  it("não contorna perfis verificados mesmo com a feature flag ativa", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja A" }]),
    );
    vi.mocked(client.loadRenaveLinkStatus).mockResolvedValue({
      preflightAvailable: false,
      status: "enabled",
    });
    vi.mocked(client.loadRenaveReadiness).mockResolvedValue({
      certificate: "ready",
      environment: "homologation",
      establishmentContact: "pending",
      integration: "configured",
      link: "enabled",
      mutations: "blocked",
      operatorIdentity: "pending",
      queries: "ready",
    });

    render(
      <App
        client={client}
        locationPathname="/estoque/entrada"
        stockEntryOperationsEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Dar entrada — veículo usado",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Registrar solicitação local" }),
    ).toBeNull();
    expect(screen.getByText(/capability explícita/i)).toBeVisible();
  });

  it("carrega a fila somente para administração com MFA disponível", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Administradora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }], "available"),
    );
    vi.mocked(client.loadCredentialLinkQueue).mockResolvedValue({
      items: [
        {
          establishment: { id: "store-a", tradeName: "Loja Norte" },
          renaveLink: { status: "pending" },
        },
      ],
      truncated: false,
    });

    render(<App client={client} locationPathname="/compliance" />);

    expect(
      await screen.findByRole("heading", {
        name: "Fila de vínculos Credencia",
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(client.loadCredentialLinkQueue).toHaveBeenCalledWith("tenant-a"),
    );
    expect(await screen.findByText("Pendente de verificação")).toBeVisible();
  });

  it("não consulta nem mostra a fila sem capability administrativa", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue(
      collection([{ id: "store-a", tradeName: "Loja Norte" }], "denied"),
    );

    render(<App client={client} locationPathname="/compliance" />);

    expect(
      await screen.findByRole("heading", {
        name: "Conformidade e integração",
      }),
    ).toBeVisible();
    expect(client.loadCredentialLinkQueue).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Fila de vínculos Credencia" }),
    ).toBeNull();
  });

  it("distingue indisponibilidade de sessão e permite tentar novamente", async () => {
    const client = clientFor({
      authenticated: false,
      authMode: "oidc",
      environment: "development",
    });
    vi.mocked(client.load)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce({
        authenticated: false,
        authMode: "oidc",
        environment: "development",
      });
    render(<App client={client} />);

    expect(
      await screen.findByRole("heading", {
        name: "Não foi possível verificar o acesso",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "Não foi possível verificar o acesso",
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(client.load).toHaveBeenCalledTimes(2);
  });

  it("distingue falha do diretório e informa que a sessão segue ativa", async () => {
    const client = clientFor({
      authenticated: true,
      authMode: "oidc",
      environment: "homologation",
      expiresAt: "2026-11-24T00:00:00.000Z",
      user: { name: "Operadora" },
    });
    vi.mocked(client.loadTenants).mockRejectedValueOnce(
      new Error("diretório indisponível"),
    );
    render(<App client={client} />);

    expect(
      await screen.findByRole("heading", {
        name: "Não foi possível carregar sua organização",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "Não foi possível carregar sua organização",
    );
    expect(screen.getByText(/sua sessão continua ativa/i)).toBeVisible();
    expect(screen.queryByText(/a sessão não foi alterada/i)).toBeNull();
  });
});
