import { Button, EmptyState, StatusBadge } from "@seu-renave/ui";
import { LockKeyhole, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  TenantUserItem,
  TenantUserRole,
  TenantUsersResult,
} from "../../features/tenant-users/client.js";

export interface UsersPageProps {
  establishments: readonly { id: string; label: string }[];
  onLoad: (signal: AbortSignal) => Promise<TenantUsersResult>;
  selectionKey: string;
}

type ViewState =
  | { status: "loading" }
  | { reason: "forbidden" | "mfa_required"; status: "denied" }
  | { status: "error" }
  | { items: readonly TenantUserItem[]; status: "ready" };

const ROLE_LABELS: Readonly<Record<TenantUserRole, string>> = Object.freeze({
  compliance_auditor: "Auditor de conformidade",
  renave_operator: "Operador RENAVE",
  tenant_admin: "Administrador da organização",
});

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

function resolveScopeLabel(
  establishmentIds: readonly string[],
  establishmentMap: ReadonlyMap<string, string>,
): string {
  if (establishmentIds.length === 0) {
    return "Todos os estabelecimentos";
  }
  return establishmentIds
    .map((id) => establishmentMap.get(id.toLowerCase()) ?? "Estabelecimento")
    .join(", ");
}

export function UsersPage({
  establishments,
  onLoad,
  selectionKey,
}: UsersPageProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  const establishmentMap = new Map(
    establishments.map((item) => [item.id.toLowerCase(), item.label]),
  );

  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    setState({ status: "loading" });

    try {
      const result = await onLoadRef.current(controller.signal);
      if (controller.signal.aborted || requestVersion.current !== version) {
        return;
      }
      if (result.status === "denied") {
        setState({ reason: result.reason, status: "denied" });
        return;
      }
      setState({ items: result.items, status: "ready" });
    } catch {
      if (controller.signal.aborted || requestVersion.current !== version) {
        return;
      }
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      activeRequest.current?.abort();
      requestVersion.current += 1;
    };
  }, [load, selectionKey]);

  return (
    <section
      className="audit-page"
      aria-busy={state.status === "loading"}
      aria-labelledby="users-page-title"
    >
      <header className="audit-page__toolbar">
        <div className="audit-page__heading">
          <h2 id="users-page-title">Vínculos administrativos da organização</h2>
          <p className="audit-page__seal">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>
              Identidades gerenciadas no provedor corporativo (OIDC) · o
              RenavEstoque nunca exibe subject nem credenciais
            </span>
          </p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw size={18} />}
          loading={state.status === "loading"}
          loadingLabel="Atualizando…"
          onClick={() => void load()}
        >
          Atualizar usuários
        </Button>
      </header>

      {state.status === "loading" ? (
        <p className="context-feedback" role="status">
          Carregando usuários e perfis da organização…
        </p>
      ) : null}

      {state.status === "denied" ? (
        <section className="context-feedback" role="status">
          <h3>
            {state.reason === "mfa_required"
              ? "Confirmação em duas etapas obrigatória"
              : "Acesso restrito a usuários e perfis"}
          </h3>
          <p>
            {state.reason === "mfa_required"
              ? "Esta consulta exige autenticação corporativa com verificação adicional (MFA). Nenhum registro foi exibido."
              : "Seu perfil não possui permissão administrativa para consultar os vínculos de usuários desta organização."}
          </p>
        </section>
      ) : null}

      {state.status === "error" ? (
        <section
          className="context-feedback context-feedback--error"
          role="alert"
        >
          <h3>Consulta de usuários indisponível</h3>
          <p>
            Não foi possível carregar os vínculos da organização agora. Tente
            novamente em instantes.
          </p>
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw size={18} />}
            onClick={() => void load()}
          >
            Tentar novamente
          </Button>
        </section>
      ) : null}

      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState
          icon={<Users size={24} />}
          title="Nenhum vínculo de usuário encontrado"
          description="Não há papéis atribuídos para exibição nesta organização."
        />
      ) : null}

      {state.status === "ready" && state.items.length > 0 ? (
        <div className="audit-page__table-wrap">
          <table className="audit-page__table">
            <caption className="sr-only">
              Usuários e perfis da organização
            </caption>
            <thead>
              <tr>
                <th scope="col">Membro</th>
                <th scope="col">Papel</th>
                <th scope="col">Escopo</th>
                <th scope="col">Situação</th>
                <th scope="col">Desde</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item) => (
                <tr key={`${item.memberId}:${item.role}`}>
                  <td>
                    <code className="audit-page__code">
                      {item.memberId.slice(0, 8).toUpperCase()}
                    </code>
                  </td>
                  <td>{ROLE_LABELS[item.role]}</td>
                  <td>
                    {resolveScopeLabel(item.establishmentIds, establishmentMap)}
                  </td>
                  <td>
                    <StatusBadge tone={item.active ? "success" : "neutral"}>
                      {item.active ? "Ativo" : "Inativo"}
                    </StatusBadge>
                  </td>
                  <td>
                    <time dateTime={item.createdAt}>
                      {formatDateTime(item.createdAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
