import {
  Button,
  Card,
  StatusBadge,
  type StatusBadgeTone,
} from "@seu-renave/ui";
import { ArrowLeft, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  OperationDetailStatus,
  OperationTimelineStatus,
  PendingOperationDetail,
} from "../../features/pending-operations/client.js";

export interface PendingOperationDetailPageProps {
  onBack: () => void;
  onLoad: (signal: AbortSignal) => Promise<PendingOperationDetail>;
  operationId: string;
  selectionKey: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "error" }
  | {
      detail: PendingOperationDetail;
      refreshError: boolean;
      refreshing: boolean;
      status: "success";
    };

const DETAIL_PRESENTATION: Readonly<
  Record<
    OperationDetailStatus,
    { description: string; label: string; tone: StatusBadgeTone }
  >
> = Object.freeze({
  PENDING_SEND: {
    description:
      "A preparação local terminou e a operação aguarda o fluxo seguro de envio.",
    label: "Aguardando envio",
    tone: "info",
  },
  SENT: {
    description:
      "A solicitação foi enviada e ainda aguarda uma confirmação operacional.",
    label: "Enviada",
    tone: "info",
  },
  REJECTED: {
    description:
      "A solicitação foi recusada. Consulte a linha do tempo para acompanhar o tratamento.",
    label: "Rejeitada",
    tone: "danger",
  },
  PENDING_RECONCILIATION: {
    description:
      "O RENAVE não respondeu a tempo. A verificação automática ocorre antes de qualquer nova tentativa.",
    label: "Resultado incerto",
    tone: "warning",
  },
  MANUAL_REVIEW: {
    description:
      "A verificação automática não foi conclusiva. A operação precisa de análise humana.",
    label: "Revisão necessária",
    tone: "danger",
  },
  CONFIRMED: {
    description:
      "A operação foi confirmada pelo RENAVE ou por reconciliação segura.",
    label: "Confirmada",
    tone: "success",
  },
});

const STATUS_PRESENTATION: Readonly<
  Record<OperationTimelineStatus, { label: string; tone: StatusBadgeTone }>
> = Object.freeze({
  HELD_LOCAL: { label: "Retida localmente", tone: "neutral" },
  PENDING_SEND: { label: "Aguardando envio", tone: "info" },
  SENT: { label: "Enviada", tone: "info" },
  REJECTED: { label: "Rejeitada", tone: "danger" },
  PENDING_RECONCILIATION: { label: "Resultado incerto", tone: "warning" },
  CONFIRMED: { label: "Confirmada", tone: "success" },
  MANUAL_REVIEW: { label: "Revisão necessária", tone: "danger" },
});

const KIND_LABELS = Object.freeze({
  USED_STOCK_ENTRY: "Entrada de veículo usado",
});

const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CREATED: "Operação criada",
  DISPATCH_BEGUN: "Envio ao RENAVE iniciado",
  HELD_LOCAL_CREATED: "Operação protegida localmente",
  REGULATORY_AUTHORIZATION_REVALIDATED:
    "Autorização regulatória validada antes do envio",
  RENAVE_CONFIRMED: "Operação confirmada pelo RENAVE",
  RENAVE_MUTATION_OUTCOME_UNKNOWN:
    "Envio terminou sem confirmação do resultado",
  RENAVE_REJECTED: "Operação recusada pelo RENAVE",
  RENAVE_RECONCILIATION_AMBIGUOUS: "Verificação encontrou dados ambíguos",
  RENAVE_RECONCILIATION_CONFIRMED: "Registro confirmado pela verificação",
  RENAVE_RECONCILIATION_UNRECOVERABLE:
    "Verificação automática não pôde continuar",
  RENAVE_RECONCILIATION_WINDOW_EXPIRED:
    "Janela segura de verificação encerrada",
  SEND_LEASE_EXPIRED: "Envio anterior terminou sem confirmação",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function displayDateTime(value: string): string {
  return DATE_FORMATTER.format(new Date(value));
}

function reasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return "Atualização operacional";
  return REASON_LABELS[reasonCode] ?? "Atualização operacional registrada";
}

function shortReference(value: string): string {
  return value.slice(0, 8).toUpperCase();
}

export function PendingOperationDetailPage({
  onBack,
  onLoad,
  operationId,
  selectionKey,
}: PendingOperationDetailPageProps) {
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
        const detail = await onLoad(controller.signal);
        if (!controller.signal.aborted && requestVersion.current === version) {
          setState({
            detail,
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
  }, [load, operationId, selectionKey]);

  const presentation =
    state.status === "success"
      ? DETAIL_PRESENTATION[state.detail.operation.status]
      : undefined;

  return (
    <section
      className="pending-operation-detail"
      aria-busy={
        state.status === "loading" ||
        (state.status === "success" && state.refreshing)
      }
      aria-labelledby="pending-operation-detail-title"
    >
      <nav className="pending-operation-detail__breadcrumb" aria-label="Trilha">
        <Button
          variant="quiet"
          leadingIcon={<ArrowLeft size={18} />}
          onClick={onBack}
        >
          Voltar às pendências
        </Button>
        <span aria-hidden="true">/</span>
        <span>Operação {shortReference(operationId)}</span>
      </nav>

      {state.status === "loading" ? (
        <div>
          <h2 id="pending-operation-detail-title" className="sr-only">
            Detalhe da operação
          </h2>
          <p role="status">Carregando detalhe da operação…</p>
        </div>
      ) : null}

      {state.status === "error" ? (
        <Card
          className="pending-operation-detail__feedback"
          title="Operação indisponível"
          description="Não foi possível consultar este registro. Nenhum dado anterior foi alterado."
          role="alert"
          actions={
            <Button variant="secondary" onClick={() => void load(false)}>
              Tentar novamente
            </Button>
          }
        />
      ) : null}

      {state.status === "success" && presentation ? (
        <article className="pending-operation-detail__content">
          <header className="pending-operation-detail__hero">
            <div>
              <p>{KIND_LABELS[state.detail.operation.kind]}</p>
              <h2 id="pending-operation-detail-title">
                Operação {shortReference(state.detail.operation.operationId)}
              </h2>
              <p>{presentation.description}</p>
            </div>
            <div className="pending-operation-detail__hero-actions">
              <StatusBadge tone={presentation.tone}>
                {presentation.label}
              </StatusBadge>
              <Button
                variant="secondary"
                leadingIcon={<RefreshCw size={18} />}
                loading={state.refreshing}
                loadingLabel="Atualizando operação…"
                onClick={() => void load(true)}
              >
                Atualizar operação
              </Button>
            </div>
          </header>

          {state.refreshError ? (
            <p className="pending-operation-detail__refresh-error" role="alert">
              Não foi possível atualizar agora. O detalhe anterior foi
              preservado.
            </p>
          ) : null}

          {state.detail.operation.status === "PENDING_RECONCILIATION" ||
          state.detail.operation.status === "MANUAL_REVIEW" ? (
            <div className="pending-operation-detail__notice" role="note">
              <ShieldAlert size={20} aria-hidden="true" />
              <p>
                <strong>Reenvio bloqueado.</strong> Não repita esta operação
                enquanto o estado nacional não estiver confirmado.
              </p>
            </div>
          ) : null}

          <div className="pending-operation-detail__grid">
            <Card
              as="section"
              className="pending-operation-detail__trace"
              title="Rastreabilidade"
              headingLevel={3}
            >
              <dl>
                <div>
                  <dt>Referência local</dt>
                  <dd>{shortReference(state.detail.operation.operationId)}</dd>
                </div>
                <div>
                  <dt>Correlação</dt>
                  <dd>
                    {shortReference(state.detail.operation.correlationId)}
                  </dd>
                </div>
                <div>
                  <dt>Criada em</dt>
                  <dd>
                    <time dateTime={state.detail.operation.createdAt}>
                      {displayDateTime(state.detail.operation.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Última atualização</dt>
                  <dd>
                    <time dateTime={state.detail.operation.updatedAt}>
                      {displayDateTime(state.detail.operation.updatedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
            </Card>

            <Card
              as="section"
              className="pending-operation-detail__timeline-card"
              title="Linha do tempo"
              description="Eventos persistidos da operação, em ordem cronológica."
              headingLevel={3}
            >
              <ol className="pending-operation-detail__timeline">
                {state.detail.timeline.map((item) => {
                  const status = STATUS_PRESENTATION[item.status];
                  return (
                    <li key={item.version}>
                      <span
                        className="pending-operation-detail__timeline-marker"
                        aria-hidden="true"
                      />
                      <div>
                        <StatusBadge tone={status.tone}>
                          {status.label}
                        </StatusBadge>
                        <h4>{reasonLabel(item.reasonCode)}</h4>
                        <time dateTime={item.changedAt}>
                          {displayDateTime(item.changedAt)}
                        </time>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </div>
        </article>
      ) : null}
    </section>
  );
}
