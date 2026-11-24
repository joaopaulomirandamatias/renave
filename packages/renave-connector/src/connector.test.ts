import { describe, expect, it, vi } from "vitest";

import {
  InvalidStockPlateQueryError,
  prepareRenaveMutation,
  RenaveConnector,
  RenaveIdentityMismatchError,
  RenaveQueryConnector,
  RenaveVehicleLookupConnector,
  type AuthenticatedClientIdentity,
  type EstablishmentHeaders,
  type RenaveServerContext,
  type RenaveTransport,
  type RenaveVehicleLookupTransport,
  type PreparedRenaveMutation,
  type StockEntryRequest,
} from "./index.js";

const context: RenaveServerContext = {
  environment: "homologation",
  establishmentCnpj: "85.106.037/0005-85",
  establishmentId: "establishment-a",
  integratorCnpj: "69.418.503/0001-88",
  tenantId: "tenant-a",
};

function transportWithIdentity(identity: AuthenticatedClientIdentity) {
  const getAuthenticatedClient = vi.fn(async () => identity);
  const mutate = vi.fn(
    async (
      _headers: EstablishmentHeaders,
      _prepared: PreparedRenaveMutation,
    ) => ({ operationId: "op-1" }),
  );
  const transport: RenaveTransport = {
    environment: "homologation",
    findRecentStocks: vi.fn(async () => []),
    findStockById: vi.fn(async () => ({})),
    findStocksByPlate: vi.fn(async () => []),
    getAuthenticatedClient,
    getVehicleEligibility: vi.fn(async () => ({
      diagnostico: { veiculoApto: true },
    })),
    mutate: async <TResult>(
      headers: EstablishmentHeaders,
      prepared: PreparedRenaveMutation,
    ) => (await mutate(headers, prepared)) as TResult,
  };
  return { getAuthenticatedClient, mutate, transport };
}

describe("RenaveVehicleLookupConnector", () => {
  it("normaliza a placa e confirma a identidade em toda consulta", async () => {
    const getAuthenticatedClient = vi.fn(async () => ({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    }));
    const getVehicleByPlate = vi.fn(async () => ({
      placa: "QTP4H82",
      restricoes: [],
    }));
    const transport: RenaveVehicleLookupTransport = {
      environment: "homologation",
      getAuthenticatedClient,
      getVehicleByPlate,
    };
    const connector = new RenaveVehicleLookupConnector(transport);

    await connector.getVehicleByPlate(context, " qtp4h82 ");
    await connector.getVehicleByPlate(context, "QTP4H82");

    expect(getAuthenticatedClient).toHaveBeenCalledTimes(2);
    expect(getAuthenticatedClient).toHaveBeenCalledWith({
      "CNPJ-Estabelecimento": "85106037000585",
    });
    expect(getVehicleByPlate).toHaveBeenCalledTimes(2);
    expect(getVehicleByPlate).toHaveBeenLastCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      "QTP4H82",
      undefined,
    );
    expect("mutate" in connector).toBe(false);
    expect(Object.isFrozen(connector)).toBe(true);
  });

  it("bloqueia produção antes da rede", async () => {
    const getAuthenticatedClient = vi.fn();
    const getVehicleByPlate = vi.fn();
    const connector = new RenaveVehicleLookupConnector({
      environment: "production",
      getAuthenticatedClient,
      getVehicleByPlate,
    });

    await expect(
      connector.getVehicleByPlate(
        { ...context, environment: "production" },
        "QTP4H82",
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(getAuthenticatedClient).not.toHaveBeenCalled();
    expect(getVehicleByPlate).not.toHaveBeenCalled();
  });

  it.each(["ABC-1234", "1234ABC", "QTP4H8", "QTP4H820"])(
    "recusa placa fora do formato oficial antes de autenticar: %s",
    async (plate) => {
      const getAuthenticatedClient = vi.fn();
      const getVehicleByPlate = vi.fn();
      const connector = new RenaveVehicleLookupConnector({
        environment: "homologation",
        getAuthenticatedClient,
        getVehicleByPlate,
      });

      await expect(
        connector.getVehicleByPlate(context, plate),
      ).rejects.toMatchObject({ code: "INVALID_VEHICLE_PLATE_QUERY" });
      expect(getAuthenticatedClient).not.toHaveBeenCalled();
      expect(getVehicleByPlate).not.toHaveBeenCalled();
    },
  );
});

describe("RenaveQueryConnector", () => {
  it("expõe somente consultas e preserva a confirmação de identidade", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const { mutate: _mutate, ...queryTransport } = fake.transport;
    const connector = new RenaveQueryConnector(queryTransport);
    vi.mocked(queryTransport.findStockById).mockResolvedValue({
      estado: "CONFIRMADO",
      id: 7,
      placa: "QTP4H82",
    });

    await expect(
      connector.getVehicleEligibility(context, {
        placa: "qtp4h82",
        tipoCrv: "DIGITAL",
      }),
    ).resolves.toMatchObject({
      result: { diagnostico: { veiculoApto: true } },
      verifiedIdentity: {
        confirmedEstablishmentCnpj: "85106037000585",
        confirmedIntegratorCnpj: "69418503000188",
      },
    });
    await expect(connector.getStockById(context, 7)).resolves.toMatchObject({
      result: {
        publicResult: {
          estado: "CONFIRMADO",
          id: 7,
          placa: "QTP4H82",
          restricoes: [],
        },
      },
    });

    expect("mutate" in connector).toBe(false);
    expect("executeMutation" in connector).toBe(false);
    expect("requestStockEntry" in connector).toBe(false);
    expect(fake.mutate).not.toHaveBeenCalled();
  });
});

describe("RenaveConnector", () => {
  it("confirma o vínculo sem executar consulta ou mutação", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).verifyIdentity(context),
    ).resolves.toMatchObject({
      confirmedEstablishmentCnpj: "85106037000585",
      confirmedIntegratorCnpj: "69418503000188",
    });
    expect(fake.getAuthenticatedClient).toHaveBeenCalledOnce();
    expect(fake.transport.getVehicleEligibility).not.toHaveBeenCalled();
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it("confirma as duas identidades antes da mutação", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    const response = await new RenaveConnector(fake.transport).executeMutation<{
      operationId: string;
    }>(context, "request-stock-entry", { placa: "QTP4H82" });

    expect(response.result).toEqual({ operationId: "op-1" });
    expect(response.verifiedIdentity).toMatchObject({
      confirmedEstablishmentCnpj: "85106037000585",
      confirmedIntegratorCnpj: "69418503000188",
    });
    expect(fake.getAuthenticatedClient).toHaveBeenCalledWith({
      "CNPJ-Estabelecimento": "85106037000585",
    });
    expect(fake.mutate).toHaveBeenCalledTimes(1);
  });

  it("recusa operação desconhecida antes de autenticar ou serializar", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const toJSON = vi.fn(() => ({ placa: "QTP4H82" }));

    await expect(
      new RenaveConnector(fake.transport).executeMutation(
        context,
        "unknown" as "request-stock-entry",
        { toJSON },
      ),
    ).rejects.toMatchObject({ reason: "OPERATION" });
    expect(toJSON).not.toHaveBeenCalled();
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it("reutiliza os mesmos bytes preparados e revalida identidade a cada envio", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const connector = new RenaveConnector(fake.transport);
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      observacao: "ação 🚗",
    });

    const first = await connector.executePreparedMutation(context, prepared);
    const second = await connector.executePreparedMutation(context, prepared);

    expect(first.requestSha256).toBe(prepared.requestSha256);
    expect(second.requestSha256).toBe(prepared.requestSha256);
    expect(fake.getAuthenticatedClient).toHaveBeenCalledTimes(2);
    expect(fake.mutate).toHaveBeenCalledTimes(2);
    expect(fake.mutate.mock.calls[0]![1]).toBe(prepared);
    expect(fake.mutate.mock.calls[1]![1]).toBe(prepared);
  });

  it.each([
    [
      "ESTABLISHMENT_MISSING",
      { cnpj: null, cnpjIntegradora: "69418503000188" },
    ],
    [
      "ESTABLISHMENT_MISMATCH",
      { cnpj: "00000000000000", cnpjIntegradora: "69418503000188" },
    ],
    ["INTEGRATOR_MISSING", { cnpj: "85106037000585", cnpjIntegradora: null }],
    [
      "INTEGRATOR_MISMATCH",
      { cnpj: "85106037000585", cnpjIntegradora: "00000000000000" },
    ],
  ] as const)(
    "bloqueia sem POST quando ocorre %s",
    async (reason, identity) => {
      const fake = transportWithIdentity(identity);
      const connector = new RenaveConnector(fake.transport);

      await expect(
        connector.executeMutation(context, "request-stock-entry", {}),
      ).rejects.toMatchObject({
        code: "RENAVE_IDENTITY_MISMATCH",
        reason,
      });
      expect(fake.mutate).not.toHaveBeenCalled();
    },
  );

  it("não serializa payload quando a identidade é recusada", async () => {
    const fake = transportWithIdentity({
      cnpj: "00000000000000",
      cnpjIntegradora: "69418503000188",
    });
    const toJSON = vi.fn(() => ({ placa: "QTP4H82" }));

    await expect(
      new RenaveConnector(fake.transport).executeMutation(
        context,
        "request-stock-entry",
        { toJSON },
      ),
    ).rejects.toMatchObject({ code: "RENAVE_IDENTITY_MISMATCH" });
    expect(toJSON).not.toHaveBeenCalled();
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it("bloqueia contexto de produção antes de tocar um transporte de homologação", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const connector = new RenaveConnector(fake.transport);

    await expect(
      connector.executeMutation(
        { ...context, environment: "production" },
        "request-stock-entry",
        {},
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it("não serializa payload em contexto de produção", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const toJSON = vi.fn(() => ({ placa: "QTP4H82" }));

    await expect(
      new RenaveConnector(fake.transport).executeMutation(
        { ...context, environment: "production" },
        "request-stock-entry",
        { toJSON },
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(toJSON).not.toHaveBeenCalled();
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
  });

  it("bloqueia produção mesmo quando contexto e transporte coincidem", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const productionTransport: RenaveTransport = {
      ...fake.transport,
      environment: "production",
    };

    await expect(
      new RenaveConnector(productionTransport).executeMutation(
        { ...context, environment: "production" },
        "request-stock-entry",
        {},
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it("bloqueia transporte de produção em contexto de homologação", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const productionTransport: RenaveTransport = {
      ...fake.transport,
      environment: "production",
    };

    await expect(
      new RenaveConnector(productionTransport).getVehicleEligibility(context, {
        placa: "QTP4H82",
        tipoCrv: "DIGITAL",
      }),
    ).rejects.toMatchObject({ code: "RENAVE_ENVIRONMENT_MISMATCH" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(productionTransport.getVehicleEligibility).not.toHaveBeenCalled();
  });

  it("expõe a entrada de estoque como operação de domínio tipada", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const payload: StockEntryRequest = {
      cpfOperadorResponsavel: "12345678901",
      dataCompra: "2026-11-23",
      emailEstabelecimento: "loja@example.com",
      emailVendedor: "vendedor@example.com",
      valorCompra: 89_900,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        dataHoraMedicaoHodometro: "2026-11-23T12:00:00-03:00",
        documentoProprietarioAtual: "12345678901",
        placa: "QTP4H82",
        quilometragemHodometro: 42_000,
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
        tipoDocumentoProprietarioAtual: "CPF",
      },
    };

    const response = await new RenaveConnector(
      fake.transport,
    ).requestStockEntry(context, payload);

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const [sentHeaders, prepared] = fake.mutate.mock.calls[0]!;
    expect(sentHeaders).toEqual({
      "CNPJ-Estabelecimento": "85106037000585",
    });
    expect(prepared.operation).toBe("request-stock-entry");
    expect(
      JSON.parse(new TextDecoder().decode(prepared.copyBodyBytes())),
    ).toEqual(payload);
    expect(response).toMatchObject({
      requestByteLength: prepared.byteLength,
      requestSha256: prepared.requestSha256,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /12345678901|loja@example\.com|QTP4H82/u,
    );
  });

  it("confirma identidade antes de consultar aptidão e normaliza a placa", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).getVehicleEligibility(context, {
        placa: "qtp4h82",
        tipoCrv: "DIGITAL",
      }),
    ).resolves.toMatchObject({
      result: { diagnostico: { veiculoApto: true } },
    });
    expect(fake.transport.getVehicleEligibility).toHaveBeenCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      { placa: "QTP4H82", tipoCrv: "DIGITAL" },
    );
    expect(fake.getAuthenticatedClient).toHaveBeenCalledTimes(1);
  });

  it("consulta estoque por placa com identidade confirmada e devolve apenas o DTO mínimo", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    vi.mocked(fake.transport.findStocksByPlate).mockResolvedValue([
      {
        cancelamentoEstoque: { motivo: "não deve vazar" },
        codigoSegurancaCrv: "12345678901",
        entradaEstoque: { cpfOperadorResponsavel: "12345678901" },
        estado: "CONFIRMADO",
        id: 7,
        numeroCrv: "123456789012",
        placa: "QTP4H82",
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
      },
    ]);

    const response = await new RenaveConnector(fake.transport).getStocksByPlate(
      context,
      " qtp4h82 ",
    );

    expect(response.result.publicResult).toEqual([
      { estado: "CONFIRMADO", id: 7, placa: "QTP4H82" },
    ]);
    expect(response.result.evidence).toHaveLength(1);
    expect(response.result.evidence[0]).toMatchObject({
      codigoSegurancaCrv: "12345678901",
      renavam: "00607701676",
    });
    expect(JSON.stringify(response.result.publicResult)).not.toMatch(
      /cpf|renavam|numeroCrv|codigoSegurancaCrv|cancelamento/,
    );
    expect(fake.transport.findStocksByPlate).toHaveBeenCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      "QTP4H82",
    );
    expect(fake.getAuthenticatedClient).toHaveBeenCalledOnce();
  });

  it("lista estoque recente depois de confirmar identidade e minimiza a projeção pública", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    vi.mocked(fake.transport.findRecentStocks).mockResolvedValue([
      {
        chassi: "9BWZZZ377VT004251",
        codigoSegurancaCrv: "12345678901",
        entradaEstoque: {
          cpfOperadorResponsavel: "12345678901",
          dataHoraRegistro: "2026-11-23T15:02",
        },
        estado: "CONFIRMADO",
        id: 7,
        numeroCrv: "123456789012",
        placa: "QTP4H82",
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
      },
    ]);

    const response = await new RenaveConnector(fake.transport).getRecentStocks(
      context,
    );

    expect(response.result.publicResult).toEqual([
      {
        chassi: "9BWZZZ377VT004251",
        dataHoraRegistroEntrada: "2026-11-23T15:02",
        estado: "CONFIRMADO",
        id: 7,
        placa: "QTP4H82",
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
      },
    ]);
    expect(response.result.evidence[0]).toMatchObject({
      codigoSegurancaCrv: "12345678901",
      numeroCrv: "123456789012",
    });
    expect(JSON.stringify(response.result.publicResult)).not.toMatch(
      /cpf|numeroCrv|codigoSegurancaCrv|cancelamento/,
    );
    expect(fake.transport.findRecentStocks).toHaveBeenCalledWith({
      "CNPJ-Estabelecimento": "85106037000585",
    });
    expect(
      fake.getAuthenticatedClient.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fake.transport.findRecentStocks).mock.invocationCallOrder[0]!,
    );
  });

  it("consulta detalhe por ID após a identidade e separa evidência da projeção mínima", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const evidence = {
      cancelamentoEstoque: {
        dataHoraCancelamentoEstoque: "2026-11-24T11:00:00-03:00",
        motivoCancelamentoEstoque: "DESISTENCIA",
      },
      chassi: "9BWZZZ377VT004251",
      codigoSegurancaCrv: "12345678901",
      dataHoraMedicaoHodometro: "2026-11-23T14:58:00-03:00",
      entradaEstoque: {
        cpfOperadorResponsavel: "12345678901",
        dataHora: "2026-11-23T15:00:00-03:00",
        dataHoraRegistro: "2026-11-23T15:02:00-03:00",
        vendedor: { cpf: "98765432100" },
      },
      estado: "CONFIRMADO" as const,
      id: 7,
      numeroCrv: "123456789012",
      notaFiscal: { chave: "nao-vazar" },
      placa: "QTP4H82",
      quilometragemHodometro: 42000,
      renavam: "00607701676",
      restricoesVeiculo: [
        { codigoTipoRestricao: "JUD", tipoRestricao: "JUDICIAL" },
      ],
      saidaEstoque: {
        comprador: { cpf: "11122233344" },
        cpfOperadorResponsavel: "12345678901",
        dataHora: "2026-11-24T10:00:00-03:00",
        dataHoraRegistro: "2026-11-24T10:01:00-03:00",
        motivo: "VENDA",
        notaFiscal: { chave: "nao-vazar" },
      },
      tipoCrv: "DIGITAL" as const,
    };
    vi.mocked(fake.transport.findStockById).mockResolvedValue(evidence);
    const controller = new AbortController();

    const response = await new RenaveConnector(fake.transport).getStockById(
      context,
      7,
      { signal: controller.signal },
    );

    expect(response.result.evidence).toBe(evidence);
    expect(response.result.publicResult).toEqual({
      cancelamento: {
        dataHora: "2026-11-24T11:00:00-03:00",
        motivo: "DESISTENCIA",
      },
      chassi: "9BWZZZ377VT004251",
      dataHoraMedicaoHodometro: "2026-11-23T14:58:00-03:00",
      entrada: {
        dataHora: "2026-11-23T15:00:00-03:00",
        dataHoraRegistro: "2026-11-23T15:02:00-03:00",
      },
      estado: "CONFIRMADO",
      id: 7,
      placa: "QTP4H82",
      quilometragemHodometro: 42000,
      renavam: "00607701676",
      restricoes: [{ codigoTipo: "JUD", tipo: "JUDICIAL" }],
      saida: {
        dataHora: "2026-11-24T10:00:00-03:00",
        dataHoraRegistro: "2026-11-24T10:01:00-03:00",
        motivo: "VENDA",
      },
      tipoCrv: "DIGITAL",
    });
    expect(JSON.stringify(response.result.publicResult)).not.toMatch(
      /cpf|numeroCrv|codigoSegurancaCrv|vendedor|comprador|notaFiscal/i,
    );
    expect(fake.getAuthenticatedClient).toHaveBeenCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      { signal: controller.signal },
    );
    expect(fake.transport.findStockById).toHaveBeenCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      7,
      { signal: controller.signal },
    );
    expect(
      fake.getAuthenticatedClient.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fake.transport.findStockById).mock.invocationCallOrder[0]!,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "recusa ID de estoque inválido antes da identidade e da leitura: %s",
    async (stockId) => {
      const fake = transportWithIdentity({
        cnpj: "85106037000585",
        cnpjIntegradora: "69418503000188",
      });

      await expect(
        new RenaveConnector(fake.transport).getStockById(context, stockId),
      ).rejects.toMatchObject({ code: "INVALID_STOCK_ID_QUERY" });
      expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(fake.transport.findStockById).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ID divergente", { estado: "CONFIRMADO", id: 8, placa: "QTP4H82" }],
    [
      "hodômetro decimal",
      {
        estado: "CONFIRMADO",
        id: 7,
        placa: "QTP4H82",
        quilometragemHodometro: 1.5,
      },
    ],
    [
      "data inválida",
      {
        dataHoraMedicaoHodometro: "ontem",
        estado: "CONFIRMADO",
        id: 7,
        placa: "QTP4H82",
      },
    ],
  ])("falha fechado no detalhe com %s", async (_label, record) => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    vi.mocked(fake.transport.findStockById).mockResolvedValue(record as never);

    await expect(
      new RenaveConnector(fake.transport).getStockById(context, 7),
    ).rejects.toMatchObject({ code: "RENAVE_STOCK_QUERY_RESULT_INVALID" });
  });

  it("bloqueia detalhe em produção antes de qualquer rede", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const productionTransport: RenaveTransport = {
      ...fake.transport,
      environment: "production",
    };

    await expect(
      new RenaveConnector(productionTransport).getStockById(
        { ...context, environment: "production" },
        7,
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.transport.findStockById).not.toHaveBeenCalled();
  });

  it("falha fechado quando o inventário recente contém tipos incompatíveis", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    vi.mocked(fake.transport.findRecentStocks).mockResolvedValue([
      {
        estado: "CONFIRMADO",
        id: 7,
        placa: "QTP4H82",
        renavam: 607701676 as never,
      },
    ]);

    await expect(
      new RenaveConnector(fake.transport).getRecentStocks(context),
    ).rejects.toMatchObject({ code: "RENAVE_STOCK_QUERY_RESULT_INVALID" });
  });

  it("mantém estoque cancelado na evidência sem apresentá-lo como ativo", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    vi.mocked(fake.transport.findRecentStocks).mockResolvedValue([
      {
        cancelamentoEstoque: { motivo: "cancelado" },
        estado: "CONFIRMADO",
        id: 7,
        placa: "QTP4H82",
      },
    ]);

    const response = await new RenaveConnector(fake.transport).getRecentStocks(
      context,
    );

    expect(response.result.evidence).toHaveLength(1);
    expect(response.result.publicResult).toEqual([]);
  });

  it.each([undefined, null, "", "ABC123", "ABC-1234", "ABCDEFGH"])(
    "recusa placa inválida %s antes de autenticar ou consultar estoque",
    async (plate) => {
      const fake = transportWithIdentity({
        cnpj: "85106037000585",
        cnpjIntegradora: "69418503000188",
      });

      await expect(
        new RenaveConnector(fake.transport).getStocksByPlate(
          context,
          plate as never,
        ),
      ).rejects.toBeInstanceOf(InvalidStockPlateQueryError);
      expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(fake.transport.findStocksByPlate).not.toHaveBeenCalled();
    },
  );

  it("bloqueia consulta de estoque quando a identidade diverge", async () => {
    const fake = transportWithIdentity({
      cnpj: "00000000000000",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).getStocksByPlate(context, "QTP4H82"),
    ).rejects.toBeInstanceOf(RenaveIdentityMismatchError);
    expect(fake.transport.findStocksByPlate).not.toHaveBeenCalled();
  });

  it("bloqueia consulta de estoque em produção antes de autenticar", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).getStocksByPlate(
        { ...context, environment: "production" },
        "QTP4H82",
      ),
    ).rejects.toMatchObject({ code: "RENAVE_PRODUCTION_BLOCKED" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.transport.findStocksByPlate).not.toHaveBeenCalled();
  });

  it.each([
    { records: [{ estado: "CONFIRMADO", id: 7, placa: "OUT1A23" }] },
    { records: [{ estado: "DESCONHECIDO", id: 7, placa: "QTP4H82" }] },
    { records: [{ estado: "CONFIRMADO", placa: "QTP4H82" }] },
  ])(
    "falha fechado para estoque incompatível: $records",
    async ({ records }) => {
      const fake = transportWithIdentity({
        cnpj: "85106037000585",
        cnpjIntegradora: "69418503000188",
      });
      vi.mocked(fake.transport.findStocksByPlate).mockResolvedValue(
        records as never,
      );

      await expect(
        new RenaveConnector(fake.transport).getStocksByPlate(
          context,
          "QTP4H82",
        ),
      ).rejects.toMatchObject({ code: "RENAVE_STOCK_QUERY_RESULT_INVALID" });
    },
  );

  it.each([
    ["placa nula", { placa: null, tipoCrv: "DIGITAL" }],
    ["placa vazia", { placa: "", tipoCrv: "DIGITAL" }],
    ["tipo CRV desconhecido", { placa: "QTP4H82", tipoCrv: "PAPEL" }],
  ])("bloqueia %s antes de autenticar", async (_label, query) => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).getVehicleEligibility(
        context,
        query as never,
      ),
    ).rejects.toMatchObject({ code: "INVALID_VEHICLE_ELIGIBILITY_QUERY" });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.transport.getVehicleEligibility).not.toHaveBeenCalled();
  });

  it("bloqueia consulta ambígua antes de qualquer chamada ao RENAVE", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });

    await expect(
      new RenaveConnector(fake.transport).getVehicleEligibility(context, {
        placa: "QTP4H82",
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_VEHICLE_ELIGIBILITY_QUERY",
      reason: "IDENTIFIER_COUNT",
    });
    expect(fake.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fake.transport.getVehicleEligibility).not.toHaveBeenCalled();
  });

  it("reconcilia entrada somente depois de confirmar identidade", async () => {
    const fake = transportWithIdentity({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    const request: StockEntryRequest = {
      cpfOperadorResponsavel: "12345678901",
      dataCompra: "2026-11-23",
      emailEstabelecimento: "loja@example.com",
      emailVendedor: "vendedor@example.com",
      valorCompra: 89_900,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        dataHoraMedicaoHodometro: "2026-11-23T12:00:00-03:00",
        documentoProprietarioAtual: "12345678901",
        placa: "qtp4h82",
        quilometragemHodometro: 42_000,
        tipoCrv: "DIGITAL",
        tipoDocumentoProprietarioAtual: "CPF",
      },
    };

    await expect(
      new RenaveConnector(fake.transport).reconcileStockEntry(
        context,
        request,
        {
          observedAt: new Date("2026-11-23T15:10:00.000Z"),
          sentAt: new Date("2026-11-23T15:00:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({ result: { outcome: "not_observed" } });
    expect(fake.transport.findStocksByPlate).toHaveBeenCalledWith(
      { "CNPJ-Estabelecimento": "85106037000585" },
      "QTP4H82",
    );
    expect(fake.getAuthenticatedClient).toHaveBeenCalledTimes(1);
  });
});
