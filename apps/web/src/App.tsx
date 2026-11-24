import { Button, resolveAppEnvironment } from "@seu-renave/ui";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DashboardPage } from "./pages/DashboardPage.js";
import { LoginPage } from "./pages/LoginPage.js";

interface AnonymousSession {
  authenticated: false;
  authMode: "disabled" | "oidc";
  environment: string;
}

interface AuthenticatedSession {
  authenticated: true;
  authMode: "oidc";
  environment: string;
  expiresAt: string;
  user: {
    email?: string;
    name?: string;
  };
}

export type BrowserSession = AnonymousSession | AuthenticatedSession;

export interface BrowserTenant {
  displayName: string;
  tenantId: string;
}

export interface BrowserEstablishment {
  id: string;
  tradeName: string;
}

export type BrowserRenaveLinkStatus =
  | "not_started"
  | "pending"
  | "confirmed"
  | "enabled"
  | "deactivated"
  | "rejected";

export interface BrowserRenaveLink {
  preflightAvailable: boolean;
  status: BrowserRenaveLinkStatus;
}

export interface SessionClient {
  load(): Promise<BrowserSession>;
  loadEstablishments(
    tenantId: string,
  ): Promise<readonly BrowserEstablishment[]>;
  loadTenants(): Promise<readonly BrowserTenant[]>;
  loadRenaveLinkStatus(
    tenantId: string,
    establishmentId: string,
  ): Promise<BrowserRenaveLink>;
  logout(): Promise<{ endSessionUrl?: string }>;
  runRenaveLinkPreflight(
    tenantId: string,
    establishmentId: string,
  ): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): BrowserSession {
  if (!isRecord(value) || typeof value.authenticated !== "boolean") {
    throw new Error("Resposta de sessão inválida");
  }
  const environment =
    typeof value.environment === "string" ? value.environment : "development";
  const authMode = value.authMode === "oidc" ? "oidc" : "disabled";
  if (!value.authenticated) {
    return { authenticated: false, authMode, environment };
  }
  if (authMode !== "oidc" || !isRecord(value.user)) {
    throw new Error("Resposta autenticada inválida");
  }
  if (typeof value.expiresAt !== "string") {
    throw new Error("Expiração da sessão ausente");
  }
  return {
    authenticated: true,
    authMode,
    environment,
    expiresAt: value.expiresAt,
    user: {
      ...(typeof value.user.name === "string" ? { name: value.user.name } : {}),
      ...(typeof value.user.email === "string"
        ? { email: value.user.email }
        : {}),
    },
  };
}

function parseTenants(value: unknown): readonly BrowserTenant[] {
  if (!isRecord(value) || !Array.isArray(value.tenants)) {
    throw new Error("Resposta do diretório de organizações inválida");
  }
  return value.tenants.map((tenant) => {
    if (
      !isRecord(tenant) ||
      typeof tenant.tenantId !== "string" ||
      typeof tenant.displayName !== "string" ||
      tenant.tenantId.length === 0 ||
      tenant.displayName.trim().length === 0
    ) {
      throw new Error("Organização inválida no diretório");
    }
    return {
      displayName: tenant.displayName,
      tenantId: tenant.tenantId,
    };
  });
}

function parseEstablishments(value: unknown): readonly BrowserEstablishment[] {
  if (!isRecord(value) || !Array.isArray(value.establishments)) {
    throw new Error("Resposta de estabelecimentos inválida");
  }
  return value.establishments.map((establishment) => {
    if (
      !isRecord(establishment) ||
      typeof establishment.id !== "string" ||
      typeof establishment.tradeName !== "string" ||
      establishment.id.length === 0 ||
      establishment.tradeName.trim().length === 0
    ) {
      throw new Error("Estabelecimento inválido no diretório");
    }
    return { id: establishment.id, tradeName: establishment.tradeName };
  });
}

const renaveLinkStatuses = new Set<BrowserRenaveLinkStatus>([
  "not_started",
  "pending",
  "confirmed",
  "enabled",
  "deactivated",
  "rejected",
]);

function parseRenaveLink(value: unknown): BrowserRenaveLink {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !renaveLinkStatuses.has(value.status as BrowserRenaveLinkStatus) ||
    typeof value.preflightAvailable !== "boolean"
  ) {
    throw new Error("Resposta do vínculo RENAVE inválida");
  }
  return {
    preflightAvailable: value.preflightAvailable,
    status: value.status as BrowserRenaveLinkStatus,
  };
}

export const browserSessionClient: SessionClient = {
  async load() {
    const response = await fetch("/api/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Não foi possível verificar a sessão");
    return parseSession(await response.json());
  },
  async loadTenants() {
    const response = await fetch("/api/tenants", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error("Não foi possível carregar as organizações");
    return parseTenants(await response.json());
  },
  async loadEstablishments(tenantId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments`,
      {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok)
      throw new Error("Não foi possível carregar os estabelecimentos");
    return parseEstablishments(await response.json());
  },
  async loadRenaveLinkStatus(tenantId, establishmentId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/renave-link`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Não foi possível carregar o vínculo");
    return parseRenaveLink(await response.json());
  },
  async logout() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Não foi possível encerrar a sessão");
    const value: unknown = await response.json();
    if (!isRecord(value) || value.loggedOut !== true) {
      throw new Error("Resposta de logout inválida");
    }
    if (typeof value.endSessionUrl !== "string") return {};
    const target = new URL(value.endSessionUrl);
    if (target.protocol !== "https:") {
      throw new Error("Destino de logout inválido");
    }
    return { endSessionUrl: target.href };
  },
  async runRenaveLinkPreflight(tenantId, establishmentId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/renave-link-preflight`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error("Não foi possível verificar o vínculo");
  },
};

export interface AppProps {
  client?: SessionClient;
  redirect?: (url: string) => void;
}

type ViewState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      session: BrowserSession;
      tenants: readonly BrowserTenant[];
    };

type RenaveLinkView =
  | { status: "idle" | "loading" | "error" }
  | { link: BrowserRenaveLink; status: "ready" };

export function App({
  client = browserSessionClient,
  redirect = (url) => window.location.assign(url),
}: AppProps) {
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [logoutPending, setLogoutPending] = useState(false);
  const [preflightPendingKey, setPreflightPendingKey] = useState<string>();
  const [preflightErrorKey, setPreflightErrorKey] = useState<string>();
  const [renaveLinkView, setRenaveLinkView] = useState<RenaveLinkView>({
    status: "idle",
  });
  const [linkReloadVersion, setLinkReloadVersion] = useState(0);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [establishments, setEstablishments] = useState<
    readonly BrowserEstablishment[]
  >([]);
  const [selectedEstablishmentByTenant, setSelectedEstablishmentByTenant] =
    useState<Record<string, string>>({});
  const tenantRequestVersion = useRef(0);
  const loadRequestVersion = useRef(0);
  const linkLoadVersion = useRef(0);
  const activeSelectionKeyRef = useRef("");

  const load = useCallback(async () => {
    const requestVersion = ++loadRequestVersion.current;
    tenantRequestVersion.current += 1;
    setView({ status: "loading" });
    try {
      const session = await client.load();
      const tenants = session.authenticated ? await client.loadTenants() : [];
      const initialTenantId = tenants[0]?.tenantId ?? "";
      const initialEstablishments = initialTenantId
        ? await client.loadEstablishments(initialTenantId)
        : [];
      if (loadRequestVersion.current !== requestVersion) return;
      setSelectedTenantId(initialTenantId);
      setEstablishments(initialEstablishments);
      setSelectedEstablishmentByTenant(
        initialTenantId && initialEstablishments[0]
          ? { [initialTenantId]: initialEstablishments[0].id }
          : {},
      );
      setView({ status: "ready", session, tenants });
    } catch {
      if (loadRequestVersion.current === requestVersion) {
        setView({ status: "error" });
      }
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeEstablishmentId = selectedEstablishmentByTenant[selectedTenantId];
  activeSelectionKeyRef.current = `${selectedTenantId}:${activeEstablishmentId ?? ""}`;
  useEffect(() => {
    const authenticated = view.status === "ready" && view.session.authenticated;
    if (!authenticated || !selectedTenantId || !activeEstablishmentId) {
      linkLoadVersion.current += 1;
      setRenaveLinkView({ status: "idle" });
      return;
    }
    const requestVersion = ++linkLoadVersion.current;
    setRenaveLinkView({ status: "loading" });
    void client
      .loadRenaveLinkStatus(selectedTenantId, activeEstablishmentId)
      .then((link) => {
        if (linkLoadVersion.current === requestVersion) {
          setRenaveLinkView({ link, status: "ready" });
        }
      })
      .catch(() => {
        if (linkLoadVersion.current === requestVersion) {
          setRenaveLinkView({ status: "error" });
        }
      });
  }, [
    activeEstablishmentId,
    client,
    linkReloadVersion,
    selectedTenantId,
    view,
  ]);

  if (view.status === "loading") {
    return (
      <main className="session-state" aria-busy="true">
        <p role="status">Verificando sua sessão segura…</p>
      </main>
    );
  }

  if (view.status === "error") {
    return (
      <main className="session-state">
        <section
          className="session-error"
          aria-labelledby="session-error-title"
        >
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <h1 id="session-error-title">
              Não foi possível verificar o acesso
            </h1>
            <p>
              A sessão não foi alterada. Tente novamente antes de iniciar uma
              operação.
            </p>
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={18} />}
              onClick={() => void load()}
            >
              Tentar novamente
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const { session, tenants } = view;
  const environment = resolveAppEnvironment(session.environment);
  if (!session.authenticated) {
    return <LoginPage environment={environment} />;
  }

  async function logout() {
    setLogoutPending(true);
    try {
      const result = await client.logout();
      setView({
        status: "ready",
        tenants: [],
        session: {
          authenticated: false,
          authMode: "oidc",
          environment: session.environment,
        },
      });
      setSelectedTenantId("");
      setEstablishments([]);
      setSelectedEstablishmentByTenant({});
      tenantRequestVersion.current += 1;
      loadRequestVersion.current += 1;
      linkLoadVersion.current += 1;
      if (result.endSessionUrl) redirect(result.endSessionUrl);
    } finally {
      setLogoutPending(false);
    }
  }

  async function runPreflight() {
    if (!selectedTenantId || !activeEstablishmentId) return;
    const selectionKey = `${selectedTenantId}:${activeEstablishmentId}`;
    setPreflightPendingKey(selectionKey);
    setPreflightErrorKey(undefined);
    try {
      await client.runRenaveLinkPreflight(
        selectedTenantId,
        activeEstablishmentId,
      );
    } catch {
      if (activeSelectionKeyRef.current === selectionKey) {
        setPreflightErrorKey(selectionKey);
      }
    } finally {
      if (activeSelectionKeyRef.current === selectionKey) {
        const requestVersion = ++linkLoadVersion.current;
        setRenaveLinkView({ status: "loading" });
        try {
          const link = await client.loadRenaveLinkStatus(
            selectedTenantId,
            activeEstablishmentId,
          );
          if (
            linkLoadVersion.current === requestVersion &&
            activeSelectionKeyRef.current === selectionKey
          ) {
            setRenaveLinkView({ link, status: "ready" });
          }
        } catch {
          if (
            linkLoadVersion.current === requestVersion &&
            activeSelectionKeyRef.current === selectionKey
          ) {
            setRenaveLinkView({ status: "error" });
          }
        }
      }
      setPreflightPendingKey((current) =>
        current === selectionKey ? undefined : current,
      );
    }
  }

  if (tenants.length === 0) {
    return (
      <main className="session-state">
        <section className="session-error" aria-labelledby="tenant-empty-title">
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <h1 id="tenant-empty-title">
              Seu acesso ainda não está vinculado a uma organização
            </h1>
            <p>
              Peça ao administrador da sua empresa para liberar seu acesso.
              Nenhuma operação RENAVE foi disponibilizada para esta conta.
            </p>
            <Button
              variant="secondary"
              loading={logoutPending}
              loadingLabel="Saindo..."
              onClick={() => void logout()}
            >
              Sair
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const selectedTenant =
    tenants.find((tenant) => tenant.tenantId === selectedTenantId) ??
    tenants[0];

  async function selectTenant(tenantId: string) {
    const requestVersion = ++tenantRequestVersion.current;
    setSelectedTenantId(tenantId);
    setEstablishments([]);
    try {
      const nextEstablishments = await client.loadEstablishments(tenantId);
      if (tenantRequestVersion.current === requestVersion) {
        setEstablishments(nextEstablishments);
        setSelectedEstablishmentByTenant((current) => {
          const remembered = current[tenantId];
          const selected = nextEstablishments.some(
            (establishment) => establishment.id === remembered,
          )
            ? remembered
            : nextEstablishments[0]?.id;
          if (!selected) {
            const next = { ...current };
            delete next[tenantId];
            return next;
          }
          return { ...current, [tenantId]: selected };
        });
      }
    } catch {
      if (tenantRequestVersion.current === requestVersion) {
        setView({ status: "error" });
      }
    }
  }

  return (
    <DashboardPage
      environment={environment}
      establishments={establishments.map((establishment) => ({
        id: establishment.id,
        label: establishment.tradeName,
      }))}
      logoutPending={logoutPending}
      {...(renaveLinkView.status === "ready"
        ? { linkStatus: renaveLinkView.link.status }
        : {})}
      linkStatusError={renaveLinkView.status === "error"}
      linkStatusLoading={renaveLinkView.status === "loading"}
      onRunPreflight={() => void runPreflight()}
      onReloadLinkStatus={() => setLinkReloadVersion((current) => current + 1)}
      preflightAvailable={
        renaveLinkView.status === "ready" &&
        renaveLinkView.link.preflightAvailable
      }
      preflightError={
        preflightErrorKey ===
        `${selectedTenantId}:${activeEstablishmentId ?? ""}`
      }
      preflightPending={
        preflightPendingKey ===
        `${selectedTenantId}:${activeEstablishmentId ?? ""}`
      }
      onEstablishmentChange={(establishmentId) =>
        setSelectedEstablishmentByTenant((current) => ({
          ...current,
          [selectedTenantId]: establishmentId,
        }))
      }
      onLogout={logout}
      onTenantChange={(tenantId) => void selectTenant(tenantId)}
      {...(selectedEstablishmentByTenant[selectedTenantId]
        ? {
            selectedEstablishmentId:
              selectedEstablishmentByTenant[selectedTenantId],
          }
        : {})}
      {...(selectedTenant ? { selectedTenantId: selectedTenant.tenantId } : {})}
      tenants={tenants.map((tenant) => ({
        id: tenant.tenantId,
        label: tenant.displayName,
      }))}
      userDisplayName={
        session.user.name ?? session.user.email ?? "Usuário autenticado"
      }
    />
  );
}
