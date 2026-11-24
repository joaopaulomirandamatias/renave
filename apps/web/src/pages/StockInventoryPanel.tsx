import { Button, StatusBadge, type StatusBadgeTone } from "@seu-renave/ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type StockInventoryState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface StockInventoryItem {
  chassi?: string;
  dataHoraRegistroEntrada?: string;
  estado: StockInventoryState;
  id: number;
  placa: string;
  renavam?: string;
  tipoCrv?: "AZUL" | "VERDE" | "BRANCO" | "DIGITAL";
}

export interface StockInventoryPanelProps {
  onLoad: (signal: AbortSignal) => Promise<readonly StockInventoryItem[]>;
  selectionKey: string;
}

type InventoryState =
  | { status: "loading" }
  | { status: "error" }
  | { items: readonly StockInventoryItem[]; status: "success" };

const STATE_PRESENTATION: Readonly<
  Record<StockInventoryState, { label: string; tone: StatusBadgeTone }>
> = Object.freeze({
  SOLICITADO: { label: "Entrada solicitada", tone: "info" },
  TRANSFERIDO: { label: "Propriedade transferida", tone: "warning" },
  CONFIRMADO: { label: "Em estoque", tone: "success" },
  FINALIZADO: { label: "Baixado", tone: "neutral" },
});

const SERPRO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/u;

function displayRegistrationTime(value: string): string {
  const match = SERPRO_DATE_TIME.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, offset] = match;
  return `${day}/${month}/${year} ${hour}:${minute}${second ? `:${second}` : ""}${offset ? ` ${offset}` : ""}`;
}

export function StockInventoryPanel({
  onLoad,
  selectionKey,
}: StockInventoryPanelProps) {
  const [state, setState] = useState<InventoryState>({ status: "loading" });
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    setState({ status: "loading" });
    try {
      const items = await onLoad(controller.signal);
      if (requestVersion.current === version) {
        setState({ items, status: "success" });
      }
    } catch {
      if (!controller.signal.aborted && requestVersion.current === version) {
        setState({ status: "error" });
      }
    }
  }, [onLoad]);

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
      className="stock-inventory"
      aria-busy={loading}
      aria-labelledby="stock-inventory-title"
    >
      <div className="stock-inventory__heading">
        <div>
          <p>Consulta somente leitura</p>
          <h2 id="stock-inventory-title">Estoque RENAVE recente</h2>
          <p>Registros dos últimos três meses disponibilizados pelo RENAVE.</p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw size={18} />}
          loading={loading}
          loadingLabel="Atualizando estoque…"
          onClick={() => void load()}
        >
          Atualizar estoque
        </Button>
      </div>

      <div className="stock-inventory__content" aria-live="polite">
        {loading ? <p role="status">Carregando estoque recente…</p> : null}
        {state.status === "error" ? (
          <div className="stock-inventory__feedback" role="alert">
            <p>
              Não foi possível consultar o estoque. Nenhum dado anterior foi
              alterado.
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              Tentar novamente
            </Button>
          </div>
        ) : null}
        {state.status === "success" && state.items.length === 0 ? (
          <p role="status">
            Nenhum estoque recente foi informado pelo RENAVE para este
            estabelecimento.
          </p>
        ) : null}
        {state.status === "success" && state.items.length > 0 ? (
          <div className="stock-inventory__table-scroll">
            <table>
              <caption>
                Estoques do estabelecimento informados pelo RENAVE nos últimos
                três meses
              </caption>
              <thead>
                <tr>
                  <th scope="col">Placa</th>
                  <th scope="col">Chassi</th>
                  <th scope="col">RENAVAM</th>
                  <th scope="col">Tipo do CRV</th>
                  <th scope="col">Registro da entrada</th>
                  <th scope="col">Situação RENAVE</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => {
                  const presentation = STATE_PRESENTATION[item.estado];
                  return (
                    <tr key={item.id}>
                      <th scope="row">
                        <span className="stock-inventory__plate">
                          {item.placa}
                        </span>
                        <small>Registro #{item.id}</small>
                      </th>
                      <td className="stock-inventory__identifier">
                        {item.chassi ?? "Não informado"}
                      </td>
                      <td className="stock-inventory__identifier">
                        {item.renavam ?? "Não informado"}
                      </td>
                      <td>{item.tipoCrv ?? "Não informado"}</td>
                      <td>
                        {item.dataHoraRegistroEntrada ? (
                          <span className="stock-inventory__date">
                            <time dateTime={item.dataHoraRegistroEntrada}>
                              {displayRegistrationTime(
                                item.dataHoraRegistroEntrada,
                              )}
                            </time>
                            <small>Horário informado pelo SERPRO</small>
                          </span>
                        ) : (
                          "Não informado"
                        )}
                      </td>
                      <td>
                        <StatusBadge tone={presentation.tone}>
                          {presentation.label}
                        </StatusBadge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
