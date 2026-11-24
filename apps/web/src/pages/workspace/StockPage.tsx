import type { RenaveStockState } from "@seu-renave/ui";

import type {
  BrowserCrvType,
  BrowserEligibilitySummary,
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  BrowserVehicle,
} from "../../App.js";
import { EligibilityPanel } from "../EligibilityPanel.js";
import { StockSearchPanel } from "../StockSearchPanel.js";

export interface StockPageProps {
  linkStatus?: BrowserRenaveLinkStatus;
  onCheckEligibility?: (
    plate: string,
    crvType: BrowserCrvType,
  ) => Promise<BrowserEligibilitySummary>;
  onLookupVehicle?: (plate: string) => Promise<BrowserVehicle>;
  onSearchStocks?: (
    plate: string,
  ) => Promise<
    readonly { estado: RenaveStockState; id: number; placa: string }[]
  >;
  readiness?: BrowserRenaveReadiness;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
}

export function StockPage({
  linkStatus,
  onCheckEligibility,
  onLookupVehicle,
  onSearchStocks,
  readiness,
  selectedEstablishmentId,
  selectedTenantId,
}: StockPageProps) {
  if (
    (linkStatus !== "confirmed" && linkStatus !== "enabled") ||
    readiness?.queries !== "ready" ||
    !selectedTenantId ||
    !selectedEstablishmentId
  ) {
    return null;
  }

  const selectionKey = `${selectedTenantId}:${selectedEstablishmentId}`;
  return (
    <>
      {onCheckEligibility ? (
        <EligibilityPanel
          key={`eligibility:${selectionKey}`}
          onCheck={onCheckEligibility}
          selectionKey={selectionKey}
        />
      ) : null}
      {onSearchStocks ? (
        <StockSearchPanel
          key={selectionKey}
          onSearch={onSearchStocks}
          {...(onLookupVehicle ? { onLookupVehicle } : {})}
          selectionKey={selectionKey}
        />
      ) : null}
    </>
  );
}
