import type { RenaveStockRecord } from "@seu-renave/renave-connector";

import type { StockExitBusinessInput } from "./stock-exit-operations.js";

const PLATE = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u;
const ELEVEN_DIGITS = /^[0-9]{11}$/u;
const TWELVE_DIGITS = /^[0-9]{12}$/u;
const REQUIRED_RECORD_FIELDS = [
  "id",
  "placa",
  "renavam",
  "numeroCrv",
  "codigoSegurancaCrv",
  "estado",
  "restricoesVeiculo",
] as const satisfies readonly (keyof RenaveStockRecord)[];

export class StockExitPreflightRejectedError extends Error {
  readonly code = "STOCK_EXIT_PREFLIGHT_REJECTED";

  constructor() {
    super("O estoque consultado não permite confirmar a saída.");
    this.name = "StockExitPreflightRejectedError";
  }
}

function matchesIdentity(
  observed: unknown,
  expected: unknown,
  format: RegExp,
): boolean {
  return (
    typeof observed === "string" &&
    observed === expected &&
    format.test(observed)
  );
}

export function verifyStockExitPreflight(
  input: { stockId: number; vehicle: StockExitBusinessInput["veiculo"] },
  record: RenaveStockRecord,
): { remoteStockId: number } {
  const { stockId, vehicle } = input;
  if (
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record) ||
    !REQUIRED_RECORD_FIELDS.every((field) => Object.hasOwn(record, field)) ||
    !Number.isSafeInteger(stockId) ||
    stockId <= 0 ||
    record.id !== stockId ||
    !matchesIdentity(record.placa, vehicle?.placa, PLATE) ||
    !matchesIdentity(record.renavam, vehicle?.renavam, ELEVEN_DIGITS) ||
    !matchesIdentity(record.numeroCrv, vehicle?.numeroCrv, TWELVE_DIGITS) ||
    !matchesIdentity(
      record.codigoSegurancaCrv,
      vehicle?.codigoSegurancaCrv,
      ELEVEN_DIGITS,
    ) ||
    record.estado !== "CONFIRMADO" ||
    "saidaEstoque" in record ||
    "cancelamentoEstoque" in record ||
    !Array.isArray(record.restricoesVeiculo) ||
    record.restricoesVeiculo.length !== 0
  ) {
    throw new StockExitPreflightRejectedError();
  }

  return Object.freeze({ remoteStockId: stockId });
}
