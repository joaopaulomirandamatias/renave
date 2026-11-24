import type {
  CrvType,
  RenaveStockState,
  StockEntryRequest,
} from "./operations.js";

const MAX_RECONCILIATION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const OFFSET_DATE_TIME = /(?:Z|[+-]\d{2}:\d{2})$/i;
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);

export interface RenaveStockRecord {
  entradaEstoque?: {
    cpfOperadorResponsavel?: string;
    dataHora?: string;
    dataHoraRegistro?: string;
  };
  cancelamentoEstoque?: unknown;
  codigoSegurancaCrv?: string;
  estado?: RenaveStockState;
  id?: number;
  numeroCrv?: string;
  placa?: string;
  renavam?: string;
  tipoCrv?: CrvType;
}

export interface StockEntryReconciliationWindow {
  clockSkewMs?: number;
  observedAt: Date;
  sentAt: Date;
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
  request: StockEntryRequest,
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
  request: StockEntryRequest,
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
