import type {
  CreateEstablishmentInput,
  CreateEstablishmentResult,
  EstablishmentManagementCapability,
} from "../../App.js";
import { EstablishmentCreationPanel } from "../EstablishmentCreationPanel.js";

export interface EstablishmentsPageProps {
  establishmentManagement: EstablishmentManagementCapability;
  onCreateEstablishment?: (
    input: CreateEstablishmentInput,
  ) => Promise<CreateEstablishmentResult>;
  selectedTenantId?: string;
}

export function EstablishmentsPage({
  establishmentManagement,
  onCreateEstablishment,
  selectedTenantId,
}: EstablishmentsPageProps) {
  if (!onCreateEstablishment || !selectedTenantId) return null;

  return (
    <div id="establishment-creation">
      <EstablishmentCreationPanel
        capability={establishmentManagement}
        onCreate={onCreateEstablishment}
        selectionKey={selectedTenantId}
      />
    </div>
  );
}
