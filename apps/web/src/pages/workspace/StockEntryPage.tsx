import type {
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  CreateStockEntryInput,
  CreateStockEntryResult,
} from "../../App.js";
import { UsedStockEntryPanel } from "../UsedStockEntryPanel.js";

export interface StockEntryPageProps {
  linkStatus?: BrowserRenaveLinkStatus;
  onCreateStockEntry?: (
    input: CreateStockEntryInput,
  ) => Promise<CreateStockEntryResult>;
  readiness?: BrowserRenaveReadiness;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
  stockEntryOperationsEnabled: boolean;
}

export function StockEntryPage({
  linkStatus,
  onCreateStockEntry,
  readiness,
  selectedEstablishmentId,
  selectedTenantId,
  stockEntryOperationsEnabled,
}: StockEntryPageProps) {
  if (!onCreateStockEntry || !selectedTenantId || !selectedEstablishmentId) {
    return null;
  }

  const available =
    stockEntryOperationsEnabled &&
    readiness?.integration === "configured" &&
    (readiness.certificate === "ready" ||
      readiness.certificate === "warning") &&
    readiness.operatorIdentity === "verified" &&
    readiness.establishmentContact === "verified" &&
    readiness.link === "enabled" &&
    linkStatus === "enabled";

  return (
    <UsedStockEntryPanel
      available={available}
      onCreate={onCreateStockEntry}
      selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
    />
  );
}
