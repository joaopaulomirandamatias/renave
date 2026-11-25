import { Button, Card } from "@seu-renave/ui";
import { ClipboardList, Link2, SearchCheck, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  EstablishmentManagementCapability,
} from "../../App.js";
import type { PendingOperationsPage } from "../../features/pending-operations/client.js";
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
  onLoadPendingOperations?: (
    signal: AbortSignal,
  ) => Promise<PendingOperationsPage>;
  onReloadLinkStatus?: () => void;
  preflightAvailable: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError: boolean;
  readinessLoading: boolean;
  selectionKey?: string;
}

type PendingSummaryState =
  | { status: "idle" | "loading" | "error" }
  | {
      manualReview: number;
      pendingReconciliation: number;
      status: "ready";
      total: number;
      truncated: boolean;
    };

const LINK_STATUS_LABELS: Readonly<Record<BrowserRenaveLinkStatus, string>> =
  Object.freeze({
    confirmed: "Confirmado",
    deactivated: "Desativado",
    enabled: "Habilitado",
    not_started: "Não iniciado",
    pending: "Pendente",
    rejected: "Rejeitado",
  });

const QUERY_READINESS_LABELS: Readonly<
  Record<BrowserRenaveReadiness["queries"], string>
> = Object.freeze({
  blocked: "Bloqueada",
  ready: "Pronta",
});

export function DashboardHomePage({
  canCreateEstablishment,
  contextError,
  contextLoading,
  establishmentManagement,
  hasEstablishment,
  linkStatus,
  linkStatusError,
  linkStatusLoading,
  onLoadPendingOperations,
  onReloadLinkStatus,
  preflightAvailable,
  readiness,
  readinessError,
  readinessLoading,
  selectionKey,
}: DashboardHomePageProps) {
  const [pendingState, setPendingState] = useState<PendingSummaryState>({
    status: "idle",
  });
  const pendingRequestVersion = useRef(0);

  useEffect(() => {
    if (!hasEstablishment || !onLoadPendingOperations || !selectionKey) {
      pendingRequestVersion.current += 1;
      setPendingState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    const version = ++pendingRequestVersion.current;
    setPendingState({ status: "loading" });

    void onLoadPendingOperations(controller.signal)
      .then((page) => {
        if (
          controller.signal.aborted ||
          pendingRequestVersion.current !== version
        ) {
          return;
        }
        let pendingReconciliation = 0;
        let manualReview = 0;
        for (const item of page.items) {
          if (item.status === "PENDING_RECONCILIATION") {
            pendingReconciliation += 1;
          } else if (item.status === "MANUAL_REVIEW") {
            manualReview += 1;
          }
        }
        setPendingState({
          manualReview,
          pendingReconciliation,
          status: "ready",
          total: page.items.length,
          truncated: page.truncated,
        });
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          pendingRequestVersion.current !== version
        ) {
          return;
        }
        setPendingState({ status: "error" });
      });

    return () => {
      controller.abort();
      pendingRequestVersion.current += 1;
    };
  }, [hasEstablishment, onLoadPendingOperations, selectionKey]);

  const linkValue = linkStatusLoading
    ? "Em verificação"
    : linkStatusError || !linkStatus
      ? "Indisponível agora"
      : LINK_STATUS_LABELS[linkStatus];

  const queriesValue = readinessLoading
    ? "Em verificação"
    : readinessError || !readiness
      ? "Indisponível agora"
      : QUERY_READINESS_LABELS[readiness.queries];

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
        </div>

        <div className="dashboard-page__stats">
          <Card as="article" className="dashboard-page__stat-card">
            <div className="dashboard-page__stat-header">
              <ClipboardList size={20} aria-hidden="true" />
              <h3>Pendências abertas</h3>
            </div>
            {pendingState.status === "ready" ? (
              <>
                <strong>
                  {pendingState.truncated
                    ? `${pendingState.total}+`
                    : pendingState.total}
                </strong>
                <p className="dashboard-page__stat-detail">
                  {pendingState.total === 0
                    ? "Nenhuma operação aguardando reconciliação ou revisão."
                    : `${pendingState.pendingReconciliation} em verificação automática · ${pendingState.manualReview} em revisão humana`}
                </p>
              </>
            ) : pendingState.status === "loading" ? (
              <p className="dashboard-page__stat-value" role="status">
                Em verificação…
              </p>
            ) : (
              <p className="dashboard-page__stat-value">Indisponível agora</p>
            )}
            <div className="dashboard-page__stat-action">
              <Button href="/pendencias" variant="quiet">
                Abrir pendências
              </Button>
            </div>
          </Card>

          <Card as="article" className="dashboard-page__stat-card">
            <div className="dashboard-page__stat-header">
              <Link2 size={20} aria-hidden="true" />
              <h3>Vínculo RENAVE</h3>
            </div>
            <strong
              className="dashboard-page__stat-status"
              {...(linkStatusLoading ? { role: "status" } : {})}
            >
              {linkValue}
            </strong>
            <p className="dashboard-page__stat-detail">
              Situação do credenciamento operacional do estabelecimento.
            </p>
            <div className="dashboard-page__stat-action">
              <Button href="/compliance" variant="quiet">
                Ver compliance
              </Button>
            </div>
          </Card>

          <Card as="article" className="dashboard-page__stat-card">
            <div className="dashboard-page__stat-header">
              <SearchCheck size={20} aria-hidden="true" />
              <h3>Prontidão de consultas</h3>
            </div>
            <strong
              className="dashboard-page__stat-status"
              {...(readinessLoading ? { role: "status" } : {})}
            >
              {queriesValue}
            </strong>
            <p className="dashboard-page__stat-detail">
              Disponibilidade de consultas ao estoque e aptidão RENAVE.
            </p>
            <div className="dashboard-page__stat-action">
              <Button href="/estoque" variant="quiet">
                Abrir estoque
              </Button>
            </div>
          </Card>
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
