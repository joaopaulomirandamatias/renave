import { Button, StatusBadge, type StatusBadgeTone } from "@seu-renave/ui";
import { ArrowLeft, ArrowUpFromLine, RefreshCw } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type StockDetailState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface StockDetailMovement {
  dataHora?: string;
  dataHoraRegistro?: string;
  motivo?: string;
}

export interface StockDetailRestriction {
  codigoTipo?: string;
  tipo?: string;
}

export interface StockDetail {
  cancelamento?: StockDetailMovement;
  chassi?: string;
  dataHoraMedicaoHodometro?: string;
  entrada?: StockDetailMovement;
  estado: StockDetailState;
  id: number;
  placa: string;
  quilometragemHodometro?: number;
  renavam?: string;
  restricoes: readonly StockDetailRestriction[];
  saida?: StockDetailMovement;
  tipoCrv?: "AZUL" | "VERDE" | "BRANCO" | "DIGITAL";
}

export interface StockDetailPageProps {
  onBack: () => void;
  onLoad: (stockId: number, signal: AbortSignal) => Promise<StockDetail>;
  onStartStockExit?: (detail: { id: number; placa: string }) => void;
  selectionKey: string;
  stockId: number;
}

type ViewState =
  | { status: "loading" }
  | { status: "error" }
  | { detail: StockDetail; status: "success" };

type StockDetailTab = "overview" | "restrictions" | "movements";

const TAB_ORDER: readonly StockDetailTab[] = [
  "overview",
  "restrictions",
  "movements",
];

const STATE_PRESENTATION: Readonly<
  Record<StockDetailState, { label: string; tone: StatusBadgeTone }>
> = Object.freeze({
  SOLICITADO: { label: "Entrada solicitada", tone: "info" },
  TRANSFERIDO: { label: "Propriedade transferida", tone: "warning" },
  CONFIRMADO: { label: "Em estoque", tone: "success" },
  FINALIZADO: { label: "Baixado", tone: "neutral" },
});

const SERPRO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/u;

function displayDateTime(value: string): string {
  const match = SERPRO_DATE_TIME.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, offset] = match;
  return `${day}/${month}/${year} ${hour}:${minute}${second ? `:${second}` : ""}${offset ? ` ${offset}` : ""}`;
}

function maskedIdentifier(
  value: string | undefined,
  visibleStart: number,
  visibleEnd: number,
): string {
  if (!value) return "Não informado";
  if (value.length <= visibleStart + visibleEnd) {
    const visible = Math.min(
      visibleEnd,
      Math.max(1, Math.floor(value.length / 2)),
    );
    return `••••${value.slice(-visible)}`;
  }
  return `${value.slice(0, visibleStart)}••••${value.slice(-visibleEnd)}`;
}

function DateValue({ value }: { value: string | undefined }) {
  if (!value) return <>Não informado</>;
  return (
    <span className="stock-detail__date">
      <time dateTime={value}>{displayDateTime(value)}</time>
      <small>Horário informado pelo SERPRO</small>
    </span>
  );
}

export function StockDetailPage({
  onBack,
  onLoad,
  onStartStockExit,
  selectionKey,
  stockId,
}: StockDetailPageProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<StockDetailTab>("overview");
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);
  const tabRefs = useRef<Record<StockDetailTab, HTMLButtonElement | null>>({
    movements: null,
    overview: null,
    restrictions: null,
  });

  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    setState({ status: "loading" });
    try {
      const detail = await onLoad(stockId, controller.signal);
      if (!controller.signal.aborted && requestVersion.current === version) {
        setState({ detail, status: "success" });
      }
    } catch {
      if (!controller.signal.aborted && requestVersion.current === version) {
        setState({ status: "error" });
      }
    }
  }, [onLoad, stockId]);

  useEffect(() => {
    setActiveTab("overview");
    void load();
    return () => {
      activeRequest.current?.abort();
      requestVersion.current += 1;
    };
  }, [load, selectionKey]);

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: StockDetailTab,
  ) {
    const currentIndex = TAB_ORDER.indexOf(currentTab);
    let nextTab: StockDetailTab | undefined;
    if (event.key === "ArrowRight") {
      nextTab = TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length];
    } else if (event.key === "ArrowLeft") {
      nextTab =
        TAB_ORDER[(currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    } else if (event.key === "Home") {
      nextTab = TAB_ORDER[0];
    } else if (event.key === "End") {
      nextTab = TAB_ORDER[TAB_ORDER.length - 1];
    }
    if (!nextTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  const loading = state.status === "loading";

  return (
    <section
      className="stock-detail"
      aria-busy={loading}
      aria-labelledby="stock-detail-title"
    >
      <nav className="stock-detail__breadcrumb" aria-label="Trilha">
        <Button
          variant="quiet"
          leadingIcon={<ArrowLeft size={18} />}
          onClick={onBack}
        >
          Voltar ao estoque
        </Button>
        <span aria-hidden="true">/</span>
        <span>Registro #{stockId}</span>
      </nav>

      {loading ? (
        <div>
          <h2 id="stock-detail-title" className="sr-only">
            Ficha do estoque
          </h2>
          <p role="status">Carregando ficha do estoque…</p>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="stock-detail__feedback" role="alert">
          <div>
            <h2 id="stock-detail-title">Ficha indisponível</h2>
            <p>
              Não foi possível consultar este registro. Nenhum dado anterior foi
              alterado.
            </p>
          </div>
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw size={18} />}
            onClick={() => void load()}
          >
            Tentar novamente
          </Button>
        </div>
      ) : null}

      {state.status === "success" ? (
        <article className="stock-detail__content">
          <header className="stock-detail__hero">
            <div className="stock-detail__hero-copy">
              <p>Registro do veículo no RENAVE</p>
              <div className="stock-detail__identity-line">
                <span className="stock-detail__plate">
                  {state.detail.placa}
                </span>
                {state.detail.cancelamento ? (
                  <StatusBadge tone="danger">Registro cancelado</StatusBadge>
                ) : (
                  <StatusBadge
                    tone={STATE_PRESENTATION[state.detail.estado].tone}
                  >
                    {STATE_PRESENTATION[state.detail.estado].label}
                  </StatusBadge>
                )}
              </div>
              <h2 id="stock-detail-title">Ficha do estoque</h2>
              <p className="stock-detail__record">
                Registro #{state.detail.id}
              </p>
            </div>
            <div className="stock-detail__hero-actions">
              {state.detail.estado === "CONFIRMADO" &&
              !state.detail.cancelamento &&
              onStartStockExit ? (
                <Button
                  variant="primary"
                  leadingIcon={<ArrowUpFromLine size={18} />}
                  onClick={() =>
                    onStartStockExit({
                      id: state.detail.id,
                      placa: state.detail.placa,
                    })
                  }
                >
                  Registrar saída
                </Button>
              ) : null}
              <Button
                variant="secondary"
                leadingIcon={<RefreshCw size={18} />}
                onClick={() => void load()}
              >
                Atualizar ficha
              </Button>
            </div>
          </header>

          <div
            className="stock-detail__tabs"
            role="tablist"
            aria-label="Seções do veículo"
          >
            <button
              ref={(node) => {
                tabRefs.current.overview = node;
              }}
              id="stock-detail-tab-overview"
              type="button"
              role="tab"
              aria-selected={activeTab === "overview"}
              aria-controls="stock-detail-panel-overview"
              tabIndex={activeTab === "overview" ? 0 : -1}
              className="stock-detail__tab"
              onClick={() => setActiveTab("overview")}
              onKeyDown={(event) => handleTabKeyDown(event, "overview")}
            >
              Visão geral
            </button>
            <button
              ref={(node) => {
                tabRefs.current.restrictions = node;
              }}
              id="stock-detail-tab-restrictions"
              type="button"
              role="tab"
              aria-selected={activeTab === "restrictions"}
              aria-controls="stock-detail-panel-restrictions"
              tabIndex={activeTab === "restrictions" ? 0 : -1}
              className="stock-detail__tab"
              onClick={() => setActiveTab("restrictions")}
              onKeyDown={(event) => handleTabKeyDown(event, "restrictions")}
            >
              Restrições ({state.detail.restricoes.length})
            </button>
            <button
              ref={(node) => {
                tabRefs.current.movements = node;
              }}
              id="stock-detail-tab-movements"
              type="button"
              role="tab"
              aria-selected={activeTab === "movements"}
              aria-controls="stock-detail-panel-movements"
              tabIndex={activeTab === "movements" ? 0 : -1}
              className="stock-detail__tab"
              onClick={() => setActiveTab("movements")}
              onKeyDown={(event) => handleTabKeyDown(event, "movements")}
            >
              Movimentações
            </button>
          </div>

          {activeTab === "overview" ? (
            <div
              id="stock-detail-panel-overview"
              role="tabpanel"
              aria-labelledby="stock-detail-tab-overview"
              className="stock-detail__panel"
            >
              {state.detail.cancelamento ? (
                <section
                  className="stock-detail__cancellation"
                  aria-labelledby="stock-detail-cancellation-title"
                >
                  <h3 id="stock-detail-cancellation-title">
                    Registro cancelado no RENAVE
                  </h3>
                  <dl>
                    <div>
                      <dt>Data do cancelamento</dt>
                      <dd>
                        <DateValue value={state.detail.cancelamento.dataHora} />
                      </dd>
                    </div>
                    <div>
                      <dt>Motivo</dt>
                      <dd>
                        {state.detail.cancelamento.motivo ?? "Não informado"}
                      </dd>
                    </div>
                  </dl>
                </section>
              ) : null}

              <div className="stock-detail__grid">
                <section
                  className="stock-detail__card"
                  aria-labelledby="stock-detail-identification-title"
                >
                  <h3 id="stock-detail-identification-title">Identificação</h3>
                  <dl>
                    <div>
                      <dt>Chassi</dt>
                      <dd className="stock-detail__identifier">
                        {maskedIdentifier(state.detail.chassi, 8, 2)}
                      </dd>
                    </div>
                    <div>
                      <dt>RENAVAM</dt>
                      <dd className="stock-detail__identifier">
                        {maskedIdentifier(state.detail.renavam, 3, 4)}
                      </dd>
                    </div>
                    <div>
                      <dt>Tipo do CRV</dt>
                      <dd>{state.detail.tipoCrv ?? "Não informado"}</dd>
                    </div>
                    <div>
                      <dt>Hodômetro</dt>
                      <dd>
                        {state.detail.quilometragemHodometro === undefined
                          ? "Não informado"
                          : `${state.detail.quilometragemHodometro.toLocaleString(
                              "pt-BR",
                            )} km`}
                      </dd>
                    </div>
                    <div>
                      <dt>Data da medição</dt>
                      <dd>
                        <DateValue
                          value={state.detail.dataHoraMedicaoHodometro}
                        />
                      </dd>
                    </div>
                  </dl>
                </section>

                <section
                  className="stock-detail__card"
                  aria-labelledby="stock-detail-summary-movement-title"
                >
                  <h3 id="stock-detail-summary-movement-title">
                    Resumo da movimentação
                  </h3>
                  <dl>
                    <div>
                      <dt>Entrada informada</dt>
                      <dd>
                        <DateValue value={state.detail.entrada?.dataHora} />
                      </dd>
                    </div>
                    <div>
                      <dt>Registro sistêmico da entrada</dt>
                      <dd>
                        <DateValue
                          value={state.detail.entrada?.dataHoraRegistro}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Saída informada</dt>
                      <dd>
                        <DateValue value={state.detail.saida?.dataHora} />
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </div>
          ) : null}

          {activeTab === "restrictions" ? (
            <div
              id="stock-detail-panel-restrictions"
              role="tabpanel"
              aria-labelledby="stock-detail-tab-restrictions"
              className="stock-detail__panel"
            >
              <section
                className="stock-detail__card stock-detail__restrictions"
                aria-labelledby="stock-detail-restrictions-title"
              >
                <h3 id="stock-detail-restrictions-title">Restrições</h3>
                {state.detail.restricoes.length === 0 ? (
                  <p>Nenhuma restrição informada pelo RENAVE.</p>
                ) : (
                  <ul>
                    {state.detail.restricoes.map((restriction, index) => (
                      <li
                        key={`${restriction.codigoTipo ?? "restricao"}-${index}`}
                      >
                        <strong>
                          {restriction.tipo ?? "Restrição sem descrição"}
                        </strong>
                        <span>
                          Código {restriction.codigoTipo ?? "não informado"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}

          {activeTab === "movements" ? (
            <div
              id="stock-detail-panel-movements"
              role="tabpanel"
              aria-labelledby="stock-detail-tab-movements"
              className="stock-detail__panel"
            >
              {state.detail.cancelamento ? (
                <section
                  className="stock-detail__cancellation"
                  aria-labelledby="stock-detail-movements-cancellation-title"
                >
                  <h3 id="stock-detail-movements-cancellation-title">
                    Registro cancelado no RENAVE
                  </h3>
                  <dl>
                    <div>
                      <dt>Data do cancelamento</dt>
                      <dd>
                        <DateValue value={state.detail.cancelamento.dataHora} />
                      </dd>
                    </div>
                    <div>
                      <dt>Motivo</dt>
                      <dd>
                        {state.detail.cancelamento.motivo ?? "Não informado"}
                      </dd>
                    </div>
                  </dl>
                </section>
              ) : null}

              <section
                className="stock-detail__card"
                aria-labelledby="stock-detail-movement-title"
              >
                <h3 id="stock-detail-movement-title">Movimentação</h3>
                <dl>
                  <div>
                    <dt>Entrada informada</dt>
                    <dd>
                      <DateValue value={state.detail.entrada?.dataHora} />
                    </dd>
                  </div>
                  <div>
                    <dt>Registro sistêmico da entrada</dt>
                    <dd>
                      <DateValue
                        value={state.detail.entrada?.dataHoraRegistro}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Saída informada</dt>
                    <dd>
                      <DateValue value={state.detail.saida?.dataHora} />
                    </dd>
                  </div>
                  <div>
                    <dt>Registro sistêmico da saída</dt>
                    <dd>
                      <DateValue value={state.detail.saida?.dataHoraRegistro} />
                    </dd>
                  </div>
                  <div>
                    <dt>Motivo da saída</dt>
                    <dd>{state.detail.saida?.motivo ?? "Não informado"}</dd>
                  </div>
                </dl>
              </section>
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
