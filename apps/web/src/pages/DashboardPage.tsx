import {
  AppShell,
  type AppEnvironment,
  type AppShellEstablishment,
  Button,
  PageHeader,
  type RenaveStockState,
} from "@seu-renave/ui";
import {
  ArrowDownToLine,
  Building2,
  CarFront,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AuthFeedback,
  BrowserCrvType,
  BrowserCredentialLinkQueueItem,
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
import { type ReadonlyCanaryPort } from "../features/homologation-canary/index.js";
import type { StockInventoryItem } from "./StockInventoryPanel.js";
import {
  type WorkspaceRoute,
  workspaceNavigation,
} from "../workspace-routes.js";
import {
  CompliancePage,
  DashboardHomePage,
  EstablishmentsPage,
  StockEntryPage,
  StockPage,
} from "./workspace/index.js";

export interface DashboardPageProps {
  authFeedback?: AuthFeedback;
  credentialLinkQueue?: readonly BrowserCredentialLinkQueueItem[];
  credentialLinkQueueError?: boolean;
  credentialLinkQueueLoading?: boolean;
  credentialLinkQueueTruncated?: boolean;
  contextError?: boolean;
  contextLoading?: boolean;
  environment: AppEnvironment;
  establishmentManagement?: EstablishmentManagementCapability;
  establishments: readonly AppShellEstablishment[];
  homologationCanaryPort?: ReadonlyCanaryPort;
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
  onLoadRecentStocks?: (
    signal: AbortSignal,
  ) => Promise<readonly StockInventoryItem[]>;
  onReloadCredentialLinkQueue?: () => void;
  onTenantChange?: (tenantId: string) => void;
  selectedEstablishmentId?: string;
  selectedTenantId?: string;
  preflightAvailable?: boolean;
  preflightError?: boolean;
  preflightPending?: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError?: boolean;
  readinessLoading?: boolean;
  route?: WorkspaceRoute;
  stockEntryOperationsEnabled?: boolean;
  tenants?: readonly { id: string; label: string }[];
  userDisplayName: string;
}

const navigationIcons: Record<WorkspaceRoute, ReactNode> = {
  dashboard: <LayoutDashboard size={19} />,
  stock: <CarFront size={19} />,
  "stock-entry": <ArrowDownToLine size={19} />,
  compliance: <ShieldCheck size={19} />,
  establishments: <Building2 size={19} />,
};

const routeHeadings: Record<
  WorkspaceRoute,
  { eyebrow: string; title: (userDisplayName: string) => string }
> = {
  dashboard: {
    eyebrow: "Visão operacional",
    title: (userDisplayName) => `Olá, ${userDisplayName}`,
  },
  stock: {
    eyebrow: "Operação de estoque",
    title: () => "Estoque RENAVE",
  },
  "stock-entry": {
    eyebrow: "Operação de estoque",
    title: () => "Dar entrada — veículo usado",
  },
  compliance: {
    eyebrow: "Compliance",
    title: () => "Conformidade e integração",
  },
  establishments: {
    eyebrow: "Configurações",
    title: () => "Estabelecimentos e certificados",
  },
};

export function DashboardPage({
  authFeedback,
  credentialLinkQueue,
  credentialLinkQueueError = false,
  credentialLinkQueueLoading = false,
  credentialLinkQueueTruncated = false,
  contextError = false,
  contextLoading = false,
  environment,
  establishmentManagement = "denied",
  establishments,
  homologationCanaryPort,
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
  onLoadRecentStocks,
  onReloadCredentialLinkQueue,
  onTenantChange,
  selectedEstablishmentId,
  selectedTenantId,
  preflightAvailable = false,
  preflightError = false,
  preflightPending = false,
  readiness,
  readinessError = false,
  readinessLoading = false,
  route = "dashboard",
  stockEntryOperationsEnabled = false,
  tenants = [],
  userDisplayName,
}: DashboardPageProps) {
  const navigation = workspaceNavigation
    .filter(
      (item) =>
        (item.id !== "stock-entry" || stockEntryOperationsEnabled) &&
        (item.id !== "establishments" || establishmentManagement !== "denied"),
    )
    .map((item) => ({
      ...item,
      current: item.id === route,
      icon: navigationIcons[item.id],
    }));
  const routeHeading = routeHeadings[route];
  const activeTenant =
    tenants.find((tenant) => tenant.id === selectedTenantId) ?? tenants[0];
  let routeContent: ReactNode;
  switch (route) {
    case "dashboard":
      routeContent = (
        <DashboardHomePage
          canCreateEstablishment={Boolean(
            onCreateEstablishment && selectedTenantId,
          )}
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
      );
      break;
    case "stock":
      routeContent = (
        <StockPage
          {...(linkStatus ? { linkStatus } : {})}
          {...(onCheckEligibility ? { onCheckEligibility } : {})}
          {...(onLookupVehicle ? { onLookupVehicle } : {})}
          {...(onLoadRecentStocks ? { onLoadRecentStocks } : {})}
          {...(onSearchStocks ? { onSearchStocks } : {})}
          {...(readiness ? { readiness } : {})}
          {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
          {...(selectedTenantId ? { selectedTenantId } : {})}
        />
      );
      break;
    case "stock-entry":
      routeContent = (
        <StockEntryPage
          stockEntryOperationsEnabled={stockEntryOperationsEnabled}
          {...(linkStatus ? { linkStatus } : {})}
          {...(onCreateStockEntry ? { onCreateStockEntry } : {})}
          {...(readiness ? { readiness } : {})}
          {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
          {...(selectedTenantId ? { selectedTenantId } : {})}
        />
      );
      break;
    case "compliance":
      routeContent = (
        <CompliancePage
          credentialLinkQueueError={credentialLinkQueueError}
          credentialLinkQueueLoading={credentialLinkQueueLoading}
          credentialLinkQueueTruncated={credentialLinkQueueTruncated}
          environment={environment}
          establishmentManagement={establishmentManagement}
          linkStatusError={linkStatusError}
          linkStatusLoading={linkStatusLoading}
          preflightAvailable={preflightAvailable}
          preflightError={preflightError}
          preflightPending={preflightPending}
          readinessError={readinessError}
          readinessLoading={readinessLoading}
          {...(credentialLinkQueue ? { credentialLinkQueue } : {})}
          {...(homologationCanaryPort ? { homologationCanaryPort } : {})}
          {...(linkStatus ? { linkStatus } : {})}
          {...(onReloadCredentialLinkQueue
            ? { onReloadCredentialLinkQueue }
            : {})}
          {...(onReloadLinkStatus ? { onReloadLinkStatus } : {})}
          {...(onRunPreflight ? { onRunPreflight } : {})}
          {...(readiness ? { readiness } : {})}
          {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
          {...(selectedTenantId ? { selectedTenantId } : {})}
        />
      );
      break;
    case "establishments":
      routeContent = (
        <EstablishmentsPage
          establishmentManagement={establishmentManagement}
          {...(onCreateEstablishment ? { onCreateEstablishment } : {})}
          {...(selectedTenantId ? { selectedTenantId } : {})}
        />
      );
      break;
  }
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

        <PageHeader
          className="dashboard-page__heading"
          eyebrow={routeHeading.eyebrow}
          title={routeHeading.title(userDisplayName)}
          actions={
            tenants.length > 1 ? (
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
            ) : undefined
          }
        />
        {routeContent}
      </div>
    </AppShell>
  );
}
