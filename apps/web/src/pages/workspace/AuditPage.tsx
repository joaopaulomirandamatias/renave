import {
  Button,
  EmptyState,
  StatusBadge,
  type StatusBadgeTone,
} from "@seu-renave/ui";
import { LockKeyhole, RefreshCw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  LoadTenantAuditEventsInput,
  TenantAuditEventItem,
  TenantAuditEventsResult,
  TenantAuditOutcome,
} from "../../features/audit/client.js";

export interface AuditPageProps {
  onLoad: (
    input: Omit<LoadTenantAuditEventsInput, "tenantId">,
  ) => Promise<TenantAuditEventsResult>;
  selectedEstablishmentId?: string;
  selectionKey: string;
}

type AuditScope = "all" | "active";

type ViewState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "error" }
  | {
      hasMore: boolean;
      items: readonly TenantAuditEventItem[];
      nextBeforeSequence?: number;
      status: "ready";
    };

const OUTCOME_PRESENTATION: Readonly<
  Record<TenantAuditOutcome, { label: string; tone: StatusBadgeTone }>
> = Object.freeze({
  attempted: { label: "Tentativa", tone: "info" },
  manual_review: { label: "Revisão humana", tone: "warning" },
  outcome_unknown: { label: "Incerto", tone: "warning" },
  reconciled: { label: "Reconciliado", tone: "success" },
  rejected: { label: "Negado", tone: "danger" },
  succeeded: { label: "Sucesso", tone: "success" },
});

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

function formatAuditDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

function mergeAuditItems(
  current: readonly TenantAuditEventItem[],
  incoming: readonly TenantAuditEventItem[],
): readonly TenantAuditEventItem[] {
  const seen = new Set(current.map((item) => item.sequence));
  const merged = [...current];
  for (const item of incoming) {
    if (!seen.has(item.sequence)) {
      seen.add(item.sequence);
      merged.push(item);
    }
  }
  return merged;
}

export function AuditPage({
  onLoad,
  selectedEstablishmentId,
  selectionKey,
}: AuditPageProps) {
  const [outcomeFilter, setOutcomeFilter] = useState<"" | TenantAuditOutcome>(
    "",
  );
  const [scopeFilter, setScopeFilter] = useState<AuditScope>("all");
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  const effectiveScope: AuditScope =
    scopeFilter === "active" && selectedEstablishmentId ? "active" : "all";

  const loadInitial = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    setState({ status: "loading" });
    setLoadingMore(false);
    setLoadMoreError(false);

    try {
      const result = await onLoadRef.current({
        limit: 25,
        signal: controller.signal,
        ...(effectiveScope === "active" && selectedEstablishmentId
          ? { establishmentId: selectedEstablishmentId }
          : {}),
        ...(outcomeFilter ? { outcome: outcomeFilter } : {}),
      });
      if (controller.signal.aborted || requestVersion.current !== version) {
        return;
      }
      if (result.status === "denied") {
        setState({ status: "denied" });
        return;
      }
      setState({
        hasMore: result.page.hasMore,
        items: result.page.items,
        ...(result.page.nextBeforeSequence !== undefined
          ? { nextBeforeSequence: result.page.nextBeforeSequence }
          : {}),
        status: "ready",
      });
    } catch {
      if (controller.signal.aborted || requestVersion.current !== version) {
        return;
      }
      setState({ status: "error" });
    }
  }, [effectiveScope, outcomeFilter, selectedEstablishmentId]);

  useEffect(() => {
    void loadInitial();
    return () => {
      activeRequest.current?.abort();
      requestVersion.current += 1;
    };
  }, [loadInitial, selectionKey]);

  async function loadMore() {
    if (
      state.status !== "ready" ||
      !state.hasMore ||
      state.nextBeforeSequence === undefined ||
      loadingMore
    ) {
      return;
    }
    const version = requestVersion.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);

    try {
      const result = await onLoad({
        beforeSequence: state.nextBeforeSequence,
        limit: 25,
        signal: controller.signal,
        ...(effectiveScope === "active" && selectedEstablishmentId
          ? { establishmentId: selectedEstablishmentId }
          : {}),
        ...(outcomeFilter ? { outcome: outcomeFilter } : {}),
      });
      if (controller.signal.aborted || requestVersion.current !== version) {
        return;
      }
      if (result.status === "denied") {
        setState({ status: "denied" });
        return;
      }
      setState((current) => {
        if (current.status !== "ready") return current;
        return {
          hasMore: result.page.hasMore,
          items: mergeAuditItems(current.items, result.page.items),
          ...(result.page.nextBeforeSequence !== undefined
            ? { nextBeforeSequence: result.page.nextBeforeSequence }
            : {}),
          status: "ready",
        };
      });
    } catch {
      if (!controller.signal.aborted && requestVersion.current === version) {
        setLoadMoreError(true);
      }
    } finally {
      if (requestVersion.current === version) {
        setLoadingMore(false);
      }
    }
  }

  const busy = state.status === "loading" || loadingMore;

  return (
    <section
      className="audit-page"
      aria-busy={busy}
      aria-labelledby="audit-page-title"
    >
      <header className="audit-page__toolbar">
        <div className="audit-page__heading">
          <h2 id="audit-page-title">Trilha de auditoria da organização</h2>
          <p className="audit-page__seal">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>
              Registro imutável · encadeado por hash · retenção de 5 anos
            </span>
          </p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw size={18} />}
          loading={state.status === "loading"}
          loadingLabel="Atualizando…"
          onClick={() => void loadInitial()}
        >
          Atualizar auditoria
        </Button>
      </header>

      <div className="audit-page__filters">
        <div className="audit-page__filter">
          <label htmlFor="audit-filter-outcome">Resultado</label>
          <select
            id="audit-filter-outcome"
            value={outcomeFilter}
            disabled={busy}
            onChange={(event) =>
              setOutcomeFilter(
                event.currentTarget.value as "" | TenantAuditOutcome,
              )
            }
          >
            <option value="">Todos</option>
            <option value="succeeded">Sucesso</option>
            <option value="rejected">Negado</option>
            <option value="outcome_unknown">Incerto</option>
            <option value="manual_review">Revisão humana</option>
            <option value="reconciled">Reconciliado</option>
            <option value="attempted">Tentativa</option>
          </select>
        </div>

        <div className="audit-page__filter">
          <label htmlFor="audit-filter-scope">Escopo</label>
          <select
            id="audit-filter-scope"
            value={effectiveScope}
            disabled={busy || !selectedEstablishmentId}
            onChange={(event) =>
              setScopeFilter(event.currentTarget.value as AuditScope)
            }
          >
            <option value="all">Toda a organização</option>
            {selectedEstablishmentId ? (
              <option value="active">Estabelecimento ativo</option>
            ) : null}
          </select>
        </div>
      </div>

      {state.status === "loading" ? (
        <p className="context-feedback" role="status">
          Carregando trilha de auditoria…
        </p>
      ) : null}

      {state.status === "denied" ? (
        <section className="context-feedback" role="status">
          <h3>Acesso restrito à auditoria</h3>
          <p>
            Seu perfil não possui permissão de leitura da trilha de auditoria
            neste contexto. Nenhum evento foi exibido.
          </p>
        </section>
      ) : null}

      {state.status === "error" ? (
        <section
          className="context-feedback context-feedback--error"
          role="alert"
        >
          <h3>Trilha de auditoria indisponível</h3>
          <p>
            Não foi possível consultar os eventos de auditoria agora. Tente
            novamente em instantes.
          </p>
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw size={18} />}
            onClick={() => void loadInitial()}
          >
            Tentar novamente
          </Button>
        </section>
      ) : null}

      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={24} />}
          title="Nenhum evento de auditoria encontrado"
          description="Não há eventos registrados para os filtros selecionados nesta organização."
        />
      ) : null}

      {state.status === "ready" && state.items.length > 0 ? (
        <div className="audit-page__results">
          <div className="audit-page__table-wrap">
            <table className="audit-page__table">
              <caption className="sr-only">
                Eventos de auditoria da organização
              </caption>
              <thead>
                <tr>
                  <th scope="col">Sequência</th>
                  <th scope="col">Data/hora</th>
                  <th scope="col">Ação</th>
                  <th scope="col">Entidade</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">Rastreabilidade</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => {
                  const outcome = OUTCOME_PRESENTATION[item.outcome];
                  return (
                    <tr key={item.sequence}>
                      <td className="audit-page__sequence">#{item.sequence}</td>
                      <td>
                        <time dateTime={item.occurredAt}>
                          {formatAuditDateTime(item.occurredAt)}
                        </time>
                      </td>
                      <td>
                        <code className="audit-page__code">{item.action}</code>
                      </td>
                      <td>{item.entityType}</td>
                      <td>
                        <StatusBadge tone={outcome.tone}>
                          {outcome.label}
                        </StatusBadge>
                      </td>
                      <td>
                        <div className="audit-page__trace">
                          <span>{item.traceId ?? "Sem trace"}</span>
                          <code className="audit-page__hash">
                            {item.eventHashPrefix}
                          </code>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {loadMoreError ? (
            <p
              className="context-feedback context-feedback--error"
              role="alert"
            >
              Não foi possível carregar eventos anteriores. Os eventos já
              exibidos foram preservados.
            </p>
          ) : null}

          {state.hasMore && state.nextBeforeSequence !== undefined ? (
            <div className="audit-page__pagination">
              <Button
                variant="secondary"
                loading={loadingMore}
                loadingLabel="Carregando…"
                onClick={() => void loadMore()}
              >
                Carregar eventos anteriores
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
