import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InvalidStockExitRequestError,
  prepareStockExitRequest,
  renaveMutationRoutes,
  type StockExitRequest,
} from "./index.js";

function request(overrides: Partial<StockExitRequest> = {}): StockExitRequest {
  return {
    comprador: {
      email: "comprador@example.com",
      endereco: {
        bairro: "Centro",
        cep: "66010-000",
        codigoMunicipio: 1_501_402,
        complemento: "Sala 2",
        logradouro: "Avenida Presidente Vargas",
        numero: "100",
      },
      nome: "Pessoa Compradora",
      numeroDocumento: "529.982.247-25",
      tipoDocumento: "CPF",
    },
    cpfOperadorResponsavel: "529.982.247-25",
    dataVenda: "2026-11-24",
    emailEstabelecimento: "operacao@example.com",
    valorVenda: 95_000.5,
    veiculo: {
      codigoSegurancaCrv: "12345678901",
      numeroCrv: "123456789012",
      placa: "abc1d23",
      renavam: "00607701676",
    },
    ...overrides,
  };
}

function body(prepared: Awaited<ReturnType<typeof prepareStockExitRequest>>) {
  return new TextDecoder().decode(prepared.copyBodyBytes());
}

describe("prepareStockExitRequest", () => {
  it("registra somente a rota oficial de solicitação de saída", () => {
    expect(renaveMutationRoutes["request-stock-exit"]).toEqual({
      method: "POST",
      path: "/api/solicitacoes-saida-estoque",
    });
  });

  it("normaliza o contrato em ordem determinística e prepara bytes imutáveis", async () => {
    const input = request({
      comprador: {
        ...request().comprador,
        email: "  COMPRADOR@EXAMPLE.COM ",
        endereco: {
          ...request().comprador.endereco,
          bairro: "  Centro ",
          logradouro: "  Avenida Presidente Vargas ",
        },
        nome: "  Pessoa Compradora ",
      },
      emailEstabelecimento: " OPERACAO@EXAMPLE.COM ",
    });

    const prepared = await prepareStockExitRequest(input, {
      now: new Date("2026-11-24T23:59:59.000Z"),
    });
    const exact = JSON.stringify({
      comprador: {
        email: "comprador@example.com",
        endereco: {
          bairro: "Centro",
          cep: "66010000",
          codigoMunicipio: 1_501_402,
          complemento: "Sala 2",
          logradouro: "Avenida Presidente Vargas",
          numero: "100",
        },
        nome: "Pessoa Compradora",
        numeroDocumento: "52998224725",
        tipoDocumento: "CPF",
      },
      cpfOperadorResponsavel: "52998224725",
      dataVenda: "2026-11-24",
      emailEstabelecimento: "operacao@example.com",
      valorVenda: 95_000.5,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        numeroCrv: "123456789012",
        placa: "ABC1D23",
        renavam: "00607701676",
      },
    });

    expect(prepared.operation).toBe("request-stock-exit");
    expect(body(prepared)).toBe(exact);
    expect(prepared.requestSha256).toBe(
      createHash("sha256").update(exact).digest("hex"),
    );
    input.veiculo.placa = "ZZZ9Z99";
    expect(body(prepared)).toBe(exact);
  });

  it("produz os mesmos bytes para entradas semanticamente equivalentes", async () => {
    const first = await prepareStockExitRequest(request());
    const second = await prepareStockExitRequest(
      request({
        cpfOperadorResponsavel: " 52998224725 ",
        veiculo: { ...request().veiculo, placa: "ABC1D23" },
      }),
    );

    expect(body(first)).toBe(body(second));
    expect(first.requestSha256).toBe(second.requestSha256);
  });

  it("aceita CNPJ numérico e alfanumérico somente com dígitos verificadores válidos", async () => {
    const numeric = await prepareStockExitRequest(
      request({
        comprador: {
          ...request().comprador,
          numeroDocumento: "11.222.333/0001-81",
          tipoDocumento: "CNPJ",
        },
      }),
    );
    const alphanumeric = await prepareStockExitRequest(
      request({
        comprador: {
          ...request().comprador,
          numeroDocumento: "12abc34501de35",
          tipoDocumento: "CNPJ",
        },
      }),
    );

    expect(body(numeric)).toContain('"numeroDocumento":"11222333000181"');
    expect(body(alphanumeric)).toContain('"numeroDocumento":"12ABC34501DE35"');
  });

  it("não consulta relógio global e só rejeita data futura com clock explícito", async () => {
    await expect(
      prepareStockExitRequest(request({ dataVenda: "2099-12-31" })),
    ).resolves.toMatchObject({ operation: "request-stock-exit" });
    await expect(
      prepareStockExitRequest(request({ dataVenda: "2026-11-25" }), {
        now: new Date("2026-11-24T23:59:59.000Z"),
      }),
    ).rejects.toMatchObject({ reason: "DATE" });
    await expect(
      prepareStockExitRequest(request(), { now: new Date(Number.NaN) }),
    ).rejects.toMatchObject({ reason: "CLOCK" });
  });

  it.each(["2026-02-30", "24/11/2026", "2026-13-01"])(
    "recusa data civil inválida %s",
    async (dataVenda) => {
      await expect(
        prepareStockExitRequest(request({ dataVenda })),
      ).rejects.toMatchObject({ reason: "DATE" });
    },
  );

  it.each([
    0,
    -1,
    0.000_000_000_1,
    0.001,
    10.999,
    100_000_000,
    Number.NaN,
    Infinity,
  ])("recusa valor de venda inválido %s", async (valorVenda) => {
    await expect(
      prepareStockExitRequest(request({ valorVenda })),
    ).rejects.toMatchObject({ reason: "VALUE" });
  });

  it.each([
    ["CPF do operador", { cpfOperadorResponsavel: "11111111111" }, "OPERATOR"],
    [
      "CPF do comprador",
      {
        comprador: {
          ...request().comprador,
          numeroDocumento: "52998224724",
        },
      },
      "DOCUMENT",
    ],
    [
      "CNPJ do comprador",
      {
        comprador: {
          ...request().comprador,
          numeroDocumento: "11222333000182",
          tipoDocumento: "CNPJ" as const,
        },
      },
      "DOCUMENT",
    ],
  ])("recusa %s inválido", async (_label, override, reason) => {
    await expect(
      prepareStockExitRequest(request(override as Partial<StockExitRequest>)),
    ).rejects.toMatchObject({ reason });
  });

  it.each([
    ["código de segurança", { codigoSegurancaCrv: "1234567890" }],
    ["número do CRV", { numeroCrv: "12345678901" }],
    ["RENAVAM", { renavam: "1234567890" }],
    ["placa", { placa: "ABC123" }],
  ])("recusa %s veicular inválido", async (_label, vehicleOverride) => {
    await expect(
      prepareStockExitRequest(
        request({
          veiculo: {
            ...request().veiculo,
            ...vehicleOverride,
          } as StockExitRequest["veiculo"],
        }),
      ),
    ).rejects.toMatchObject({ reason: "VEHICLE" });
  });

  it("recusa endereço incompleto, email inválido, nome longo e campos extras", async () => {
    await expect(
      prepareStockExitRequest(
        request({
          comprador: {
            ...request().comprador,
            endereco: { ...request().comprador.endereco, cep: "6601000" },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "ADDRESS" });
    await expect(
      prepareStockExitRequest(
        request({ emailEstabelecimento: "sem-arroba.example.com" }),
      ),
    ).rejects.toMatchObject({ reason: "EMAIL" });
    await expect(
      prepareStockExitRequest(
        request({
          comprador: { ...request().comprador, nome: "x".repeat(41) },
        }),
      ),
    ).rejects.toMatchObject({ reason: "BUYER" });
    await expect(
      prepareStockExitRequest({
        ...request(),
        segredo: "não aceito",
      } as StockExitRequest),
    ).rejects.toMatchObject({ reason: "REQUEST" });
  });

  it("expõe erro sanitizado sem ecoar dados pessoais", async () => {
    let captured: unknown;
    try {
      await prepareStockExitRequest(
        request({ cpfOperadorResponsavel: "52998224724" }),
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(InvalidStockExitRequestError);
    expect(String(captured)).not.toMatch(/52998224724|cpf|documento/iu);
  });
});
