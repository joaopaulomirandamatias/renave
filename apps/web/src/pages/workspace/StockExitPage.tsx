import type {
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  CreateStockExitInput,
  CreateStockExitResult,
} from "../../App.js";
import { UsedStockExitPanel } from "../UsedStockExitPanel.js";

export interface StockExitPageProps {
  initialPlate?: string;
  initialStockId?: number;
  linkStatus?: BrowserRenaveLinkStatus;
  onCreateStockExit?: (
    input: CreateStockExitInput,
  ) => Promise<CreateStockExitResult>;
  readiness?: BrowserRenaveReadiness;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
  stockExitOperationsEnabled: boolean;
}

export function StockExitPage({
  initialPlate,
  initialStockId,
  linkStatus,
  onCreateStockExit,
  readiness,
  selectedEstablishmentId,
  selectedTenantId,
  stockExitOperationsEnabled,
}: StockExitPageProps) {
  if (!onCreateStockExit || !selectedTenantId || !selectedEstablishmentId) {
    return null;
  }

  const available =
    stockExitOperationsEnabled &&
    readiness?.integration === "configured" &&
    (readiness.certificate === "ready" ||
      readiness.certificate === "warning") &&
    readiness.operatorIdentity === "verified" &&
    readiness.establishmentContact === "verified" &&
    readiness.link === "enabled" &&
    linkStatus === "enabled";

  return (
    <UsedStockExitPanel
      available={available}
      onCreate={onCreateStockExit}
      selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
      {...(initialPlate ? { initialPlate } : {})}
      {...(initialStockId !== undefined ? { initialStockId } : {})}
    />
  );
}
