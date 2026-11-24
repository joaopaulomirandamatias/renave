import { Button } from "@seu-renave/ui";
import { Clock3, RefreshCw, ShieldCheck } from "lucide-react";

import type {
  BrowserCredentialLinkQueueItem,
  BrowserRenaveLinkStatus,
} from "../App.js";

export interface CredenciaLinkQueuePanelProps {
  error?: boolean;
  items?: readonly BrowserCredentialLinkQueueItem[];
  loading?: boolean;
  onReload?: () => void;
  truncated?: boolean;
}

const statusLabels: Record<BrowserRenaveLinkStatus, string> = {
  confirmed: "Identidade confirmada",
  deactivated: "Desativado",
  enabled: "Habilitado localmente",
  not_started: "Não iniciado",
  pending: "Pendente de verificação",
  rejected: "Rejeitado",
};

function formatLocalUpdate(value: string | undefined): string {
  if (!value) return "Sem verificação local registrada";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export function CredenciaLinkQueuePanel({
  error = false,
  items = [],
  loading = false,
  onReload,
  truncated = false,
}: CredenciaLinkQueuePanelProps) {
  const pendingCount = items.filter(
    (item) => item.renaveLink.status === "pending",
  ).length;

  return (
    <section
      className="credencia-queue"
      aria-labelledby="credencia-queue-title"
      aria-busy={loading}
    >
      <header className="credencia-queue__heading">
        <div>
          <p>Administração da organização</p>
          <h2 id="credencia-queue-title">Fila de vínculos Credencia</h2>
        </div>
        <ShieldCheck size={22} aria-hidden="true" />
      </header>

      <p className="credencia-queue__notice">
        Esta lista mostra o último estado registrado pela plataforma. O
        Credencia continua sendo a fonte oficial; nenhuma confirmação, rejeição
        ou habilitação é feita nesta tela.
      </p>

      <div
        className="credencia-queue__summary"
        aria-atomic="true"
        aria-live="polite"
      >
        <strong>{pendingCount}</strong>
        <span>
          {pendingCount === 1 ? "vínculo pendente" : "vínculos pendentes"}
        </span>
        {onReload ? (
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw size={18} />}
            loading={loading}
            loadingLabel="Atualizando lista…"
            onClick={onReload}
          >
            Atualizar lista
          </Button>
        ) : null}
      </div>

      {truncated ? (
        <p className="credencia-queue__feedback" role="status">
          A lista mostra os 500 vínculos prioritários, dos mais antigos para os
          mais recentes. Há outros vínculos ativos além desta página.
        </p>
      ) : null}

      {error ? (
        <p className="credencia-queue__feedback" role="alert">
          Não foi possível carregar a fila. Nenhum estado foi presumido.
        </p>
      ) : loading && items.length === 0 ? (
        <p className="credencia-queue__feedback" role="status">
          Carregando vínculos da organização…
        </p>
      ) : items.length === 0 ? (
        <p className="credencia-queue__feedback">
          Nenhum estabelecimento ativo está disponível nesta fila.
        </p>
      ) : (
        <ul className="credencia-queue__items">
          {items.map((item) => (
            <li
              key={item.establishment.id}
              data-status={item.renaveLink.status}
            >
              <div>
                <h3>{item.establishment.tradeName}</h3>
                <p>
                  <Clock3 size={16} aria-hidden="true" />
                  {item.renaveLink.updatedAt ? (
                    <time dateTime={item.renaveLink.updatedAt}>
                      Última atualização local:{" "}
                      {formatLocalUpdate(item.renaveLink.updatedAt)}
                    </time>
                  ) : (
                    formatLocalUpdate(undefined)
                  )}
                </p>
              </div>
              <strong>{statusLabels[item.renaveLink.status]}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
