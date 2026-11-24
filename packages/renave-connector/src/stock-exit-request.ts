import {
  prepareRenaveMutation,
  type PreparedRenaveMutation,
} from "./mutation-request.js";
import type { OwnerDocumentType, StockExitRequest } from "./operations.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CPF = /^\d{11}$/u;
const CNPJ = /^[0-9A-Z]{12}\d{2}$/u;
const PLATE = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u;
const MAX_MUNICIPALITY_CODE = 2_147_483_647;
const MAX_SALE_VALUE = 99_999_999.99;
const FIRST_CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export type InvalidStockExitRequestReason =
  | "ADDRESS"
  | "BUYER"
  | "CLOCK"
  | "DATE"
  | "DOCUMENT"
  | "EMAIL"
  | "OPERATOR"
  | "REQUEST"
  | "VALUE"
  | "VEHICLE";

export class InvalidStockExitRequestError extends Error {
  readonly code = "INVALID_STOCK_EXIT_REQUEST";

  constructor(readonly reason: InvalidStockExitRequestReason) {
    super("A solicitação de saída de estoque é inválida");
    this.name = "InvalidStockExitRequestError";
  }
}

export interface StockExitPreparationOptions {
  /** Relógio explícito para rejeitar data de venda futura. */
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(
  value: unknown,
  maximumLength: number,
  reason: InvalidStockExitRequestReason,
): string {
  if (typeof value !== "string") throw new InvalidStockExitRequestError(reason);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new InvalidStockExitRequestError(reason);
  }
  return normalized;
}

function email(value: unknown): string {
  const normalized = text(value, 254, "EMAIL").toLowerCase();
  if (!EMAIL.test(normalized)) throw new InvalidStockExitRequestError("EMAIL");
  return normalized;
}

function cpfCheckDigit(base: string, factor: number): number {
  let total = 0;
  for (const character of base) {
    total += Number(character) * factor;
    factor -= 1;
  }
  const remainder = (total * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function cpf(value: unknown, reason: InvalidStockExitRequestReason): string {
  if (typeof value !== "string") throw new InvalidStockExitRequestError(reason);
  const normalized = value.replace(/[.\s-]/gu, "");
  if (
    !CPF.test(normalized) ||
    /^(\d)\1{10}$/u.test(normalized) ||
    cpfCheckDigit(normalized.slice(0, 9), 10) !== Number(normalized[9]) ||
    cpfCheckDigit(normalized.slice(0, 10), 11) !== Number(normalized[10])
  ) {
    throw new InvalidStockExitRequestError(reason);
  }
  return normalized;
}

function cnpjCheckDigit(
  values: readonly number[],
  weights: readonly number[],
): number {
  const total = values.reduce(
    (sum, value, index) => sum + value * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function cnpj(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidStockExitRequestError("DOCUMENT");
  }
  const normalized = value.replace(/[./\s-]/gu, "").toUpperCase();
  if (!CNPJ.test(normalized) || /^(\d)\1{13}$/u.test(normalized)) {
    throw new InvalidStockExitRequestError("DOCUMENT");
  }
  const base = [...normalized.slice(0, 12)].map(
    (character) => character.charCodeAt(0) - 48,
  );
  const first = cnpjCheckDigit(base, FIRST_CNPJ_WEIGHTS);
  const second = cnpjCheckDigit([...base, first], SECOND_CNPJ_WEIGHTS);
  if (`${first}${second}` !== normalized.slice(12)) {
    throw new InvalidStockExitRequestError("DOCUMENT");
  }
  return normalized;
}

function buyerDocument(type: OwnerDocumentType, value: unknown): string {
  return type === "CPF" ? cpf(value, "DOCUMENT") : cnpj(value);
}

function saleDate(value: unknown, now: Date | undefined): string {
  if (typeof value !== "string") throw new InvalidStockExitRequestError("DATE");
  const match = DATE.exec(value);
  if (!match) throw new InvalidStockExitRequestError("DATE");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const reconstructed = new Date(Date.UTC(year, month - 1, day));
  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day
  ) {
    throw new InvalidStockExitRequestError("DATE");
  }
  if (now !== undefined) {
    if (!Number.isFinite(now.getTime())) {
      throw new InvalidStockExitRequestError("CLOCK");
    }
    if (value > now.toISOString().slice(0, 10)) {
      throw new InvalidStockExitRequestError("DATE");
    }
  }
  return value;
}

function saleValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_SALE_VALUE
  ) {
    throw new InvalidStockExitRequestError("VALUE");
  }
  const cents = Math.round(value * 100);
  if (cents < 1) throw new InvalidStockExitRequestError("VALUE");
  const normalized = cents / 100;
  if (Math.abs(value - normalized) > 1e-9) {
    throw new InvalidStockExitRequestError("VALUE");
  }
  return normalized;
}

function exactDigits(
  value: unknown,
  length: number,
  reason: InvalidStockExitRequestReason,
): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^\\d{${length}}$`, "u").test(value.trim())
  ) {
    throw new InvalidStockExitRequestError(reason);
  }
  return value.trim();
}

/**
 * Valida e normaliza o contrato oficial antes de congelar os bytes da mutação.
 * Não executa rede nem consulta relógio global.
 */
export async function prepareStockExitRequest(
  input: StockExitRequest,
  options: StockExitPreparationOptions = {},
): Promise<PreparedRenaveMutation> {
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(
      candidate,
      new Set([
        "comprador",
        "cpfOperadorResponsavel",
        "dataVenda",
        "emailEstabelecimento",
        "valorVenda",
        "veiculo",
      ]),
    ) ||
    !isRecord(candidate.comprador) ||
    !isRecord(candidate.veiculo)
  ) {
    throw new InvalidStockExitRequestError("REQUEST");
  }

  const buyer = candidate.comprador;
  if (
    !hasOnlyKeys(
      buyer,
      new Set([
        "email",
        "endereco",
        "nome",
        "numeroDocumento",
        "tipoDocumento",
      ]),
    ) ||
    (buyer.tipoDocumento !== "CPF" && buyer.tipoDocumento !== "CNPJ") ||
    !isRecord(buyer.endereco)
  ) {
    throw new InvalidStockExitRequestError("BUYER");
  }
  const address = buyer.endereco;
  if (
    !hasOnlyKeys(
      address,
      new Set([
        "bairro",
        "cep",
        "codigoMunicipio",
        "complemento",
        "logradouro",
        "numero",
      ]),
    ) ||
    !Number.isInteger(address.codigoMunicipio) ||
    (address.codigoMunicipio as number) <= 0 ||
    (address.codigoMunicipio as number) > MAX_MUNICIPALITY_CODE
  ) {
    throw new InvalidStockExitRequestError("ADDRESS");
  }
  const rawCep = text(address.cep, 9, "ADDRESS");
  if (!/^\d{5}-?\d{3}$/u.test(rawCep)) {
    throw new InvalidStockExitRequestError("ADDRESS");
  }

  const vehicle = candidate.veiculo;
  if (
    !hasOnlyKeys(
      vehicle,
      new Set(["codigoSegurancaCrv", "numeroCrv", "placa", "renavam"]),
    )
  ) {
    throw new InvalidStockExitRequestError("VEHICLE");
  }
  const placa = text(vehicle.placa, 7, "VEHICLE").toUpperCase();
  if (!PLATE.test(placa)) throw new InvalidStockExitRequestError("VEHICLE");

  const normalized: StockExitRequest = {
    comprador: {
      email: email(buyer.email),
      endereco: {
        bairro: text(address.bairro, 200, "ADDRESS"),
        cep: rawCep.replace("-", ""),
        codigoMunicipio: address.codigoMunicipio as number,
        ...(address.complemento === undefined
          ? {}
          : {
              complemento: text(address.complemento, 200, "ADDRESS"),
            }),
        logradouro: text(address.logradouro, 200, "ADDRESS"),
        numero: text(address.numero, 30, "ADDRESS"),
      },
      nome: text(buyer.nome, 40, "BUYER"),
      numeroDocumento: buyerDocument(
        buyer.tipoDocumento,
        buyer.numeroDocumento,
      ),
      tipoDocumento: buyer.tipoDocumento,
    },
    cpfOperadorResponsavel: cpf(candidate.cpfOperadorResponsavel, "OPERATOR"),
    dataVenda: saleDate(candidate.dataVenda, options.now),
    emailEstabelecimento: email(candidate.emailEstabelecimento),
    valorVenda: saleValue(candidate.valorVenda),
    veiculo: {
      codigoSegurancaCrv: exactDigits(
        vehicle.codigoSegurancaCrv,
        11,
        "VEHICLE",
      ),
      numeroCrv: exactDigits(vehicle.numeroCrv, 12, "VEHICLE"),
      placa,
      renavam: exactDigits(vehicle.renavam, 11, "VEHICLE"),
    },
  };

  return prepareRenaveMutation("request-stock-exit", normalized);
}
