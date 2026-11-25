import type {
  CrvType,
  OwnerDocumentType,
  RenaveStockState,
} from "./operations.js";

const MAX_RECONCILIATION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const OFFSET_DATE_TIME = /(?:Z|[+-]\d{2}:\d{2})$/i;
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);
const OWNER_DOCUMENT_TYPES = new Set<OwnerDocumentType>(["CPF", "CNPJ"]);

export interface RenaveStockExitBuyerRecord {
  [key: string]: unknown;
  numeroDocumento?: string;
  tipoDocumento?: OwnerDocumentType;
}

export interface RenaveStockExitMovementRecord {
  [key: string]: unknown;
  comprador?: RenaveStockExitBuyerRecord;
  cpfOperadorResponsavel?: string;
  dataHora?: string;
  dataHoraRegistro?: string;
  motivo?: string;
  valorVenda?: number;
}

export interface RenaveStockRecord {
  chassi?: string;
  entradaEstoque?: {
    [key: string]: unknown;
    cpfOperadorResponsavel?: string;
    dataHora?: string;
    dataHoraRegistro?: string;
  };
  cancelamentoEstoque?: {
    [key: string]: unknown;
    dataHoraCancelamentoEstoque?: string;
    motivoCancelamentoEstoque?: string;
  };
  codigoSegurancaCrv?: string;
  dataHoraMedicaoHodometro?: string;
  estado?: RenaveStockState;
  id?: number;
  numeroCrv?: string;
  placa?: string;
  quilometragemHodometro?: number;
  renavam?: string;
  restricoesVeiculo?: readonly {
    [key: string]: unknown;
    codigoTipoRestricao?: string;
    tipoRestricao?: string;
  }[];
  saidaEstoque?: RenaveStockExitMovementRecord;
  tipoCrv?: CrvType;
}

export interface StockExitCandidateRecord extends RenaveStockRecord {
  cancelamento?: {
    [key: string]: unknown;
    dataHora?: string;
    motivo?: string;
  };
  saida?: RenaveStockExitMovementRecord;
}

export interface StockEntryReconciliationWindow {
  clockSkewMs?: number;
  observedAt: Date;
  sentAt: Date;
}

/** Subconjunto mínimo da solicitação necessário para comparar o estoque. */
export interface StockEntryReconciliationRequest {
  cpfOperadorResponsavel: string;
  veiculo: {
    codigoSegurancaCrv: string;
    numeroCrv?: string;
    placa: string;
    renavam?: string;
    tipoCrv: CrvType;
  };
}

export type StockEntryReconciliation =
  | { outcome: "confirmed"; stockId: number }
  | { outcome: "not_observed" }
  | { candidateStockIds: number[]; outcome: "manual_review" };

export class InvalidStockEntryReconciliationError extends Error {
  readonly code = "INVALID_STOCK_ENTRY_RECONCILIATION";

  constructor(readonly reason: "REQUEST" | "WINDOW") {
    super("Os dados para reconciliação da entrada em estoque são inválidos");
    this.name = "InvalidStockEntryReconciliationError";
  }
}

function digits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\D/g, "");
  return normalized === "" ? null : normalized;
}

function registrationTime(record: RenaveStockRecord): number | null {
  const value = record.entradaEstoque?.dataHoraRegistro;
  if (!value || !OFFSET_DATE_TIME.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim().toUpperCase();
  return result === "" ? null : result;
}

function sameVehicleIdentity(
  request: StockEntryReconciliationRequest,
  record: RenaveStockRecord,
): boolean {
  const requestVehicle = request.veiculo;
  return (
    normalized(record.codigoSegurancaCrv) ===
      normalized(requestVehicle.codigoSegurancaCrv) &&
    normalized(record.tipoCrv) === normalized(requestVehicle.tipoCrv) &&
    (requestVehicle.renavam === undefined ||
      normalized(record.renavam) === normalized(requestVehicle.renavam)) &&
    (requestVehicle.numeroCrv === undefined ||
      normalized(record.numeroCrv) === normalized(requestVehicle.numeroCrv))
  );
}

function activeRecord(record: RenaveStockRecord): boolean {
  return (
    record.cancelamentoEstoque === undefined &&
    record.estado !== undefined &&
    record.estado !== "FINALIZADO"
  );
}

export function reconcileStockEntry(
  request: StockEntryReconciliationRequest,
  records: readonly RenaveStockRecord[],
  window: StockEntryReconciliationWindow,
): StockEntryReconciliation {
  if (
    typeof request.veiculo?.placa !== "string" ||
    !/^[A-Z0-9]{7}$/i.test(request.veiculo.placa.trim()) ||
    normalized(request.veiculo.codigoSegurancaCrv) === null ||
    !CRV_TYPES.has(request.veiculo.tipoCrv)
  ) {
    throw new InvalidStockEntryReconciliationError("REQUEST");
  }
  const plate = request.veiculo.placa.trim().toUpperCase();
  const operatorCpf = digits(request.cpfOperadorResponsavel);
  if (operatorCpf === null || !/^\d{11}$/.test(operatorCpf)) {
    throw new InvalidStockEntryReconciliationError("REQUEST");
  }
  const skew = window.clockSkewMs ?? 60_000;
  const sentAt = window.sentAt.getTime();
  const observedAt = window.observedAt.getTime();
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(observedAt) ||
    observedAt < sentAt ||
    observedAt - sentAt > MAX_RECONCILIATION_WINDOW_MS ||
    !Number.isFinite(skew) ||
    skew < 0 ||
    skew > MAX_CLOCK_SKEW_MS
  ) {
    throw new InvalidStockEntryReconciliationError("WINDOW");
  }
  const earliest = sentAt - skew;
  const latest = observedAt + skew;
  const compatible: RenaveStockRecord[] = [];
  const manualReviewIds = new Set<number>();
  let hasAmbiguousRecord = false;

  const markAmbiguous = (record: RenaveStockRecord): void => {
    hasAmbiguousRecord = true;
    if (Number.isSafeInteger(record.id) && (record.id ?? 0) > 0) {
      manualReviewIds.add(record.id as number);
    }
  };

  for (const record of records) {
    const sameVehicle = record.placa?.trim().toUpperCase() === plate;
    if (!sameVehicle) continue;

    const timestamp = registrationTime(record);
    if (timestamp === null) {
      markAmbiguous(record);
      continue;
    }
    if (timestamp < earliest || timestamp > latest) continue;

    const recordCpf = digits(record.entradaEstoque?.cpfOperadorResponsavel);
    if (
      recordCpf !== operatorCpf ||
      !sameVehicleIdentity(request, record) ||
      !activeRecord(record) ||
      !Number.isSafeInteger(record.id) ||
      (record.id ?? 0) <= 0
    ) {
      markAmbiguous(record);
      continue;
    }
    compatible.push(record);
  }

  if (
    compatible.length === 1 &&
    !hasAmbiguousRecord &&
    compatible[0]?.id !== undefined
  ) {
    return { outcome: "confirmed", stockId: compatible[0].id };
  }

  if (compatible.length > 1 || hasAmbiguousRecord) {
    for (const record of compatible) {
      manualReviewIds.add(record.id as number);
    }
    return {
      candidateStockIds: [...manualReviewIds],
      outcome: "manual_review",
    };
  }

  return { outcome: "not_observed" };
}

export interface StockExitReconciliationWindow {
  clockSkewMs?: number;
  observedAt?: Date;
  sentAt: Date;
  windowMs?: number;
}

/** Subconjunto mínimo da solicitação de saída necessário para reconciliar o estoque. */
export interface StockExitReconciliationRequest {
  comprador?: {
    numeroDocumento: string;
    tipoDocumento?: OwnerDocumentType;
  };
  cpfOperadorResponsavel?: string;
  stockId: number;
  valorVenda?: number;
  veiculo: {
    chassi?: string;
    codigoSegurancaCrv?: string;
    numeroCrv?: string;
    placa: string;
    renavam?: string;
    tipoCrv?: CrvType;
  };
}

export type StockExitReconciliation =
  | { outcome: "confirmed"; stockId: number }
  | { outcome: "not_observed" }
  | { candidateStockIds: number[]; outcome: "manual_review" };

export class InvalidStockExitReconciliationError extends Error {
  readonly code = "INVALID_STOCK_EXIT_RECONCILIATION";

  constructor(readonly reason: "REQUEST" | "WINDOW") {
    super("Os dados para reconciliação da saída de estoque são inválidos");
    this.name = "InvalidStockExitReconciliationError";
  }
}

function normalizedDocument(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/[./\s-]/gu, "").toUpperCase();
  return result === "" ? null : result;
}

function normalizedCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  if (cents < 1 || Math.abs(value - cents / 100) > 1e-9) return null;
  return cents;
}

function parseOffsetTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !OFFSET_DATE_TIME.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sameExitVehicleIdentity(
  request: StockExitReconciliationRequest,
  record: StockExitCandidateRecord,
  plate: string,
): boolean {
  const vehicle = request.veiculo;
  if (normalized(record.placa) !== plate) return false;
  if (
    vehicle.chassi !== undefined &&
    normalized(record.chassi) !== normalized(vehicle.chassi)
  ) {
    return false;
  }
  if (
    vehicle.renavam !== undefined &&
    normalized(record.renavam) !== normalized(vehicle.renavam)
  ) {
    return false;
  }
  if (
    vehicle.codigoSegurancaCrv !== undefined &&
    normalized(record.codigoSegurancaCrv) !==
      normalized(vehicle.codigoSegurancaCrv)
  ) {
    return false;
  }
  if (
    vehicle.numeroCrv !== undefined &&
    normalized(record.numeroCrv) !== normalized(vehicle.numeroCrv)
  ) {
    return false;
  }
  if (
    vehicle.tipoCrv !== undefined &&
    normalized(record.tipoCrv) !== normalized(vehicle.tipoCrv)
  ) {
    return false;
  }
  return true;
}

function sameExitDetails(
  request: StockExitReconciliationRequest,
  operatorCpf: string | null,
  expectedBuyerDocument: string | null,
  expectedSaleCents: number | null,
  exit: RenaveStockExitMovementRecord,
): boolean {
  if (
    operatorCpf !== null &&
    digits(exit.cpfOperadorResponsavel) !== operatorCpf
  ) {
    return false;
  }
  if (expectedBuyerDocument !== null) {
    if (
      normalizedDocument(exit.comprador?.numeroDocumento) !==
      expectedBuyerDocument
    ) {
      return false;
    }
    if (
      request.comprador?.tipoDocumento !== undefined &&
      exit.comprador?.tipoDocumento !== request.comprador.tipoDocumento
    ) {
      return false;
    }
  }
  if (
    expectedSaleCents !== null &&
    normalizedCents(exit.valorVenda) !== expectedSaleCents
  ) {
    return false;
  }
  return true;
}

function validateStockExitRequest(request: StockExitReconciliationRequest): {
  expectedBuyerDocument: string | null;
  expectedSaleCents: number | null;
  operatorCpf: string | null;
  plate: string;
} {
  if (
    !request ||
    typeof request !== "object" ||
    !Number.isSafeInteger(request.stockId) ||
    request.stockId <= 0 ||
    !request.veiculo ||
    typeof request.veiculo !== "object" ||
    typeof request.veiculo.placa !== "string" ||
    !/^[A-Z0-9]{7}$/i.test(request.veiculo.placa.trim())
  ) {
    throw new InvalidStockExitReconciliationError("REQUEST");
  }
  if (
    (request.veiculo.chassi !== undefined &&
      normalized(request.veiculo.chassi) === null) ||
    (request.veiculo.renavam !== undefined &&
      normalized(request.veiculo.renavam) === null) ||
    (request.veiculo.codigoSegurancaCrv !== undefined &&
      normalized(request.veiculo.codigoSegurancaCrv) === null) ||
    (request.veiculo.numeroCrv !== undefined &&
      normalized(request.veiculo.numeroCrv) === null) ||
    (request.veiculo.tipoCrv !== undefined &&
      !CRV_TYPES.has(request.veiculo.tipoCrv))
  ) {
    throw new InvalidStockExitReconciliationError("REQUEST");
  }

  let operatorCpf: string | null = null;
  if (request.cpfOperadorResponsavel !== undefined) {
    operatorCpf = digits(request.cpfOperadorResponsavel);
    if (operatorCpf === null || !/^\d{11}$/.test(operatorCpf)) {
      throw new InvalidStockExitReconciliationError("REQUEST");
    }
  }

  let expectedBuyerDocument: string | null = null;
  if (request.comprador !== undefined) {
    if (
      !request.comprador ||
      typeof request.comprador !== "object" ||
      (request.comprador.tipoDocumento !== undefined &&
        !OWNER_DOCUMENT_TYPES.has(request.comprador.tipoDocumento))
    ) {
      throw new InvalidStockExitReconciliationError("REQUEST");
    }
    expectedBuyerDocument = normalizedDocument(
      request.comprador.numeroDocumento,
    );
    if (expectedBuyerDocument === null) {
      throw new InvalidStockExitReconciliationError("REQUEST");
    }
  }

  let expectedSaleCents: number | null = null;
  if (request.valorVenda !== undefined) {
    expectedSaleCents = normalizedCents(request.valorVenda);
    if (expectedSaleCents === null) {
      throw new InvalidStockExitReconciliationError("REQUEST");
    }
  }

  return {
    expectedBuyerDocument,
    expectedSaleCents,
    operatorCpf,
    plate: request.veiculo.placa.trim().toUpperCase(),
  };
}

function validateStockExitWindow(window: StockExitReconciliationWindow): {
  earliest: number;
  latest: number;
} {
  if (
    !window ||
    typeof window !== "object" ||
    !(window.sentAt instanceof Date)
  ) {
    throw new InvalidStockExitReconciliationError("WINDOW");
  }
  const sentAt = window.sentAt.getTime();
  const windowMs = window.windowMs ?? MAX_RECONCILIATION_WINDOW_MS;
  const skew = window.clockSkewMs ?? 60_000;
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    windowMs > MAX_RECONCILIATION_WINDOW_MS ||
    !Number.isFinite(skew) ||
    skew < 0 ||
    skew > MAX_CLOCK_SKEW_MS
  ) {
    throw new InvalidStockExitReconciliationError("WINDOW");
  }

  let latest = sentAt + windowMs;
  if (window.observedAt !== undefined) {
    if (!(window.observedAt instanceof Date)) {
      throw new InvalidStockExitReconciliationError("WINDOW");
    }
    const observedAt = window.observedAt.getTime();
    if (
      !Number.isFinite(observedAt) ||
      observedAt < sentAt ||
      observedAt - sentAt > windowMs
    ) {
      throw new InvalidStockExitReconciliationError("WINDOW");
    }
    latest = Math.min(observedAt + skew, sentAt + windowMs);
  }

  return { earliest: sentAt - skew, latest };
}

export function reconcileStockExit(
  request: StockExitReconciliationRequest,
  records: readonly StockExitCandidateRecord[] | StockExitCandidateRecord,
  window: StockExitReconciliationWindow,
): StockExitReconciliation {
  const { expectedBuyerDocument, expectedSaleCents, operatorCpf, plate } =
    validateStockExitRequest(request);
  const { earliest, latest } = validateStockExitWindow(window);

  const list = Array.isArray(records) ? records : [records];
  const compatible: StockExitCandidateRecord[] = [];
  const manualReviewIds = new Set<number>();
  let matchedStockCount = 0;
  let hasAmbiguousRecord = false;

  const markAmbiguous = (record: StockExitCandidateRecord): void => {
    hasAmbiguousRecord = true;
    if (Number.isSafeInteger(record.id) && (record.id ?? 0) > 0) {
      manualReviewIds.add(record.id as number);
    }
  };

  for (const record of list) {
    if (!record || typeof record !== "object") {
      hasAmbiguousRecord = true;
      continue;
    }
    const hasValidId =
      Number.isSafeInteger(record.id) && (record.id as number) > 0;
    if (!hasValidId) {
      if (normalized(record.placa) === plate) {
        hasAmbiguousRecord = true;
      }
      continue;
    }
    if (record.id !== request.stockId) continue;

    matchedStockCount += 1;
    if (matchedStockCount > 1) {
      markAmbiguous(record);
    }

    if (
      record.cancelamentoEstoque !== undefined ||
      record.cancelamento !== undefined
    ) {
      markAmbiguous(record);
      continue;
    }

    if (!sameExitVehicleIdentity(request, record, plate)) {
      markAmbiguous(record);
      continue;
    }

    if (record.saidaEstoque !== undefined && record.saida !== undefined) {
      markAmbiguous(record);
      continue;
    }
    const exit = record.saidaEstoque ?? record.saida;

    if (record.estado === "CONFIRMADO") {
      if (exit !== undefined) {
        markAmbiguous(record);
      }
      continue;
    }

    if (record.estado !== "FINALIZADO" || exit === undefined) {
      markAmbiguous(record);
      continue;
    }

    const registeredAt = parseOffsetTimestamp(exit.dataHoraRegistro);
    if (
      registeredAt === null ||
      registeredAt < earliest ||
      registeredAt > latest ||
      !sameExitDetails(
        request,
        operatorCpf,
        expectedBuyerDocument,
        expectedSaleCents,
        exit,
      )
    ) {
      markAmbiguous(record);
      continue;
    }

    compatible.push(record);
  }

  if (compatible.length === 1 && !hasAmbiguousRecord) {
    return { outcome: "confirmed", stockId: request.stockId };
  }

  if (compatible.length > 1 || hasAmbiguousRecord) {
    for (const record of compatible) {
      manualReviewIds.add(record.id as number);
    }
    return {
      candidateStockIds: [...manualReviewIds],
      outcome: "manual_review",
    };
  }

  return { outcome: "not_observed" };
}
