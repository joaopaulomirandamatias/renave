import {
  AppShell,
  type AppEnvironment,
  type AppShellEstablishment,
  Button,
  type RenaveStockState,
} from "@seu-renave/ui";
import {
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type {
  AuthFeedback,
  BrowserCrvType,
  BrowserEligibilitySummary,
  BrowserRenaveLinkStatus,
} from "../App.js";
import { ActivationPage } from "./ActivationPage.js";
import { EligibilityPanel } from "./EligibilityPanel.js";
import { StockSearchPanel } from "./StockSearchPanel.js";

export interface DashboardPageProps {
  authFeedback?: AuthFeedback;
  contextError?: boolean;
  contextLoading?: boolean;
  environment: AppEnvironment;
  establishments: readonly AppShellEstablishment[];
  logoutPending?: boolean;
  logoutError?: boolean;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError?: boolean;
  linkStatusLoading?: boolean;
  onCheckEligibility?: (
    plate: string,
    crvType: BrowserCrvType,
  ) => Promise<BrowserEligibilitySummary>;
  onEstablishmentChange?: (establishmentId: string) => void;
  onLogout: () => void | Promise<void>;
  onReloadLinkStatus?: () => void;
  onRunPreflight?: () => void;
  onSearchStocks?: (
    plate: string,
  ) => Promise<
    readonly { estado: RenaveStockState; id: number; placa: string }[]
  >;
  onTenantChange?: (tenantId: string) => void;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
  preflightAvailable?: boolean;
  preflightError?: boolean;
  preflightPending?: boolean;
  tenants?: readonly { id: string; label: string }[];
  userDisplayName: string;
}

const navigation = [
  {
    id: "dashboard",
    label: "Painel",
    href: "/",
    current: true,
    icon: <LayoutDashboard size={19} />,
  },
] as const;

const linkStatusLabels: Record<BrowserRenaveLinkStatus, string> = {
  not_started: "Não iniciado",
  pending: "Pendente",
  confirmed: "Confirmado",
  enabled: "Habilitado",
  deactivated: "Desativado",
  rejected: "Rejeitado",
};

export function DashboardPage({
  authFeedback,
  contextError = false,
  contextLoading = false,
  environment,
  establishments,
  logoutPending = false,
  logoutError = false,
  linkStatus,
  linkStatusError = false,
  linkStatusLoading = false,
  onCheckEligibility,
  onEstablishmentChange,
  onLogout,
  onReloadLinkStatus,
  onRunPreflight,
  onSearchStocks,
  onTenantChange,
  selectedEstablishmentId,
  selectedTenantId,
  preflightAvailable = false,
  preflightError = false,
  preflightPending = false,
  tenants = [],
  userDisplayName,
}: DashboardPageProps) {
  const activeTenant =
    tenants.find((tenant) => tenant.id === selectedTenantId) ?? tenants[0];
  return (
    <AppShell
      environment={environment}
      establishments={establishments}
      navigation={navigation}
      {...(onEstablishmentChange ? { onEstablishmentChange } : {})}
      {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
      sidebarFooter="Plataforma privada. Não é o sistema oficial do governo."
      workspaceLabel={activeTenant?.label ?? "Operação RENAVE"}
      userMenu={
        <Button
          variant="quiet"
          leadingIcon={<LogOut size={18} />}
          loading={logoutPending}
          loadingLabel="Saindo..."
          onClick={onLogout}
        >
          Sair
        </Button>
      }
    >
      <div className="dashboard-page">
        {authFeedback ? (
          <section className="auth-feedback" role="alert">
            <h2>{authFeedback.title}</h2>
            <p>{authFeedback.message}</p>
          </section>
        ) : null}

        {contextLoading ? (
          <p className="context-feedback" role="status">
            Carregando estabelecimentos da organização selecionada…
          </p>
        ) : null}
        {contextError ? (
          <p className="context-feedback context-feedback--error" role="alert">
            Não foi possível trocar de organização. O contexto anterior foi
            preservado.
          </p>
        ) : null}
        {logoutError ? (
          <p className="context-feedback context-feedback--error" role="alert">
            Não foi possível encerrar a sessão. Você continua conectado e pode
            tentar novamente.
          </p>
        ) : null}

        <header className="dashboard-page__heading">
          <div>
            <p>Visão operacional</p>
            <h1>Olá, {userDisplayName}</h1>
          </div>
          {tenants.length > 1 ? (
            <div className="dashboard-page__tenant">
              <label htmlFor="active-tenant">Organização ativa</label>
              <select
                id="active-tenant"
                value={activeTenant?.id ?? ""}
                onChange={(event) =>
                  onTenantChange?.(event.currentTarget.value)
                }
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </header>

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
                  A identidade foi confirmada. Mutações permanecem bloqueadas
                  até a conclusão dos controles operacionais no ambiente
                  configurado.
                </p>
              </>
            ) : (
              <>
                <h2 id="integration-alert-title">Integração ainda protegida</h2>
                <p>
                  As operações permanecem bloqueadas até o RENAVE confirmar o
                  CNPJ do estabelecimento e o vínculo da integradora no ambiente
                  configurado.
                </p>
              </>
            )}
          </div>
        </section>

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
                A verificação não foi concluída. O estado anterior foi
                preservado; tente novamente.
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
                : !preflightAvailable || !onRunPreflight)
            }
            aria-describedby={
              !linkStatusError && !preflightAvailable
                ? "preflight-unavailable-reason"
                : undefined
            }
            onClick={linkStatusError ? onReloadLinkStatus : onRunPreflight}
          >
            {linkStatusError ? "Tentar carregar vínculo" : "Verificar vínculo"}
          </Button>
          {!linkStatusError && !preflightAvailable ? (
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

        {(linkStatus === "confirmed" || linkStatus === "enabled") &&
        selectedTenantId &&
        selectedEstablishmentId &&
        onCheckEligibility ? (
          <EligibilityPanel
            key={`eligibility:${selectedTenantId}:${selectedEstablishmentId}`}
            onCheck={onCheckEligibility}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
          />
        ) : null}

        {(linkStatus === "confirmed" || linkStatus === "enabled") &&
        selectedTenantId &&
        selectedEstablishmentId &&
        onSearchStocks ? (
          <StockSearchPanel
            key={`${selectedTenantId}:${selectedEstablishmentId}`}
            onSearch={onSearchStocks}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
          />
        ) : null}

        <section aria-labelledby="daily-summary-title">
          <div className="dashboard-page__section-heading">
            <div>
              <p>Dados operacionais</p>
              <h2 id="daily-summary-title">Resumo do estabelecimento</h2>
            </div>
            <span>Indisponível nesta etapa</span>
          </div>
        </section>

        <section
          className="dashboard-page__empty"
          aria-labelledby="attention-title"
        >
          <ClipboardCheck size={28} aria-hidden="true" />
          <div>
            <h2 id="attention-title">O que precisa da sua atenção agora</h2>
            <p>
              Nenhuma tarefa foi carregada. Quando a integração estiver
              validada, pendências e próximos passos aparecerão aqui.
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
