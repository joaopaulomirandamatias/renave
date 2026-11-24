import {
  AppShell,
  type AppEnvironment,
  type AppShellEstablishment,
  Button,
  type RenaveStockState,
} from "@seu-renave/ui";
import {
  LayoutDashboard,
  LogOut,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type {
  AuthFeedback,
  BrowserCrvType,
  BrowserEligibilitySummary,
  BrowserRenaveReadiness,
  BrowserRenaveLinkStatus,
  BrowserVehicle,
  CreateEstablishmentInput,
  CreateEstablishmentResult,
  CreateStockEntryInput,
  CreateStockEntryResult,
  EstablishmentManagementCapability,
} from "../App.js";
import { ActivationPage } from "./ActivationPage.js";
import { AttentionPanel } from "./AttentionPanel.js";
import { EstablishmentCreationPanel } from "./EstablishmentCreationPanel.js";
import { HomologationReadinessPanel } from "./HomologationReadinessPanel.js";
import { EligibilityPanel } from "./EligibilityPanel.js";
import { StockSearchPanel } from "./StockSearchPanel.js";
import { UsedStockEntryPanel } from "./UsedStockEntryPanel.js";

export interface DashboardPageProps {
  authFeedback?: AuthFeedback;
  contextError?: boolean;
  contextLoading?: boolean;
  environment: AppEnvironment;
  establishmentManagement?: EstablishmentManagementCapability;
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
  onCreateEstablishment?: (
    input: CreateEstablishmentInput,
  ) => Promise<CreateEstablishmentResult>;
  onCreateStockEntry?: (
    input: CreateStockEntryInput,
  ) => Promise<CreateStockEntryResult>;
  onEstablishmentChange?: (establishmentId: string) => void;
  onLogout: () => void | Promise<void>;
  onReloadLinkStatus?: () => void;
  onRunPreflight?: () => void;
  onSearchStocks?: (
    plate: string,
  ) => Promise<
    readonly { estado: RenaveStockState; id: number; placa: string }[]
  >;
  onLookupVehicle?: (plate: string) => Promise<BrowserVehicle>;
  onTenantChange?: (tenantId: string) => void;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
  preflightAvailable?: boolean;
  preflightError?: boolean;
  preflightPending?: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError?: boolean;
  readinessLoading?: boolean;
  stockEntryOperationsEnabled?: boolean;
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
  establishmentManagement = "denied",
  establishments,
  logoutPending = false,
  logoutError = false,
  linkStatus,
  linkStatusError = false,
  linkStatusLoading = false,
  onCheckEligibility,
  onCreateEstablishment,
  onCreateStockEntry,
  onEstablishmentChange,
  onLogout,
  onReloadLinkStatus,
  onRunPreflight,
  onSearchStocks,
  onLookupVehicle,
  onTenantChange,
  selectedEstablishmentId,
  selectedTenantId,
  preflightAvailable = false,
  preflightError = false,
  preflightPending = false,
  readiness,
  readinessError = false,
  readinessLoading = false,
  stockEntryOperationsEnabled = false,
  tenants = [],
  userDisplayName,
}: DashboardPageProps) {
  const activeTenant =
    tenants.find((tenant) => tenant.id === selectedTenantId) ?? tenants[0];
  const readinessAllowsPreflight =
    !readinessLoading &&
    !readinessError &&
    (readiness === undefined ||
      (readiness.integration === "configured" &&
        (readiness.certificate === "ready" ||
          readiness.certificate === "warning")));
  const queriesReady = readiness?.queries === "ready";
  const stockEntryAvailable =
    stockEntryOperationsEnabled &&
    readiness?.integration === "configured" &&
    (readiness.certificate === "ready" ||
      readiness.certificate === "warning") &&
    readiness.operatorIdentity === "verified" &&
    readiness.establishmentContact === "verified" &&
    readiness.link === "enabled" &&
    linkStatus === "enabled";
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

        <HomologationReadinessPanel
          error={readinessError}
          loading={readinessLoading}
          {...(readiness ? { readiness } : {})}
        />

        {onCreateEstablishment && selectedTenantId ? (
          <div id="establishment-creation">
            <EstablishmentCreationPanel
              capability={establishmentManagement}
              onCreate={onCreateEstablishment}
              selectionKey={selectedTenantId}
            />
          </div>
        ) : null}

        {onCreateStockEntry && selectedTenantId && selectedEstablishmentId ? (
          <UsedStockEntryPanel
            available={stockEntryAvailable}
            onCreate={onCreateStockEntry}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
          />
        ) : null}

        {(linkStatus === "confirmed" || linkStatus === "enabled") &&
        queriesReady &&
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
        queriesReady &&
        selectedTenantId &&
        selectedEstablishmentId &&
        onSearchStocks ? (
          <StockSearchPanel
            key={`${selectedTenantId}:${selectedEstablishmentId}`}
            onSearch={onSearchStocks}
            {...(onLookupVehicle ? { onLookupVehicle } : {})}
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

        <AttentionPanel
          canCreateEstablishment={Boolean(
            onCreateEstablishment && selectedTenantId,
          )}
          canReloadLinkStatus={Boolean(onReloadLinkStatus)}
          contextError={contextError}
          contextLoading={contextLoading}
          establishmentManagement={establishmentManagement}
          hasEstablishment={Boolean(selectedEstablishmentId)}
          linkStatusError={linkStatusError}
          linkStatusLoading={linkStatusLoading}
          preflightAvailable={preflightAvailable}
          readinessError={readinessError}
          readinessLoading={readinessLoading}
          {...(linkStatus ? { linkStatus } : {})}
          {...(onReloadLinkStatus ? { onReloadLinkStatus } : {})}
          {...(readiness ? { readiness } : {})}
        />
      </div>
    </AppShell>
  );
}
