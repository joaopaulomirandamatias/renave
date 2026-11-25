import {
  Button,
  Card,
  EmptyState,
  StatusBadge,
  type StatusBadgeTone,
} from "@seu-renave/ui";
import { CircleCheck, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  PendingOperationStatus,
  PendingOperationSummary,
  PendingOperationsPage as PendingOperationsPageResult,
} from "../../features/pending-operations/client.js";

export interface PendingOperationsPageProps {
  onLoad: (signal: AbortSignal) => Promise<PendingOperationsPageResult>;
  selectionKey: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "error" }
  | {
      page: PendingOperationsPageResult;
      refreshError: boolean;
      refreshing: boolean;
      status: "success";
    };

const STATUS_PRESENTATION: Readonly<
  Record<
    PendingOperationStatus,
    {
      cause: string;
      impact: string;
      label: string;
      nextAction: string;
      title: string;
      tone: StatusBadgeTone;
    }
  >
> = Object.freeze({
  PENDING_RECONCILIATION: {
    cause: "O RENAVE não confirmou a tempo se a solicitação foi registrada.",
    impact:
      "Uma nova tentativa antes da conferência pode duplicar a operação nacional.",
    label: "Resultado incerto",
    nextAction:
      "Acompanhe a verificação automática. Não reenvie esta operação.",
    title: "Verificação no RENAVE em andamento",
    tone: "warning",
  },
  MANUAL_REVIEW: {
    cause:
      "A verificação automática não reuniu evidência suficiente para concluir.",
    impact:
      "A operação permanece bloqueada até uma análise humana confirmar a situação.",
    label: "Revisão necessária",
    nextAction: "Consulte o detalhe e encaminhe a operação para análise.",
    title: "Operação precisa de revisão humana",
    tone: "danger",
  },
});

const KIND_LABELS = Object.freeze({
  USED_STOCK_ENTRY: "Entrada de veículo usado",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function displayDateTime(value: string): string {
  return DATE_FORMATTER.format(new Date(value));
}

function PendingItem({ item }: { item: PendingOperationSummary }) {
  const presentation = STATUS_PRESENTATION[item.status];
  return (
    <li data-status={item.status}>
      <Card
        className="pending-operations__item"
        headingLevel={3}
        title={presentation.title}
        description={KIND_LABELS[item.kind]}
        actions={
          <StatusBadge tone={presentation.tone}>
            {presentation.label}
          </StatusBadge>
        }
      >
        <dl className="pending-operations__explanation">
          <div>
            <dt>Causa</dt>
            <dd>{presentation.cause}</dd>
          </div>
          <div>
            <dt>Impacto</dt>
            <dd>{presentation.impact}</dd>
          </div>
          <div>
            <dt>Próxima ação</dt>
            <dd>{presentation.nextAction}</dd>
          </div>
        </dl>
        <div className="pending-operations__meta">
          <span>
            Atualizada em{" "}
            <time dateTime={item.updatedAt}>
              {displayDateTime(item.updatedAt)}
            </time>
          </span>
          <Button href={`/pendencias/${item.operationId}`} variant="secondary">
            Ver operação
          </Button>
        </div>
      </Card>
    </li>
  );
}

export function PendingOperationsPage({
  onLoad,
  selectionKey,
}: PendingOperationsPageProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);

  const load = useCallback(
    async (preserve: boolean) => {
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const version = ++requestVersion.current;
      if (preserve) {
        setState((current) =>
          current.status === "success"
            ? { ...current, refreshError: false, refreshing: true }
            : { status: "loading" },
        );
      } else {
        setState({ status: "loading" });
      }
      try {
        const page = await onLoad(controller.signal);
        if (!controller.signal.aborted && requestVersion.current === version) {
          setState({
            page,
            refreshError: false,
            refreshing: false,
            status: "success",
          });
        }
      } catch {
        if (!controller.signal.aborted && requestVersion.current === version) {
          setState((current) =>
            preserve && current.status === "success"
              ? { ...current, refreshError: true, refreshing: false }
              : { status: "error" },
          );
        }
      }
    },
    [onLoad],
  );

  useEffect(() => {
    void load(false);
    return () => {
      activeRequest.current?.abort();
      requestVersion.current += 1;
    };
  }, [load, selectionKey]);

  return (
    <section
      className="pending-operations"
      aria-busy={
        state.status === "loading" ||
        (state.status === "success" && state.refreshing)
      }
      aria-labelledby="pending-operations-title"
    >
      <header className="pending-operations__heading">
        <div>
          <p>Fila priorizada</p>
          <h2 id="pending-operations-title">
            O que precisa ser resolvido agora?
          </h2>
          <p>
            Operações ordenadas pelo servidor para evitar reenvios indevidos.
          </p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw size={18} />}
          loading={state.status === "success" && state.refreshing}
          loadingLabel="Atualizando pendências…"
          onClick={() => void load(state.status === "success")}
        >
          Atualizar pendências
        </Button>
      </header>

      <div className="pending-operations__content" aria-live="polite">
        {state.status === "loading" ? (
          <p role="status">Carregando pendências do estabelecimento…</p>
        ) : null}

        {state.status === "error" ? (
          <Card
            className="pending-operations__feedback"
            title="Pendências temporariamente indisponíveis"
            description="Nenhum dado foi exibido. Tente novamente antes de tomar uma decisão operacional."
            role="alert"
            actions={
              <Button variant="secondary" onClick={() => void load(false)}>
                Tentar novamente
              </Button>
            }
          />
        ) : null}

        {state.status === "success" && state.refreshError ? (
          <p className="pending-operations__refresh-error" role="alert">
            Não foi possível atualizar agora. A lista anterior foi preservada.
          </p>
        ) : null}

        {state.status === "success" && state.page.items.length === 0 ? (
          <EmptyState
            title="Nenhuma pendência aberta"
            description="Não há operações com resultado incerto ou revisão humana neste estabelecimento."
            icon={<CircleCheck size={22} />}
          />
        ) : null}

        {state.status === "success" && state.page.items.length > 0 ? (
          <>
            <div className="pending-operations__notice" role="note">
              <ShieldAlert size={20} aria-hidden="true" />
              <p>
                <strong>Não repita uma operação com resultado incerto.</strong>{" "}
                O RenavEstoque confere o estado nacional antes de permitir
                qualquer nova ação.
              </p>
            </div>
            <ol className="pending-operations__list">
              {state.page.items.map((item) => (
                <PendingItem item={item} key={item.operationId} />
              ))}
            </ol>
            {state.page.truncated ? (
              <p className="pending-operations__truncated" role="status">
                Esta visualização mostra as 50 pendências prioritárias. As
                demais permanecem preservadas no servidor.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
