import {
  AppShell,
  type AppEnvironment,
  type AppShellEstablishment,
  Button,
} from "@seu-renave/ui";
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  FileClock,
  Gauge,
  History,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { BrowserRenaveLinkStatus } from "../App.js";

export interface DashboardPageProps {
  environment: AppEnvironment;
  establishments: readonly AppShellEstablishment[];
  logoutPending?: boolean;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError?: boolean;
  linkStatusLoading?: boolean;
  onEstablishmentChange?: (establishmentId: string) => void;
  onLogout: () => void | Promise<void>;
  onReloadLinkStatus?: () => void;
  onRunPreflight?: () => void;
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
  {
    id: "inventory",
    label: "Estoque",
    href: "/estoque",
    icon: <Boxes size={19} />,
  },
  {
    id: "pending",
    label: "Pendências",
    href: "/pendencias",
    icon: <FileClock size={19} />,
  },
  {
    id: "audit",
    label: "Auditoria",
    href: "/auditoria",
    icon: <History size={19} />,
  },
  {
    id: "settings",
    label: "Configurações",
    href: "/configuracoes",
    icon: <Settings size={19} />,
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
  environment,
  establishments,
  logoutPending = false,
  linkStatus,
  linkStatusError = false,
  linkStatusLoading = false,
  onEstablishmentChange,
  onLogout,
  onReloadLinkStatus,
  onRunPreflight,
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
          <Button
            variant="primary"
            leadingIcon={<ClipboardCheck size={18} />}
            disabled
            aria-describedby="eligibility-blocked-reason"
          >
            Consultar aptidão
          </Button>
          <p id="eligibility-blocked-reason" className="sr-only">
            Disponível após validar o vínculo do estabelecimento no RENAVE.
          </p>
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
                  Vínculo confirmado em homologação
                </h2>
                <p>
                  A identidade foi confirmada. Mutações permanecem bloqueadas
                  até a conclusão dos controles operacionais e da homologação.
                </p>
              </>
            ) : (
              <>
                <h2 id="integration-alert-title">Integração ainda protegida</h2>
                <p>
                  As operações permanecem bloqueadas até o RENAVE confirmar o
                  CNPJ do estabelecimento e o vínculo da integradora em
                  homologação.
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
              A verificação exige configuração segura da integração RENAVE em
              homologação.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="daily-summary-title">
          <div className="dashboard-page__section-heading">
            <div>
              <p>Hoje</p>
              <h2 id="daily-summary-title">Resumo do estabelecimento</h2>
            </div>
            <span>Sem dados operacionais até a primeira sincronização</span>
          </div>

          <div className="dashboard-page__stats">
            <article>
              <Gauge size={21} aria-hidden="true" />
              <p>Operações confirmadas</p>
              <strong aria-label="Nenhuma operação confirmada">0</strong>
            </article>
            <article>
              <FileClock size={21} aria-hidden="true" />
              <p>Pendências abertas</p>
              <strong aria-label="Nenhuma pendência aberta">0</strong>
            </article>
            <article>
              <AlertTriangle size={21} aria-hidden="true" />
              <p>Resultados incertos</p>
              <strong aria-label="Nenhum resultado incerto">0</strong>
            </article>
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
