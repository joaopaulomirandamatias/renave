const CNPJ_LENGTH = 14;

export function normalizeCnpj(value: string): string {
  const normalized = value.replace(/[^0-9A-Z]/gi, "").toUpperCase();
  if (normalized.length !== CNPJ_LENGTH) {
    throw new InvalidCnpjError();
  }
  return normalized;
}

export class InvalidCnpjError extends Error {
  readonly code = "INVALID_CNPJ";

  constructor() {
    super("CNPJ deve conter 14 caracteres alfanuméricos");
    this.name = "InvalidCnpjError";
  }
}
