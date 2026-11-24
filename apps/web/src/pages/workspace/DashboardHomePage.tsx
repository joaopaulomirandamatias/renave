import { ShieldAlert } from "lucide-react";

import type {
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  EstablishmentManagementCapability,
} from "../../App.js";
import { AttentionPanel } from "../AttentionPanel.js";

export interface DashboardHomePageProps {
  canCreateEstablishment: boolean;
  contextError: boolean;
  contextLoading: boolean;
  establishmentManagement: EstablishmentManagementCapability;
  hasEstablishment: boolean;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError: boolean;
  linkStatusLoading: boolean;
  onReloadLinkStatus?: () => void;
  preflightAvailable: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError: boolean;
  readinessLoading: boolean;
}

export function DashboardHomePage({
  canCreateEstablishment,
  contextError,
  contextLoading,
  establishmentManagement,
  hasEstablishment,
  linkStatus,
  linkStatusError,
  linkStatusLoading,
  onReloadLinkStatus,
  preflightAvailable,
  readiness,
  readinessError,
  readinessLoading,
}: DashboardHomePageProps) {
  return (
    <>
      <section
        className="dashboard-page__alert"
        aria-labelledby="integration-alert-title"
      >
        <ShieldAlert size={22} aria-hidden="true" />
        <div>
          {linkStatus === "confirmed" || linkStatus === "enabled" ? (
            <>
              <h2 id="integration-alert-title">
                Identidade do vínculo confirmada
              </h2>
              <p>
                A identidade foi confirmada. Mutações permanecem bloqueadas até
                a conclusão dos controles operacionais no ambiente configurado.
              </p>
            </>
          ) : (
            <>
              <h2 id="integration-alert-title">Integração ainda protegida</h2>
              <p>
                As operações permanecem bloqueadas até o RENAVE confirmar o CNPJ
                do estabelecimento e o vínculo da integradora no ambiente
                configurado.
              </p>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="daily-summary-title">
        <div className="dashboard-page__section-heading">
          <div>
            <p>Dados operacionais</p>
            <h2 id="daily-summary-title">Resumo do estabelecimento</h2>
          </div>
          <span>Indisponível nesta etapa</span>
        </div>
      </section>

      <AttentionPanel
        canCreateEstablishment={canCreateEstablishment}
        canReloadLinkStatus={Boolean(onReloadLinkStatus)}
        contextError={contextError}
        contextLoading={contextLoading}
        establishmentManagement={establishmentManagement}
        hasEstablishment={hasEstablishment}
        linkStatusError={linkStatusError}
        linkStatusLoading={linkStatusLoading}
        preflightAvailable={preflightAvailable}
        readinessError={readinessError}
        readinessLoading={readinessLoading}
        {...(linkStatus ? { linkStatus } : {})}
        {...(onReloadLinkStatus ? { onReloadLinkStatus } : {})}
        {...(readiness ? { readiness } : {})}
      />
    </>
  );
}
