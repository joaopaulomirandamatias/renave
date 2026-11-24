export class InvalidStockPlateQueryError extends Error {
  readonly code = "INVALID_STOCK_PLATE_QUERY";

  constructor() {
    super("Informe uma placa válida para a consulta pontual de estoque");
    this.name = "InvalidStockPlateQueryError";
  }
}

export function normalizeStockPlate(value: unknown): string {
  if (typeof value !== "string") throw new InvalidStockPlateQueryError();
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{7}$/.test(normalized)) {
    throw new InvalidStockPlateQueryError();
  }
  return normalized;
}
