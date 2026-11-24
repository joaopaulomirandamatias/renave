import { describe, expect, it } from "vitest";

import {
  InvalidStockEntryReconciliationError,
  reconcileStockEntry,
  type RenaveStockRecord,
  type StockEntryRequest,
} from "./index.js";

const request: StockEntryRequest = {
  cpfOperadorResponsavel: "123.456.789-01",
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

const window = {
  observedAt: new Date("2026-11-23T15:10:00.000Z"),
  sentAt: new Date("2026-11-23T15:00:00.000Z"),
};

function stock(
  id: number | undefined,
  registeredAt: string | undefined,
): RenaveStockRecord {
  return {
    codigoSegurancaCrv: "12345678901",
    entradaEstoque: {
      cpfOperadorResponsavel: "12345678901",
      ...(registeredAt === undefined ? {} : { dataHoraRegistro: registeredAt }),
    },
    estado: "SOLICITADO",
    ...(id === undefined ? {} : { id }),
    placa: "QTP4H82",
    renavam: "00607701676",
    tipoCrv: "DIGITAL",
  };
}

describe("reconcileStockEntry", () => {
  it("confirma uma única correspondência na janela", () => {
    expect(
      reconcileStockEntry(
        request,
        [stock(7, "2026-11-23T15:02:00.000Z")],
        window,
      ),
    ).toEqual({ outcome: "confirmed", stockId: 7 });
  });

  it("mantém como não observado quando só há registro antigo", () => {
    expect(
      reconcileStockEntry(
        request,
        [stock(7, "2026-11-22T15:02:00.000Z")],
        window,
      ),
    ).toEqual({ outcome: "not_observed" });
  });

  it("exige revisão humana quando há mais de uma correspondência", () => {
    expect(
      reconcileStockEntry(
        request,
        [
          stock(7, "2026-11-23T15:02:00.000Z"),
          stock(8, "2026-11-23T15:03:00.000Z"),
        ],
        window,
      ),
    ).toEqual({ candidateStockIds: [7, 8], outcome: "manual_review" });
  });

  it("não confirma registro compatível sem data ou ID", () => {
    expect(
      reconcileStockEntry(request, [stock(undefined, undefined)], window),
    ).toEqual({ candidateStockIds: [], outcome: "manual_review" });
  });

  it("trata CPF ausente no registro como ambíguo", () => {
    expect(
      reconcileStockEntry(
        request,
        [
          {
            codigoSegurancaCrv: "12345678901",
            entradaEstoque: { dataHoraRegistro: "2026-11-23T15:02:00.000Z" },
            estado: "SOLICITADO",
            id: 7,
            placa: "QTP4H82",
            renavam: "00607701676",
            tipoCrv: "DIGITAL",
          },
        ],
        window,
      ),
    ).toEqual({ candidateStockIds: [7], outcome: "manual_review" });
  });

  it("trata data oficial sem offset como ambígua em qualquer fuso", () => {
    expect(
      reconcileStockEntry(request, [stock(7, "2026-11-23T12:02")], window),
    ).toEqual({ candidateStockIds: [7], outcome: "manual_review" });
  });

  it("não usa dataHora de negócio como relógio de registro", () => {
    const candidate = stock(7, undefined);
    candidate.entradaEstoque = {
      cpfOperadorResponsavel: "12345678901",
      dataHora: "2026-11-23T15:02:00.000Z",
    };
    expect(reconcileStockEntry(request, [candidate], window)).toEqual({
      candidateStockIds: [7],
      outcome: "manual_review",
    });
  });

  it.each([
    ["CPF divergente", { cpfOperadorResponsavel: "98765432100" }],
    ["CPF ausente", {}],
  ])("trata %s na janela como ambíguo", (_label, entry) => {
    const candidate = stock(7, "2026-11-23T15:02:00.000Z");
    candidate.entradaEstoque = {
      ...entry,
      dataHoraRegistro: "2026-11-23T15:02:00.000Z",
    };
    expect(reconcileStockEntry(request, [candidate], window)).toMatchObject({
      candidateStockIds: [7],
      outcome: "manual_review",
    });
  });

  it("preserva os IDs compatível e divergente para revisão", () => {
    const divergent = stock(8, "2026-11-23T15:03:00.000Z");
    divergent.entradaEstoque = {
      ...divergent.entradaEstoque,
      cpfOperadorResponsavel: "98765432100",
    };

    expect(
      reconcileStockEntry(
        request,
        [stock(7, "2026-11-23T15:02:00.000Z"), divergent],
        window,
      ),
    ).toEqual({ candidateStockIds: [8, 7], outcome: "manual_review" });
  });

  it.each([
    ["RENAVAM divergente", { renavam: "99999999999" }],
    ["CRV divergente", { codigoSegurancaCrv: "OUTRO" }],
    ["tipo CRV divergente", { tipoCrv: "AZUL" as const }],
    ["estoque finalizado", { estado: "FINALIZADO" as const }],
    ["estoque cancelado", { cancelamentoEstoque: { motivo: "cancelado" } }],
  ])("envia %s para revisão manual", (_label, override) => {
    const candidate = {
      ...stock(7, "2026-11-23T15:02:00.000Z"),
      ...override,
    };
    expect(reconcileStockEntry(request, [candidate], window)).toMatchObject({
      outcome: "manual_review",
    });
  });

  it("envia estado ausente para revisão manual", () => {
    const candidate = stock(7, "2026-11-23T15:02:00.000Z");
    delete candidate.estado;
    expect(reconcileStockEntry(request, [candidate], window)).toMatchObject({
      outcome: "manual_review",
    });
  });

  it("recusa CPF do request inválido", () => {
    expect(() =>
      reconcileStockEntry(
        { ...request, cpfOperadorResponsavel: "" },
        [],
        window,
      ),
    ).toThrow(InvalidStockEntryReconciliationError);
  });

  it.each([
    ["código de segurança ausente", { codigoSegurancaCrv: undefined }],
    ["código de segurança vazio", { codigoSegurancaCrv: "" }],
    ["tipo CRV ausente", { tipoCrv: undefined }],
    ["tipo CRV desconhecido", { tipoCrv: "PAPEL" }],
  ])("recusa request com %s em runtime", (_label, vehicleOverride) => {
    const unsafeRequest = {
      ...request,
      veiculo: { ...request.veiculo, ...vehicleOverride },
    } as StockEntryRequest;
    expect(() =>
      reconcileStockEntry(
        unsafeRequest,
        [stock(7, "2026-11-23T15:02:00.000Z")],
        window,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_STOCK_ENTRY_RECONCILIATION",
        reason: "REQUEST",
      }),
    );
  });

  it.each([
    {
      observedAt: new Date("2026-11-23T14:59:00.000Z"),
      sentAt: window.sentAt,
    },
    { ...window, clockSkewMs: -1 },
    { ...window, clockSkewMs: 300_001 },
    { ...window, observedAt: new Date("inválida") },
    {
      observedAt: new Date("2026-11-23T16:00:00.001Z"),
      sentAt: window.sentAt,
    },
  ])("recusa janela inválida %#", (invalidWindow) => {
    expect(() => reconcileStockEntry(request, [], invalidWindow)).toThrowError(
      expect.objectContaining({
        code: "INVALID_STOCK_ENTRY_RECONCILIATION",
        reason: "WINDOW",
      }),
    );
  });
});
