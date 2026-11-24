import { type AppEnvironment, BrandLogo, Button } from "@seu-renave/ui";
import { ChevronDown, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  PLATFORM_CONSOLE_PATH,
  PLATFORM_REASON_TICKET_PATTERN,
  PlatformConsoleClientError,
  type PlatformConsoleClient,
  type PlatformQueueItem,
  type PlatformRenaveLinkStatus,
} from "./client.js";

export interface PlatformConsolePageProps {
  client: PlatformConsoleClient;
  environment: AppEnvironment;
  logoutError?: boolean;
  logoutPending?: boolean;
  onLogout: () => void | Promise<void>;
  userDisplayName: string;
}

type QueueView =
  | { status: "idle" | "loading" }
  | { error: PlatformConsoleClientError; status: "error" }
  | {
      items: readonly PlatformQueueItem[];
      loadingMore: boolean;
      nextCursor?: string;
      paginationError?: PlatformConsoleClientError;
      status: "ready";
    };

const statusLabels: Record<PlatformRenaveLinkStatus, string> = {
  not_started: "Não iniciado",
  pending: "Pendente",
  confirmed: "Confirmado",
  enabled: "Habilitado",
  deactivated: "Desativado",
  rejected: "Rejeitado",
};

const environmentLabels: Record<AppEnvironment, string> = {
  development: "Desenvolvimento",
  homologation: "Homologação",
  production: "Produção",
};

function errorContent(error: PlatformConsoleClientError): {
  description: string;
  title: string;
} {
  if (error.status === 401) {
    return {
      description: "Entre novamente para confirmar sua identidade corporativa.",
      title: "Sua sessão expirou",
    };
  }
  if (error.status === 403) {
    const mfa =
      error.code === "MFA_REQUIRED" || error.code === "MFA_RECENT_REQUIRED";
    return mfa
      ? {
          description:
            "O provedor corporativo precisa confirmar um MFA recente antes desta consulta.",
          title: "Confirmação adicional necessária",
        }
      : {
          description:
            "Sua identidade não possui uma concessão global ativa para esta consulta.",
          title: "Acesso global não autorizado",
        };
  }
  if (error.status === 404) {
    return {
      description:
        "A funcionalidade está desativada neste ambiente. Nenhum dado global foi consultado.",
      title: "Console global indisponível",
    };
  }
  if (error.status === 429) {
    return {
      description: error.retryAfterSeconds
        ? `Aguarde ${error.retryAfterSeconds} segundo${error.retryAfterSeconds === 1 ? "" : "s"} antes de tentar novamente.`
        : "Aguarde alguns instantes antes de tentar novamente.",
      title: "Limite temporário atingido",
    };
  }
  if (error.status === 503) {
    return {
      description:
        "O leitor global falhou de forma segura. Tente novamente mais tarde.",
      title: "Serviço temporariamente indisponível",
    };
  }
  if (error.status === 400) {
    return {
      description:
        "O pedido de consulta não foi aceito. Inicie uma nova consulta com um chamado válido.",
      title: "Consulta inválida",
    };
  }
  return {
    description:
      "A resposta não pôde ser validada. Nenhum conteúdo parcial foi exibido.",
    title: "Não foi possível carregar a fila",
  };
}

function mergeItems(
  current: readonly PlatformQueueItem[],
  incoming: readonly PlatformQueueItem[],
): readonly PlatformQueueItem[] {
  const merged = new Map(
    current.map((item) => [`${item.tenant.id}:${item.establishment.id}`, item]),
  );
  for (const item of incoming) {
    merged.set(`${item.tenant.id}:${item.establishment.id}`, item);
  }
  return [...merged.values()];
}

export function PlatformConsolePage({
  client,
  environment,
  logoutError = false,
  logoutPending = false,
  onLogout,
  userDisplayName,
}: PlatformConsolePageProps) {
  const [reasonTicket, setReasonTicket] = useState("");
  const [ticketInvalid, setTicketInvalid] = useState(false);
  const [view, setView] = useState<QueueView>({ status: "idle" });
  const requestVersion = useRef(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const activeReasonTicket = useRef<string | undefined>(undefined);
  const requestPending = useRef(false);

  useEffect(
    () => () => {
      requestVersion.current += 1;
      requestController.current?.abort();
      activeReasonTicket.current = undefined;
      requestPending.current = false;
    },
    [],
  );

  async function loadPage(reason: string, cursor?: string) {
    if (requestPending.current) return;
    requestPending.current = true;
    const version = ++requestVersion.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (cursor) {
      setView((current) =>
        current.status === "ready"
          ? {
              items: current.items,
              loadingMore: true,
              ...(current.nextCursor ? { nextCursor: current.nextCursor } : {}),
              status: "ready",
            }
          : { status: "loading" },
      );
    } else {
      setView({ status: "loading" });
    }
    try {
      const page = await client.loadQueue({
        ...(cursor ? { cursor } : {}),
        reasonTicket: reason,
        signal: controller.signal,
      });
      if (requestVersion.current !== version) return;
      setView((current) => ({
        items:
          cursor && current.status === "ready"
            ? mergeItems(current.items, page.items)
            : page.items,
        loadingMore: false,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        status: "ready",
      }));
    } catch (error) {
      if (
        requestVersion.current !== version ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      const normalized =
        error instanceof PlatformConsoleClientError
          ? error
          : new PlatformConsoleClientError(0, "UNEXPECTED_ERROR");
      const retryablePaginationFailure =
        normalized.status === 0 ||
        normalized.status === 429 ||
        normalized.status === 503;
      setView((current) =>
        cursor && current.status === "ready" && retryablePaginationFailure
          ? {
              ...current,
              loadingMore: false,
              paginationError: normalized,
            }
          : { error: normalized, status: "error" },
      );
    } finally {
      if (requestVersion.current === version) requestPending.current = false;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = reasonTicket.trim();
    if (!PLATFORM_REASON_TICKET_PATTERN.test(normalized)) {
      setTicketInvalid(true);
      return;
    }
    setTicketInvalid(false);
    setReasonTicket("");
    activeReasonTicket.current = normalized;
    void loadPage(normalized);
  }

  function newQuery() {
    requestVersion.current += 1;
    requestController.current?.abort();
    requestPending.current = false;
    activeReasonTicket.current = undefined;
    setReasonTicket("");
    setTicketInvalid(false);
    setView({ status: "idle" });
  }

  const error = view.status === "error" ? errorContent(view.error) : undefined;
  const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(PLATFORM_CONSOLE_PATH)}`;

  return (
    <div className="platform-console">
      <a className="platform-console__skip" href="#platform-console-content">
        Ir para o conteúdo principal
      </a>
      <header className="platform-console__header">
        <div className="platform-console__brand">
          <BrandLogo compact />
          <span>Operação global auditada</span>
        </div>
        <div className="platform-console__session">
          <span
            className="platform-console__environment"
            data-environment={environment}
          >
            Ambiente: {environmentLabels[environment]}
          </span>
          <span className="platform-console__operator">
            <bdi>{userDisplayName}</bdi>
          </span>
          <Button
            variant="quiet"
            leadingIcon={<LogOut size={18} />}
            loading={logoutPending}
            loadingLabel="Saindo..."
            onClick={onLogout}
          >
            Sair
          </Button>
        </div>
      </header>

      <main id="platform-console-content" tabIndex={-1}>
        <header className="platform-console__heading">
          <div>
            <p>Privilégio global · somente leitura</p>
            <h1>Fila nacional de vínculos RENAVE</h1>
          </div>
          <span className="platform-console__readonly">
            <ShieldCheck size={18} aria-hidden="true" />
            Consulta auditada
          </span>
        </header>

        <section
          className="platform-console__notice"
          aria-labelledby="platform-console-notice-title"
        >
          <h2 id="platform-console-notice-title">Acesso excepcional</h2>
          <p>
            Informe o chamado que autoriza esta consulta. O identificador é
            enviado somente para auditoria e não aparece na URL nem nos
            resultados.
          </p>
        </section>

        {logoutError ? (
          <p className="platform-console__feedback" role="alert">
            Não foi possível encerrar a sessão. Você continua conectado.
          </p>
        ) : null}

        {view.status === "idle" ? (
          <form className="platform-console__form" onSubmit={submit}>
            <div>
              <label htmlFor="platform-reason-ticket">
                Chamado ou autorização da consulta
              </label>
              <p id="platform-reason-ticket-help">
                Use de 3 a 128 caracteres: letras, números, ponto, hífen, barra,
                dois-pontos ou sublinhado.
              </p>
            </div>
            <div className="platform-console__form-controls">
              <input
                id="platform-reason-ticket"
                aria-describedby={
                  ticketInvalid
                    ? "platform-reason-ticket-help platform-reason-ticket-error"
                    : "platform-reason-ticket-help"
                }
                aria-invalid={ticketInvalid || undefined}
                autoComplete="off"
                maxLength={128}
                minLength={3}
                pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}"
                required
                spellCheck={false}
                value={reasonTicket}
                onChange={(event) => {
                  setReasonTicket(event.currentTarget.value);
                  setTicketInvalid(false);
                }}
              />
              <Button type="submit">Consultar fila</Button>
            </div>
            {ticketInvalid ? (
              <p id="platform-reason-ticket-error" role="alert">
                Informe um chamado válido para continuar.
              </p>
            ) : null}
          </form>
        ) : null}

        {view.status === "loading" ? (
          <section className="platform-console__state" aria-busy="true">
            <RefreshCw
              className="platform-console__spinner"
              aria-hidden="true"
            />
            <p role="status">Carregando a fila global com segurança…</p>
          </section>
        ) : null}

        {view.status === "error" && error ? (
          <section
            className="platform-console__state platform-console__state--error"
            aria-labelledby="platform-console-error-title"
            role="alert"
          >
            <h2 id="platform-console-error-title">{error.title}</h2>
            <p>{error.description}</p>
            <div className="platform-console__actions">
              {(view.error.status === 401 ||
                view.error.code === "MFA_REQUIRED" ||
                view.error.code === "MFA_RECENT_REQUIRED") && (
                <Button href={loginHref}>Confirmar acesso seguro</Button>
              )}
              {activeReasonTicket.current &&
              view.error.status !== 400 &&
              view.error.status !== 403 &&
              view.error.status !== 404 ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void loadPage(activeReasonTicket.current as string)
                  }
                >
                  Tentar novamente
                </Button>
              ) : null}
              <Button variant="quiet" onClick={newQuery}>
                Nova consulta
              </Button>
            </div>
          </section>
        ) : null}

        {view.status === "ready" ? (
          <section
            className="platform-console__results"
            aria-labelledby="platform-console-results-title"
          >
            <header>
              <div>
                <p>Resultado sanitizado</p>
                <h2 id="platform-console-results-title">
                  {view.items.length === 0
                    ? "Nenhum vínculo encontrado"
                    : `${view.items.length} vínculo${view.items.length === 1 ? "" : "s"} carregado${view.items.length === 1 ? "" : "s"}`}
                </h2>
              </div>
              <Button variant="quiet" onClick={newQuery}>
                Encerrar consulta
              </Button>
            </header>

            {view.items.length === 0 ? (
              <p className="platform-console__empty" role="status">
                Não há estabelecimentos nesta consulta.
              </p>
            ) : (
              <ul className="platform-console__list">
                {view.items.map((item) => (
                  <li key={`${item.tenant.id}:${item.establishment.id}`}>
                    <article>
                      <div>
                        <p className="platform-console__tenant">
                          <bdi>{item.tenant.displayName}</bdi>
                        </p>
                        <h3>
                          <bdi>{item.establishment.tradeName}</bdi>
                        </h3>
                      </div>
                      <dl>
                        <div>
                          <dt>Situação</dt>
                          <dd>{statusLabels[item.renaveLink.status]}</dd>
                        </div>
                        <div>
                          <dt>Atualizado em</dt>
                          <dd>
                            <time dateTime={item.renaveLink.updatedAt}>
                              {new Intl.DateTimeFormat("pt-BR", {
                                dateStyle: "short",
                                timeStyle: "short",
                              }).format(new Date(item.renaveLink.updatedAt))}
                            </time>
                          </dd>
                        </div>
                      </dl>
                    </article>
                  </li>
                ))}
              </ul>
            )}

            {view.paginationError ? (
              <p className="platform-console__pagination-error" role="alert">
                Não foi possível carregar mais vínculos. A lista já exibida foi
                preservada. {errorContent(view.paginationError).description}
              </p>
            ) : null}

            {view.nextCursor ? (
              <div className="platform-console__pagination">
                <Button
                  variant="secondary"
                  leadingIcon={<ChevronDown size={18} />}
                  loading={view.loadingMore}
                  loadingLabel="Carregando mais..."
                  onClick={() => {
                    const reason = activeReasonTicket.current;
                    if (reason) void loadPage(reason, view.nextCursor);
                  }}
                >
                  Carregar mais
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
