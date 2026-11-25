import { describe, expect, it } from "vitest";

import {
  InvalidStockEntryReconciliationError,
  InvalidStockExitReconciliationError,
  reconcileStockEntry,
  reconcileStockExit,
  type RenaveStockRecord,
  type StockEntryRequest,
  type StockExitCandidateRecord,
  type StockExitReconciliationRequest,
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

const exitRequest: StockExitReconciliationRequest = {
  comprador: {
    numeroDocumento: "987.654.321-00",
    tipoDocumento: "CPF",
  },
  cpfOperadorResponsavel: "123.456.789-01",
  stockId: 42,
  valorVenda: 95_500.5,
  veiculo: {
    chassi: "9BWZZZ377VT004251",
    codigoSegurancaCrv: "12345678901",
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    renavam: "00607701676",
    tipoCrv: "DIGITAL",
  },
};

function finalizedExitStock(
  id: number | undefined,
  registeredAt: string | undefined,
): StockExitCandidateRecord {
  return {
    chassi: "9BWZZZ377VT004251",
    codigoSegurancaCrv: "12345678901",
    estado: "FINALIZADO",
    ...(id === undefined ? {} : { id }),
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    renavam: "00607701676",
    saidaEstoque: {
      comprador: {
        numeroDocumento: "98765432100",
        tipoDocumento: "CPF",
      },
      cpfOperadorResponsavel: "12345678901",
      ...(registeredAt === undefined ? {} : { dataHoraRegistro: registeredAt }),
      valorVenda: 95_500.5,
    },
    tipoCrv: "DIGITAL",
  };
}

function confirmedStock(id = 42): StockExitCandidateRecord {
  return {
    chassi: "9BWZZZ377VT004251",
    codigoSegurancaCrv: "12345678901",
    estado: "CONFIRMADO",
    id,
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    renavam: "00607701676",
    tipoCrv: "DIGITAL",
  };
}

describe("reconcileStockExit", () => {
  it("confirma saída única íntegra a partir de registro único (GET /api/estoques/{id})", () => {
    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T15:02:00.000Z"),
        window,
      ),
    ).toEqual({ outcome: "confirmed", stockId: 42 });
  });

  it("confirma saída usando campo saida de StockDetail e fuso explícito ±hh:mm", () => {
    const detailRecord: StockExitCandidateRecord = {
      chassi: "9BWZZZ377VT004251",
      codigoSegurancaCrv: "12345678901",
      estado: "FINALIZADO",
      id: 42,
      numeroCrv: "123456789012",
      placa: "QTP4H82",
      renavam: "00607701676",
      saida: {
        comprador: {
          numeroDocumento: "98765432100",
          tipoDocumento: "CPF",
        },
        cpfOperadorResponsavel: "12345678901",
        dataHoraRegistro: "2026-11-23T12:05:00-03:00",
        valorVenda: 95_500.5,
      },
      tipoCrv: "DIGITAL",
    };
    expect(reconcileStockExit(exitRequest, [detailRecord], window)).toEqual({
      outcome: "confirmed",
      stockId: 42,
    });
  });

  it("ignora outros stockIds na lista e confirma apenas o stockId esperado", () => {
    const otherStock = finalizedExitStock(99, "2026-11-23T15:03:00.000Z");
    expect(
      reconcileStockExit(
        exitRequest,
        [otherStock, finalizedExitStock(42, "2026-11-23T15:02:00.000Z")],
        window,
      ),
    ).toEqual({ outcome: "confirmed", stockId: 42 });
  });

  it("aceita bordas exatas da janela [sentAt - clockSkewMs, sentAt + windowMs]", () => {
    const sentAt = new Date("2026-11-23T15:00:00.000Z");
    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T14:59:00.000Z"),
        { clockSkewMs: 60_000, sentAt },
      ),
    ).toEqual({ outcome: "confirmed", stockId: 42 });
    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T16:00:00.000Z"),
        { clockSkewMs: 60_000, sentAt },
      ),
    ).toEqual({ outcome: "confirmed", stockId: 42 });
  });

  it("retorna not_observed quando o estoque continua CONFIRMADO sem saída nem cancelamento", () => {
    expect(reconcileStockExit(exitRequest, confirmedStock(42), window)).toEqual(
      { outcome: "not_observed" },
    );
  });

  it("retorna not_observed quando o stockId esperado não está na lista", () => {
    expect(
      reconcileStockExit(exitRequest, [confirmedStock(99)], window),
    ).toEqual({ outcome: "not_observed" });
  });

  it("envia para manual_review quando dataHoraRegistro está fora da borda inferior ou superior", () => {
    const sentAt = new Date("2026-11-23T15:00:00.000Z");
    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T14:58:59.999Z"),
        { clockSkewMs: 60_000, sentAt },
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });

    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T16:00:00.001Z"),
        { clockSkewMs: 60_000, sentAt },
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });
  });

  it("trata dataHoraRegistro ausente, sem offset ou apenas dataHora como manual_review", () => {
    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, undefined),
        window,
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });

    expect(
      reconcileStockExit(
        exitRequest,
        finalizedExitStock(42, "2026-11-23T12:02:00"),
        window,
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });

    const onlyBusinessDate = finalizedExitStock(42, undefined);
    onlyBusinessDate.saidaEstoque = {
      ...onlyBusinessDate.saidaEstoque,
      dataHora: "2026-11-23T15:02:00.000Z",
    };
    expect(reconcileStockExit(exitRequest, onlyBusinessDate, window)).toEqual({
      candidateStockIds: [42],
      outcome: "manual_review",
    });
  });

  it.each<[string, (record: StockExitCandidateRecord) => void]>([
    [
      "cancelamentoEstoque",
      (record) => {
        record.cancelamentoEstoque = { motivoCancelamentoEstoque: "CANCELADO" };
      },
    ],
    [
      "cancelamento",
      (record) => {
        record.cancelamento = { motivo: "CANCELADO" };
      },
    ],
    [
      "estado SOLICITADO",
      (record) => {
        record.estado = "SOLICITADO";
      },
    ],
    [
      "estado TRANSFERIDO",
      (record) => {
        record.estado = "TRANSFERIDO";
      },
    ],
    [
      "estado ausente",
      (record) => {
        delete record.estado;
      },
    ],
    [
      "CONFIRMADO com saidaEstoque",
      (record) => {
        record.estado = "CONFIRMADO";
      },
    ],
    [
      "FINALIZADO sem saidaEstoque",
      (record) => {
        delete record.saidaEstoque;
      },
    ],
    [
      "placa divergente",
      (record) => {
        record.placa = "ABC1D23";
      },
    ],
    [
      "chassi divergente",
      (record) => {
        record.chassi = "9BWZZZ377VT999999";
      },
    ],
    [
      "RENAVAM divergente",
      (record) => {
        record.renavam = "99999999999";
      },
    ],
    [
      "CRV divergente",
      (record) => {
        record.codigoSegurancaCrv = "00000000000";
      },
    ],
    [
      "número CRV divergente",
      (record) => {
        record.numeroCrv = "000000000000";
      },
    ],
    [
      "tipo CRV divergente",
      (record) => {
        record.tipoCrv = "AZUL";
      },
    ],
  ])(
    "envia %s para manual_review (nunca not_observed)",
    (_label, mutateRecord) => {
      const candidate = finalizedExitStock(42, "2026-11-23T15:02:00.000Z");
      mutateRecord(candidate);
      expect(reconcileStockExit(exitRequest, candidate, window)).toEqual({
        candidateStockIds: [42],
        outcome: "manual_review",
      });
    },
  );

  it.each<
    [
      string,
      (exit: NonNullable<StockExitCandidateRecord["saidaEstoque"]>) => void,
    ]
  >([
    [
      "CPF operador divergente",
      (exit) => {
        exit.cpfOperadorResponsavel = "00000000000";
      },
    ],
    [
      "CPF operador ausente",
      (exit) => {
        delete exit.cpfOperadorResponsavel;
      },
    ],
    [
      "comprador documento divergente",
      (exit) => {
        exit.comprador = {
          numeroDocumento: "11111111111",
          tipoDocumento: "CPF",
        };
      },
    ],
    [
      "comprador tipo divergente",
      (exit) => {
        exit.comprador = {
          numeroDocumento: "98765432100",
          tipoDocumento: "CNPJ",
        };
      },
    ],
    [
      "comprador ausente",
      (exit) => {
        delete exit.comprador;
      },
    ],
    [
      "valorVenda divergente",
      (exit) => {
        exit.valorVenda = 95_500.51;
      },
    ],
    [
      "valorVenda ausente",
      (exit) => {
        delete exit.valorVenda;
      },
    ],
  ])("envia %s na saída para manual_review", (_label, mutateExit) => {
    const candidate = finalizedExitStock(42, "2026-11-23T15:02:00.000Z");
    mutateExit(candidate.saidaEstoque!);
    expect(reconcileStockExit(exitRequest, candidate, window)).toEqual({
      candidateStockIds: [42],
      outcome: "manual_review",
    });
  });

  it("envia para manual_review quando há múltiplos candidatos com o mesmo stockId", () => {
    expect(
      reconcileStockExit(
        exitRequest,
        [
          finalizedExitStock(42, "2026-11-23T15:02:00.000Z"),
          finalizedExitStock(42, "2026-11-23T15:03:00.000Z"),
        ],
        window,
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });
  });

  it("envia para manual_review quando há registro sem ID válido para a mesma placa", () => {
    expect(
      reconcileStockExit(
        exitRequest,
        [
          finalizedExitStock(42, "2026-11-23T15:02:00.000Z"),
          finalizedExitStock(undefined, "2026-11-23T15:02:00.000Z"),
        ],
        window,
      ),
    ).toEqual({ candidateStockIds: [42], outcome: "manual_review" });
  });

  it("envia para manual_review quando saidaEstoque e saida coexistem no mesmo registro", () => {
    const candidate = finalizedExitStock(42, "2026-11-23T15:02:00.000Z");
    candidate.saida = { ...candidate.saidaEstoque };
    expect(reconcileStockExit(exitRequest, candidate, window)).toEqual({
      candidateStockIds: [42],
      outcome: "manual_review",
    });
  });

  it.each([
    ["stockId zero", { stockId: 0 }],
    ["stockId negativo", { stockId: -5 }],
    ["stockId não inteiro", { stockId: 42.5 }],
    ["CPF operador inválido", { cpfOperadorResponsavel: "123" }],
    ["valorVenda zero", { valorVenda: 0 }],
    ["valorVenda negativo", { valorVenda: -10 }],
    ["comprador sem documento", { comprador: { numeroDocumento: "" } }],
    [
      "placa inválida",
      { veiculo: { ...exitRequest.veiculo, placa: "INVALIDA" } },
    ],
    [
      "tipoCrv desconhecido",
      {
        veiculo: {
          ...exitRequest.veiculo,
          tipoCrv: "PAPEL",
        },
      },
    ],
  ])("recusa request inválido (%s) fail-closed", (_label, override) => {
    const unsafeRequest = {
      ...exitRequest,
      ...override,
    } as StockExitReconciliationRequest;
    expect(() =>
      reconcileStockExit(
        unsafeRequest,
        [finalizedExitStock(42, "2026-11-23T15:02:00.000Z")],
        window,
      ),
    ).toThrow(InvalidStockExitReconciliationError);
    expect(() =>
      reconcileStockExit(
        unsafeRequest,
        [finalizedExitStock(42, "2026-11-23T15:02:00.000Z")],
        window,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_STOCK_EXIT_RECONCILIATION",
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
    { ...window, windowMs: 0 },
    { ...window, windowMs: 3_600_001 },
    { ...window, observedAt: new Date("inválida") },
    { sentAt: new Date("inválida") },
    {
      observedAt: new Date("2026-11-23T16:00:00.001Z"),
      sentAt: window.sentAt,
    },
  ])("recusa janela inválida %# fail-closed", (invalidWindow) => {
    expect(() =>
      reconcileStockExit(exitRequest, [], invalidWindow),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_STOCK_EXIT_RECONCILIATION",
        reason: "WINDOW",
      }),
    );
  });
});
