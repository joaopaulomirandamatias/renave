import { type AppEnvironment, Button } from "@seu-renave/ui";
import { ShieldCheck } from "lucide-react";

import type {
  BrowserCredentialLinkQueueItem,
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  EstablishmentManagementCapability,
} from "../../App.js";
import {
  HomologationCanaryPanel,
  type ReadonlyCanaryPort,
} from "../../features/homologation-canary/index.js";
import { ActivationPage } from "../ActivationPage.js";
import { CredenciaLinkQueuePanel } from "../CredenciaLinkQueuePanel.js";
import { HomologationReadinessPanel } from "../HomologationReadinessPanel.js";

const linkStatusLabels: Record<BrowserRenaveLinkStatus, string> = {
  not_started: "Não iniciado",
  pending: "Pendente",
  confirmed: "Confirmado",
  enabled: "Habilitado",
  deactivated: "Desativado",
  rejected: "Rejeitado",
};

export interface CompliancePageProps {
  credentialLinkQueue?: readonly BrowserCredentialLinkQueueItem[];
  credentialLinkQueueError: boolean;
  credentialLinkQueueLoading: boolean;
  credentialLinkQueueTruncated: boolean;
  environment: AppEnvironment;
  establishmentManagement: EstablishmentManagementCapability;
  homologationCanaryPort?: ReadonlyCanaryPort;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError: boolean;
  linkStatusLoading: boolean;
  onReloadCredentialLinkQueue?: () => void;
  onReloadLinkStatus?: () => void;
  onRunPreflight?: () => void;
  preflightAvailable: boolean;
  preflightError: boolean;
  preflightPending: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError: boolean;
  readinessLoading: boolean;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
}

export function CompliancePage({
  credentialLinkQueue,
  credentialLinkQueueError,
  credentialLinkQueueLoading,
  credentialLinkQueueTruncated,
  environment,
  establishmentManagement,
  homologationCanaryPort,
  linkStatus,
  linkStatusError,
  linkStatusLoading,
  onReloadCredentialLinkQueue,
  onReloadLinkStatus,
  onRunPreflight,
  preflightAvailable,
  preflightError,
  preflightPending,
  readiness,
  readinessError,
  readinessLoading,
  selectedEstablishmentId,
  selectedTenantId,
}: CompliancePageProps) {
  const readinessAllowsPreflight =
    !readinessLoading &&
    !readinessError &&
    (readiness === undefined ||
      (readiness.integration === "configured" &&
        (readiness.certificate === "ready" ||
          readiness.certificate === "warning")));

  return (
    <>
      <section
        className="dashboard-page__link"
        aria-labelledby="renave-link-title"
        aria-busy={linkStatusLoading}
      >
        <ShieldCheck size={22} aria-hidden="true" />
        <div>
          <p>Credencia / RENAVE</p>
          <h2 id="renave-link-title">Vínculo do estabelecimento</h2>
          <strong aria-live="polite">
            {linkStatusLoading
              ? "Carregando vínculo…"
              : linkStatusError
                ? "Não foi possível carregar"
                : linkStatus
                  ? linkStatusLabels[linkStatus]
                  : "Selecione um estabelecimento"}
          </strong>
          {preflightError ? (
            <p role="alert">
              A verificação não foi concluída. O estado anterior foi preservado;
              tente novamente.
            </p>
          ) : null}
        </div>
        <Button
          variant="secondary"
          loading={preflightPending}
          loadingLabel="Verificando vínculo…"
          disabled={
            linkStatusLoading ||
            (linkStatusError
              ? !onReloadLinkStatus
              : !readinessAllowsPreflight ||
                !preflightAvailable ||
                !onRunPreflight)
          }
          aria-describedby={
            !linkStatusError &&
            (!preflightAvailable || !readinessAllowsPreflight)
              ? "preflight-unavailable-reason"
              : undefined
          }
          onClick={linkStatusError ? onReloadLinkStatus : onRunPreflight}
        >
          {linkStatusError ? "Tentar carregar vínculo" : "Verificar vínculo"}
        </Button>
        {!linkStatusError &&
        (!preflightAvailable || !readinessAllowsPreflight) ? (
          <p id="preflight-unavailable-reason" className="sr-only">
            A verificação exige configuração segura da integração RENAVE no
            ambiente configurado.
          </p>
        ) : null}
      </section>

      <ActivationPage
        hasEstablishment={Boolean(selectedEstablishmentId)}
        {...(linkStatus ? { linkStatus } : {})}
        linkStatusError={linkStatusError}
        linkStatusLoading={linkStatusLoading}
      />

      {establishmentManagement === "available" ? (
        <CredenciaLinkQueuePanel
          error={credentialLinkQueueError}
          loading={credentialLinkQueueLoading}
          truncated={credentialLinkQueueTruncated}
          {...(credentialLinkQueue ? { items: credentialLinkQueue } : {})}
          {...(onReloadCredentialLinkQueue
            ? { onReload: onReloadCredentialLinkQueue }
            : {})}
        />
      ) : null}

      <HomologationReadinessPanel
        error={readinessError}
        loading={readinessLoading}
        {...(readiness ? { readiness } : {})}
      />

      {environment === "homologation" &&
      establishmentManagement === "available" &&
      homologationCanaryPort &&
      selectedTenantId &&
      selectedEstablishmentId ? (
        <HomologationCanaryPanel
          key={`${selectedTenantId}:${selectedEstablishmentId}`}
          port={homologationCanaryPort}
          selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
        />
      ) : null}
    </>
  );
}
