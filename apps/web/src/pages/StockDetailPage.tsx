import { Button, StatusBadge, type StatusBadgeTone } from "@seu-renave/ui";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  selectionKey: string;
  stockId: number;
}

type ViewState =
  | { status: "loading" }
  | { status: "error" }
  | { detail: StockDetail; status: "success" };

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
  selectionKey,
  stockId,
}: StockDetailPageProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);

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
    void load();
    return () => {
      activeRequest.current?.abort();
      requestVersion.current += 1;
    };
  }, [load, selectionKey]);

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
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={18} />}
              onClick={() => void load()}
            >
              Atualizar ficha
            </Button>
          </header>

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
                  <dd>{state.detail.cancelamento.motivo ?? "Não informado"}</dd>
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
                    <DateValue value={state.detail.dataHoraMedicaoHodometro} />
                  </dd>
                </div>
              </dl>
            </section>

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
                    <DateValue value={state.detail.entrada?.dataHoraRegistro} />
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
                  <li key={`${restriction.codigoTipo ?? "restricao"}-${index}`}>
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
        </article>
      ) : null}
    </section>
  );
}
