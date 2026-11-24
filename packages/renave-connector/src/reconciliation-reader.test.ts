import { describe, expect, it, vi } from "vitest";

import {
  HttpRenaveTransport,
  isRenaveReconciliationReader,
  readRenaveReconciliation,
  RenaveReconciliationReadError,
  RenaveReconciliationReader,
  type RenaveReadOnlyTransport,
  type RenaveServerContext,
  type StockEntryReconciliationRequest,
} from "./index.js";

const context: RenaveServerContext = {
  environment: "homologation",
  establishmentCnpj: "85.106.037/0005-85",
  establishmentId: "establishment-a",
  integratorCnpj: "69.418.503/0001-88",
  tenantId: "tenant-a",
};

const projection: StockEntryReconciliationRequest = {
  cpfOperadorResponsavel: "12345678901",
  veiculo: {
    codigoSegurancaCrv: "12345678901",
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    renavam: "12345678901",
    tipoCrv: "DIGITAL",
  },
};

function transport(records: unknown[] = []): RenaveReadOnlyTransport {
  return {
    environment: "homologation",
    findRecentStocks: vi.fn(async () => records as never),
    findStocksByPlate: vi.fn(async () => records as never),
    getAuthenticatedClient: vi.fn(async () => ({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    })),
  };
}

describe("RenaveReconciliationReader", () => {
  it("é nominal, congelado e não torna transporte/clock recuperáveis", async () => {
    const fake = transport([]) as RenaveReadOnlyTransport & {
      mutate?: () => never;
    };
    fake.mutate = () => {
      throw new Error("POST proibido");
    };
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport: fake,
    });
    expect(isRenaveReconciliationReader(reader)).toBe(true);
    expect(Object.keys(reader)).toEqual([]);
    expect("transport" in reader).toBe(false);
    expect("mutate" in reader).toBe(false);
    expect(JSON.stringify(reader)).toBe("{}");
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.isFrozen(RenaveReconciliationReader.prototype)).toBe(true);
    expect(Object.isFrozen(RenaveReconciliationReader)).toBe(true);

    const forged = Object.create(
      RenaveReconciliationReader.prototype,
    ) as RenaveReconciliationReader;
    const proxied = new Proxy(reader, {});
    for (const candidate of [forged, proxied]) {
      expect(isRenaveReconciliationReader(candidate)).toBe(false);
      await expect(
        readRenaveReconciliation(candidate, context, projection, {
          sentAt: new Date("2026-11-24T10:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ category: "PROTOCOL" });
    }
    class Subclass extends RenaveReconciliationReader {}
    expect(
      () =>
        new Subclass({
          now: () => new Date(),
          transport: fake,
        }),
    ).toThrow(expect.objectContaining({ category: "PROTOCOL" }));
  });

  it("captura capabilities uma vez e ignora mutação posterior", async () => {
    const original = transport([]);
    const options = {
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport: original,
    };
    const reader = new RenaveReconciliationReader(options);
    original.getAuthenticatedClient = vi.fn(async () => {
      throw new Error("victim");
    });
    original.findStocksByPlate = vi.fn(async () => {
      throw new Error("victim");
    });
    options.now = () => {
      throw new Error("victim");
    };
    await expect(
      readRenaveReconciliation(reader, context, projection, {
        sentAt: new Date("2026-11-24T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "not_observed" });
  });

  it("expõe somente leitura, propaga signal e devolve state/observedAt sem PII", async () => {
    const observedAt = new Date("2026-11-24T10:00:30.000Z");
    const fake = transport([
      {
        codigoSegurancaCrv: "12345678901",
        entradaEstoque: {
          cpfOperadorResponsavel: "12345678901",
          dataHoraRegistro: "2026-11-24T10:00:10.000Z",
        },
        estado: "CONFIRMADO",
        id: 7,
        numeroCrv: "123456789012",
        placa: "QTP4H82",
        renavam: "12345678901",
        tipoCrv: "DIGITAL",
      },
    ]);
    const signal = new AbortController().signal;
    const reader = new RenaveReconciliationReader({
      now: () => observedAt,
      transport: fake,
    });
    const confirmed = await reader.reconcileStockEntry(context, projection, {
      sentAt: new Date("2026-11-24T10:00:00.000Z"),
      signal,
    });
    expect(confirmed).toEqual({
      observedAt,
      outcome: "confirmed",
      remoteRecordId: 7,
      remoteState: "CONFIRMADO",
    });
    expect(confirmed.observedAt).not.toBe(observedAt);
    expect(JSON.stringify(confirmed)).not.toMatch(
      /QTP4H82|12345678901|85106037000585/u,
    );
    expect("mutate" in fake).toBe(false);
    expect(fake.getAuthenticatedClient).toHaveBeenLastCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      { signal },
    );
    expect(fake.findStocksByPlate).toHaveBeenLastCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      "QTP4H82",
      { signal },
    );
  });

  it("captura janela expirada imediatamente após GET", async () => {
    const fake = transport([]);
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T11:00:00.001Z"),
      transport: fake,
    });
    await expect(
      reader.reconcileStockEntry(context, projection, {
        sentAt: new Date("2026-11-24T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "window_expired" });
    expect(fake.findStocksByPlate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      category: "TRANSIENT",
      configure: (fake: RenaveReadOnlyTransport) =>
        vi.mocked(fake.findStocksByPlate).mockRejectedValueOnce(
          Object.assign(new Error("cpf=12345678901"), {
            code: "RENAVE_HTTP_ERROR",
            status: 503,
          }),
        ),
    },
    {
      category: "IDENTITY_MISMATCH",
      configure: (fake: RenaveReadOnlyTransport) =>
        vi.mocked(fake.getAuthenticatedClient).mockResolvedValueOnce({
          cnpj: "11222333000181",
          cnpjIntegradora: "69418503000188",
        }),
    },
    {
      category: "PROTOCOL",
      configure: (fake: RenaveReadOnlyTransport) =>
        vi.mocked(fake.findStocksByPlate).mockResolvedValueOnce([
          {
            ...projection.veiculo,
            entradaEstoque: {
              cpfOperadorResponsavel: "12345678901",
              dataHoraRegistro: "2026-11-24T10:00:10.000Z",
            },
            estado: "INVALID" as never,
            id: 7,
          },
        ]),
    },
    {
      category: "PROTOCOL",
      configure: (fake: RenaveReadOnlyTransport) =>
        vi.mocked(fake.findStocksByPlate).mockRejectedValueOnce(
          Object.assign(new Error("rejected"), {
            code: "RENAVE_HTTP_ERROR",
            status: 422,
          }),
        ),
    },
    ...([401, 403] as const).map((status) => ({
      category: "IDENTITY_MISMATCH" as const,
      configure: (fake: RenaveReadOnlyTransport) =>
        vi.mocked(fake.findStocksByPlate).mockRejectedValueOnce(
          Object.assign(new Error("unauthorized"), {
            code: "RENAVE_HTTP_ERROR",
            status,
          }),
        ),
    })),
  ] as const)("sanitiza erro $category", async ({ category, configure }) => {
    const fake = transport([]);
    configure(fake);
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport: fake,
    });
    const error = await reader
      .reconcileStockEntry(context, projection, {
        sentAt: new Date("2026-11-24T10:00:00.000Z"),
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(RenaveReconciliationReadError);
    expect(error).toMatchObject({ category });
    expect(String(error)).not.toMatch(/cpf|12345678901|503/u);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("fecha erro hostil em categoria transitória sem propagar getter", async () => {
    const fake = transport([]);
    vi.mocked(fake.findStocksByPlate).mockRejectedValueOnce(
      new Proxy(new Error("segredo"), {
        get(_target, property) {
          if (property === "code") throw new Error("segredo getter");
          return Reflect.get(_target, property);
        },
      }),
    );
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport: fake,
    });
    await expect(
      reader.reconcileStockEntry(context, projection, {
        sentAt: new Date("2026-11-24T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ category: "TRANSIENT" });
  });

  it("aborta antes da rede e bloqueia transporte de produção", async () => {
    const fake = transport([]);
    const reader = new RenaveReconciliationReader({
      now: () => new Date(),
      transport: fake,
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      reader.reconcileStockEntry(context, projection, {
        sentAt: new Date(),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ category: "ABORTED" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(
      () =>
        new RenaveReconciliationReader({
          now: () => new Date(),
          transport: { ...fake, environment: "production" },
        }),
    ).toThrow(expect.objectContaining({ category: "PROTOCOL" }));
  });

  it("contexto de produção falha antes de qualquer transporte", async () => {
    const fake = transport([]);
    const reader = new RenaveReconciliationReader({
      now: () => new Date(),
      transport: fake,
    });
    await expect(
      readRenaveReconciliation(
        reader,
        { ...context, environment: "production" },
        projection,
        { sentAt: new Date() },
      ),
    ).rejects.toMatchObject({ category: "PROTOCOL" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.findStocksByPlate).not.toHaveBeenCalled();
  });

  it.each([0, 408, 425, 429, 500, 503])(
    "classifica HTTP %i como transitório",
    async (status) => {
      const fake = transport([]);
      vi.mocked(fake.findStocksByPlate).mockRejectedValueOnce(
        Object.assign(new Error("raw secret"), {
          code: "RENAVE_HTTP_ERROR",
          status,
        }),
      );
      const reader = new RenaveReconciliationReader({
        now: () => new Date("2026-11-24T10:00:30.000Z"),
        transport: fake,
      });
      await expect(
        readRenaveReconciliation(reader, context, projection, {
          sentAt: new Date("2026-11-24T10:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ category: "TRANSIENT" });
    },
  );

  it("HttpRenaveTransport combina abort externo com timeout", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal;
      return Response.json({
        cnpj: "85106037000585",
        cnpjIntegradora: "69418503000188",
      });
    });
    const http = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });
    const abort = new AbortController();
    await http.getAuthenticatedClient(
      { "CNPJ-Estabelecimento": "85106037000585" },
      { signal: abort.signal },
    );
    expect(requestSignal).not.toBe(abort.signal);
    abort.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("reader sobre HttpRenaveTransport executa somente dois GETs", async () => {
    const methods: string[] = [];
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      return methods.length === 1
        ? Response.json({
            cnpj: "85106037000585",
            cnpjIntegradora: "69418503000188",
          })
        : Response.json([]);
    });
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport,
    });
    await readRenaveReconciliation(reader, context, projection, {
      sentAt: new Date("2026-11-24T10:00:00.000Z"),
    });
    expect(methods).toEqual(["GET", "GET"]);
    expect(Object.keys(reader)).toEqual([]);
    expect("mutate" in reader).toBe(false);
  });

  it("HttpRenaveTransport é nominal e não permite trocar host/request/timeouts após composição", async () => {
    const urls: string[] = [];
    const request = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      return urls.length === 1
        ? Response.json({
            cnpj: "85106037000585",
            cnpjIntegradora: "69418503000188",
          })
        : Response.json([]);
    });
    const swappedRequest = vi.fn(async () => {
      throw new Error("request trocado");
    });
    const options = {
      environment: "homologation" as const,
      mutationTimeoutMs: 120_000,
      readTimeoutMs: 60_000,
      request,
    };
    const transport = new HttpRenaveTransport(options);
    const reader = new RenaveReconciliationReader({
      now: () => new Date("2026-11-24T10:00:30.000Z"),
      transport,
    });

    expect(Reflect.set(transport, "environment", "production")).toBe(false);
    expect(Reflect.set(transport, "request", swappedRequest)).toBe(false);
    expect(Reflect.set(transport, "readTimeoutMs", 1)).toBe(false);
    expect(Reflect.set(transport, "mutationTimeoutMs", 1)).toBe(false);
    options.environment = "production" as never;
    options.request = swappedRequest;
    options.readTimeoutMs = 1;
    options.mutationTimeoutMs = 1;

    await readRenaveReconciliation(reader, context, projection, {
      sentAt: new Date("2026-11-24T10:00:00.000Z"),
    });
    expect(urls).toHaveLength(2);
    expect(
      urls.every((url) =>
        url.startsWith("https://hom.renave.estaleiro.serpro.gov.br/renave-ws/"),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.startsWith("https://renave."))).toBe(false);
    expect(swappedRequest).not.toHaveBeenCalled();
    expect(Object.keys(transport)).toEqual([]);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.isFrozen(HttpRenaveTransport.prototype)).toBe(true);
    expect(Object.isFrozen(HttpRenaveTransport)).toBe(true);

    const forged = Object.create(
      HttpRenaveTransport.prototype,
    ) as HttpRenaveTransport;
    await expect(
      forged.getAuthenticatedClient({
        "CNPJ-Estabelecimento": "85106037000585",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(
      () =>
        new RenaveReconciliationReader({
          now: () => new Date(),
          transport: new Proxy(transport, {}),
        }),
    ).toThrow(expect.objectContaining({ category: "PROTOCOL" }));
    class Subclass extends HttpRenaveTransport {}
    expect(() => new Subclass(options)).toThrow();
    const Constructor = HttpRenaveTransport as unknown as new (
      input: typeof options,
    ) => HttpRenaveTransport;
    expect(() => Reflect.construct(Constructor, [options], class {})).toThrow();
  });
});
