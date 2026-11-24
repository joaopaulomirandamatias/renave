import { describe, expect, it, vi } from "vitest";

import {
  RenaveConnector,
  RenaveIdentityMismatchError,
  type AuthenticatedClientIdentity,
  type EstablishmentHeaders,
  type RenaveServerContext,
  type RenaveTransport,
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
      _operation: string,
      _headers: EstablishmentHeaders,
      _payload: unknown,
    ) => ({ operationId: "op-1" }),
  );
  const transport: RenaveTransport = {
    environment: "homologation",
    findStocksByPlate: vi.fn(async () => []),
    getAuthenticatedClient,
    getVehicleEligibility: vi.fn(async () => ({
      diagnostico: { veiculoApto: true },
    })),
    mutate: async <TResult>(
      operation: string,
      headers: EstablishmentHeaders,
      payload: unknown,
    ) => (await mutate(operation, headers, payload)) as TResult,
  };
  return { getAuthenticatedClient, mutate, transport };
}

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

    await new RenaveConnector(fake.transport).requestStockEntry(
      context,
      payload,
    );

    expect(fake.mutate).toHaveBeenCalledWith(
      "request-stock-entry",
      { "CNPJ-Estabelecimento": "85106037000585" },
      payload,
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
