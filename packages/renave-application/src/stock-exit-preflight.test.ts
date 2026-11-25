import type { RenaveStockRecord } from "@seu-renave/renave-connector";
import { describe, expect, it } from "vitest";

import {
  StockExitPreflightRejectedError,
  verifyStockExitPreflight,
} from "./stock-exit-preflight.js";

const input = {
  stockId: 71,
  vehicle: {
    codigoSegurancaCrv: "01234567890",
    numeroCrv: "001234567890",
    placa: "ABC1D23",
    renavam: "00987654321",
  },
};

const record = {
  ...input.vehicle,
  estado: "CONFIRMADO",
  id: input.stockId,
  restricoesVeiculo: [],
} satisfies RenaveStockRecord;

describe("verifyStockExitPreflight", () => {
  it("retorna somente o identificador remoto para uma identidade exata", () => {
    const confirmation = verifyStockExitPreflight(input, record);

    expect(confirmation).toEqual({ remoteStockId: 71 });
    expect(Object.isFrozen(confirmation)).toBe(true);
    expect(confirmation).not.toHaveProperty("placa");
  });

  it.each([
    { ...record, id: 72 },
    { ...record, placa: "ABC1D24" },
    { ...record, estado: "FINALIZADO" },
    { ...record, restricoesVeiculo: [{ codigoTipoRestricao: "01" }] },
    { ...record, saidaEstoque: undefined },
    { ...record, cancelamentoEstoque: null },
  ])("rejeita estoque divergente, impedido ou já movimentado", (candidate) => {
    expect(() =>
      verifyStockExitPreflight(input, candidate as RenaveStockRecord),
    ).toThrow(StockExitPreflightRejectedError);
  });

  it("exige a presença própria dos campos protegidos", () => {
    const inherited = Object.setPrototypeOf(
      {
        estado: record.estado,
        id: record.id,
        placa: record.placa,
        restricoesVeiculo: record.restricoesVeiculo,
      },
      {
        codigoSegurancaCrv: record.codigoSegurancaCrv,
        numeroCrv: record.numeroCrv,
        renavam: record.renavam,
      },
    );

    expect(() => verifyStockExitPreflight(input, inherited)).toThrow(
      StockExitPreflightRejectedError,
    );
  });
});
