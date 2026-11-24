import type {
  BrowserCrvType,
  BrowserEligibilitySummary,
  BrowserRenaveReadiness,
  BrowserStockSummary,
  BrowserVehicle,
} from "../../App.js";

/**
 * Capacidade deliberadamente estreita do ensaio guiado. A feature não recebe
 * o cliente de sessão amplo nem capacidade de enviar mutação ao SERPRO. O
 * preflight registra evidência/auditoria e pode atualizar o vínculo local.
 */
export interface ReadonlyCanaryPort {
  checkEligibility(
    plate: string,
    crvType: BrowserCrvType,
    signal: AbortSignal,
  ): Promise<BrowserEligibilitySummary>;
  loadReadiness(signal: AbortSignal): Promise<BrowserRenaveReadiness>;
  lookupVehicle(plate: string, signal: AbortSignal): Promise<BrowserVehicle>;
  runPreflight(signal: AbortSignal): Promise<void>;
  searchStocks(
    plate: string,
    signal: AbortSignal,
  ): Promise<readonly BrowserStockSummary[]>;
}
