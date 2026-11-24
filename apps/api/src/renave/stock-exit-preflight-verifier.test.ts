import type { RenaveStockRecord } from "@seu-renave/renave-connector";
import { describe, expect, it } from "vitest";

import {
  StockExitPreflightRejectedError,
  verifyStockExitPreflight,
} from "./stock-exit-preflight-verifier.js";

const input = {
  stockId: 71,
  vehicle: {
    codigoSegurancaCrv: "01234567890",
    numeroCrv: "001234567890",
    placa: "ABC1D23",
    renavam: "00987654321",
  },
};

const confirmedStock = {
  ...input.vehicle,
  estado: "CONFIRMADO",
  id: input.stockId,
  restricoesVeiculo: [],
} satisfies RenaveStockRecord;

function expectRejection(
  record: unknown,
  expected: Parameters<typeof verifyStockExitPreflight>[0] = input,
) {
  expect(() =>
    verifyStockExitPreflight(expected, record as RenaveStockRecord),
  ).toThrow(StockExitPreflightRejectedError);
}

describe("verifyStockExitPreflight", () => {
  it.each(["ABC1D23", "ABC1234"])(
    "confirma somente o identificador remoto para a placa %s e documentos com zeros à esquerda",
    (placa) => {
      const result = verifyStockExitPreflight(
        { ...input, vehicle: { ...input.vehicle, placa } },
        { ...confirmedStock, placa },
      );

      expect(result).toEqual({ remoteStockId: input.stockId });
    },
  );

  it.each(Object.keys(confirmedStock) as (keyof RenaveStockRecord)[])(
    "recusa o campo obrigatório %s ausente, indefinido ou nulo",
    (field) => {
      const withoutField: RenaveStockRecord = { ...confirmedStock };
      delete withoutField[field];

      expectRejection(withoutField);
      expectRejection({ ...confirmedStock, [field]: undefined });
      expectRejection({ ...confirmedStock, [field]: null });
    },
  );

  it.each([
    { field: "id", different: 72, malformed: "71" },
    { field: "placa", different: "ABC1D24", malformed: "abc1d23" },
    { field: "renavam", different: "00987654322", malformed: "987654321" },
    { field: "numeroCrv", different: "001234567891", malformed: "1234567890" },
    {
      field: "codigoSegurancaCrv",
      different: "01234567891",
      malformed: 1234567890,
    },
  ])(
    "recusa $field divergente ou malformado",
    ({ field, different, malformed }) => {
      expectRejection({ ...confirmedStock, [field]: different });
      expectRejection({ ...confirmedStock, [field]: malformed });
    },
  );

  it.each([
    { field: "placa", malformed: "ABC-1D23" },
    { field: "placa", malformed: "ABCDEFG" },
    { field: "placa", malformed: "ABC1D23 " },
    { field: "renavam", malformed: "0098765432X" },
    { field: "numeroCrv", malformed: "0 1234567890" },
    { field: "codigoSegurancaCrv", malformed: "012345678900" },
  ])(
    "recusa $field malformado mesmo quando os valores coincidem",
    ({ field, malformed }) => {
      expectRejection(
        { ...confirmedStock, [field]: malformed },
        { ...input, vehicle: { ...input.vehicle, [field]: malformed } },
      );
    },
  );

  it.each([
    { label: "zero", id: 0 },
    { label: "negativo", id: -1 },
    { label: "fracionário", id: 71.5 },
    { label: "fora da faixa segura", id: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "recusa identificador $label mesmo quando os valores coincidem",
    ({ id }) => {
      expectRejection({ ...confirmedStock, id }, { ...input, stockId: id });
    },
  );

  it.each(["SOLICITADO", "TRANSFERIDO", "FINALIZADO", "confirmado", " "])(
    "recusa o estado %j",
    (estado) => {
      expectRejection({ ...confirmedStock, estado });
    },
  );

  it.each(["saidaEstoque", "cancelamentoEstoque"])(
    "recusa qualquer presença de %s",
    (field) => {
      for (const value of [{}, null, undefined]) {
        expectRejection({ ...confirmedStock, [field]: value });
      }
    },
  );

  it.each([
    { label: "com restrição", restrictions: [{ codigoTipoRestricao: "01" }] },
    { label: "com item nulo", restrictions: [null] },
    { label: "como objeto", restrictions: { length: 0 } },
    { label: "como string", restrictions: "" },
  ])("recusa restrições $label", ({ restrictions }) => {
    expectRejection({ ...confirmedStock, restricoesVeiculo: restrictions });
  });

  it("exige que o registro contenha explicitamente o array de restrições", () => {
    const { restricoesVeiculo, ...record } = confirmedStock;

    expectRejection(Object.setPrototypeOf(record, { restricoesVeiculo }));
  });

  it.each([null, undefined, [], ""])(
    "recusa o registro inválido %j",
    (record) => {
      expectRejection(record);
    },
  );

  it("rejeita com código e mensagem fixos sem anexar os valores consultados", () => {
    expect.assertions(2);
    try {
      verifyStockExitPreflight(input, { ...confirmedStock, id: 72 });
    } catch (error) {
      expect(error).toMatchObject({
        code: "STOCK_EXIT_PREFLIGHT_REJECTED",
        message: "O estoque consultado não permite confirmar a saída.",
      });
      expect(error).not.toHaveProperty("cause");
    }
  });
});
