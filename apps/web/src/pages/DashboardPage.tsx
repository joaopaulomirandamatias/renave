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
  ArrowUpFromLine,
  Building2,
  CarFront,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  ScrollText,
  ShieldCheck,
  Users,
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
  CreateStockExitInput,
  CreateStockExitResult,
  EstablishmentManagementCapability,
} from "../App.js";
import type {
  LoadTenantAuditEventsInput,
  TenantAuditEventsResult,
} from "../features/audit/client.js";
import { type ReadonlyCanaryPort } from "../features/homologation-canary/index.js";
import type {
  PendingOperationDetail,
  PendingOperationsPage as PendingOperationsPageResult,
} from "../features/pending-operations/client.js";
import type { TenantUsersResult } from "../features/tenant-users/client.js";
import type { StockInventoryItem } from "./StockInventoryPanel.js";
import { StockDetailPage, type StockDetail } from "./StockDetailPage.js";
import {
  type WorkspaceRoute,
  workspaceNavigation,
} from "../workspace-routes.js";
import {
  AuditPage,
  CompliancePage,
  DashboardHomePage,
  EstablishmentsPage,
  PendingOperationDetailPage,
  PendingOperationsPage,
  StockEntryPage,
  StockExitPage,
  StockPage,
  UsersPage,
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
  initialStockExitPlate?: string;
  initialStockExitStockId?: number;
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
  onCreateStockExit?: (
    input: CreateStockExitInput,
  ) => Promise<CreateStockExitResult>;
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
  onLoadStockDetail?: (
    stockId: number,
    signal: AbortSignal,
  ) => Promise<StockDetail>;
  onLoadAuditEvents?: (
    input: Omit<LoadTenantAuditEventsInput, "tenantId">,
  ) => Promise<TenantAuditEventsResult>;
  onLoadTenantUsers?: (signal: AbortSignal) => Promise<TenantUsersResult>;
  onLoadPendingOperations?: (
    signal: AbortSignal,
  ) => Promise<PendingOperationsPageResult>;
  onLoadPendingOperationDetail?: (
    signal: AbortSignal,
  ) => Promise<PendingOperationDetail>;
  onBackStockDetail?: () => void;
  onBackPendingOperationDetail?: () => void;
  onReloadCredentialLinkQueue?: () => void;
  onStartStockExit?: (detail: { id: number; placa: string }) => void;
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
  pendingOperationId?: string;
  stockDetailId?: number;
  stockEntryOperationsEnabled?: boolean;
  stockExitOperationsEnabled?: boolean;
  tenants?: readonly { id: string; label: string }[];
  userDisplayName: string;
}

const navigationIcons: Record<WorkspaceRoute, ReactNode> = {
  dashboard: <LayoutDashboard size={19} />,
  stock: <CarFront size={19} />,
  "stock-detail": <CarFront size={19} />,
  "stock-entry": <ArrowDownToLine size={19} />,
  "stock-exit": <ArrowUpFromLine size={19} />,
  pending: <ClipboardList size={19} />,
  "pending-detail": <ClipboardList size={19} />,
  compliance: <ShieldCheck size={19} />,
  audit: <ScrollText size={19} />,
  establishments: <Building2 size={19} />,
  users: <Users size={19} />,
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
  "stock-detail": {
    eyebrow: "Operação de estoque",
    title: () => "Ficha do estoque RENAVE",
  },
  "stock-entry": {
    eyebrow: "Operação de estoque",
    title: () => "Dar entrada — veículo usado",
  },
  "stock-exit": {
    eyebrow: "Operação de estoque",
    title: () => "Registrar saída — veículo usado",
  },
  pending: {
    eyebrow: "Operação e compliance",
    title: () => "Pendências",
  },
  "pending-detail": {
    eyebrow: "Operação e compliance",
    title: () => "Detalhe da operação",
  },
  compliance: {
    eyebrow: "Compliance",
    title: () => "Conformidade e integração",
  },
  audit: {
    eyebrow: "Operação e compliance",
    title: () => "Auditoria",
  },
  establishments: {
    eyebrow: "Configurações",
    title: () => "Estabelecimentos e certificados",
  },
  users: {
    eyebrow: "Configurações",
    title: () => "Usuários & Perfis",
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
  initialStockExitPlate,
  initialStockExitStockId,
  logoutPending = false,
  logoutError = false,
  linkStatus,
  linkStatusError = false,
  linkStatusLoading = false,
  onCheckEligibility,
  onCreateEstablishment,
  onCreateStockEntry,
  onCreateStockExit,
  onEstablishmentChange,
  onLogout,
  onReloadLinkStatus,
  onRunPreflight,
  onSearchStocks,
  onLookupVehicle,
  onLoadRecentStocks,
  onLoadStockDetail,
  onLoadAuditEvents,
  onLoadTenantUsers,
  onLoadPendingOperations,
  onLoadPendingOperationDetail,
  onBackStockDetail,
  onBackPendingOperationDetail,
  onReloadCredentialLinkQueue,
  onStartStockExit,
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
  pendingOperationId,
  stockDetailId,
  stockEntryOperationsEnabled = false,
  stockExitOperationsEnabled = false,
  tenants = [],
  userDisplayName,
}: DashboardPageProps) {
  const navigation = workspaceNavigation
    .filter(
      (item) =>
        (item.id !== "stock-entry" || stockEntryOperationsEnabled) &&
        (item.id !== "stock-exit" || stockExitOperationsEnabled) &&
        ((item.id !== "establishments" && item.id !== "users") ||
          establishmentManagement !== "denied"),
    )
    .map((item) => ({
      ...item,
      current:
        item.id === route ||
        (item.id === "stock" && route === "stock-detail") ||
        (item.id === "pending" && route === "pending-detail"),
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
          {...(onLoadPendingOperations ? { onLoadPendingOperations } : {})}
          {...(onReloadLinkStatus ? { onReloadLinkStatus } : {})}
          {...(readiness ? { readiness } : {})}
          {...(selectedTenantId && selectedEstablishmentId
            ? { selectionKey: `${selectedTenantId}:${selectedEstablishmentId}` }
            : {})}
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
    case "stock-detail":
      if (linkStatusLoading || readinessLoading) {
        routeContent = (
          <p className="context-feedback" role="status">
            Verificando se a consulta do estoque está disponível…
          </p>
        );
      } else if (linkStatusError || readinessError) {
        routeContent = (
          <section
            className="context-feedback context-feedback--error"
            role="alert"
          >
            <h2>Ficha temporariamente indisponível</h2>
            <p>Não foi possível confirmar a prontidão da integração.</p>
          </section>
        );
      } else if (
        (linkStatus !== "confirmed" && linkStatus !== "enabled") ||
        readiness?.queries !== "ready"
      ) {
        routeContent = (
          <section className="context-feedback" role="status">
            <h2>Consulta do estoque indisponível</h2>
            <p>
              O estabelecimento ainda não está habilitado para consultar este
              registro.
            </p>
          </section>
        );
      } else {
        routeContent =
          stockDetailId &&
          onLoadStockDetail &&
          onBackStockDetail &&
          selectedTenantId &&
          selectedEstablishmentId ? (
            <StockDetailPage
              onBack={onBackStockDetail}
              onLoad={onLoadStockDetail}
              {...(stockExitOperationsEnabled && onStartStockExit
                ? { onStartStockExit }
                : {})}
              selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
              stockId={stockDetailId}
            />
          ) : null;
      }
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
    case "stock-exit":
      routeContent = (
        <StockExitPage
          stockExitOperationsEnabled={stockExitOperationsEnabled}
          {...(initialStockExitPlate
            ? { initialPlate: initialStockExitPlate }
            : {})}
          {...(initialStockExitStockId !== undefined
            ? { initialStockId: initialStockExitStockId }
            : {})}
          {...(linkStatus ? { linkStatus } : {})}
          {...(onCreateStockExit ? { onCreateStockExit } : {})}
          {...(readiness ? { readiness } : {})}
          {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
          {...(selectedTenantId ? { selectedTenantId } : {})}
        />
      );
      break;
    case "pending":
      routeContent =
        onLoadPendingOperations &&
        selectedTenantId &&
        selectedEstablishmentId ? (
          <PendingOperationsPage
            onLoad={onLoadPendingOperations}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
          />
        ) : (
          <p className="context-feedback" role="status">
            Selecione um estabelecimento para consultar as pendências.
          </p>
        );
      break;
    case "pending-detail":
      routeContent =
        pendingOperationId &&
        onLoadPendingOperationDetail &&
        onBackPendingOperationDetail &&
        selectedTenantId &&
        selectedEstablishmentId ? (
          <PendingOperationDetailPage
            onBack={onBackPendingOperationDetail}
            onLoad={onLoadPendingOperationDetail}
            operationId={pendingOperationId}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId}`}
          />
        ) : null;
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
    case "audit":
      routeContent =
        onLoadAuditEvents && selectedTenantId ? (
          <AuditPage
            onLoad={onLoadAuditEvents}
            {...(selectedEstablishmentId ? { selectedEstablishmentId } : {})}
            selectionKey={`${selectedTenantId}:${selectedEstablishmentId ?? ""}`}
          />
        ) : (
          <p className="context-feedback" role="status">
            Selecione uma organização para consultar a trilha de auditoria.
          </p>
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
    case "users":
      routeContent =
        onLoadTenantUsers && selectedTenantId ? (
          <UsersPage
            establishments={establishments}
            onLoad={onLoadTenantUsers}
            selectionKey={selectedTenantId}
          />
        ) : (
          <p className="context-feedback" role="status">
            Selecione uma organização para consultar usuários e perfis.
          </p>
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
