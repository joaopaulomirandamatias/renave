import { Button, StockStateBadge } from "@seu-renave/ui";
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { BrowserStockSummary } from "../App.js";

export interface StockSearchPanelProps {
  onSearch: (plate: string) => Promise<readonly BrowserStockSummary[]>;
  selectionKey: string;
}

type SearchState =
  | { status: "idle" | "loading" }
  | { code?: string; status: "error" }
  | { result: readonly BrowserStockSummary[]; status: "success" };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(code: string | undefined): string {
  if (code === "RENAVE_QUERY_LIMITED") {
    return "Há outra consulta em andamento. Aguarde um instante e tente novamente.";
  }
  if (code === "RENAVE_LINK_NOT_READY") {
    return "O vínculo do estabelecimento precisa ser confirmado novamente.";
  }
  if (code === "RENAVE_HTTP_ERROR" || code === "RENAVE_PROTOCOL_ERROR") {
    return "O RENAVE não respondeu de forma compatível. Tente novamente mais tarde.";
  }
  return "Não foi possível consultar o estoque. Nenhum dado anterior foi alterado.";
}

export function StockSearchPanel({
  onSearch,
  selectionKey,
}: StockSearchPanelProps) {
  const [plate, setPlate] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const requestVersion = useRef(0);
  const loading = state.status === "loading";

  useEffect(() => {
    requestVersion.current += 1;
    setPlate("");
    setState({ status: "idle" });
    return () => {
      requestVersion.current += 1;
    };
  }, [selectionKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[A-Z0-9]{7}$/u.test(plate) || loading) return;
    const version = ++requestVersion.current;
    setState({ status: "loading" });
    try {
      const result = await onSearch(plate);
      if (requestVersion.current === version) {
        setState({ result, status: "success" });
      }
    } catch (error) {
      if (requestVersion.current === version) {
        const code = errorCode(error);
        setState({
          ...(code === undefined ? {} : { code }),
          status: "error",
        });
      }
    }
  }

  return (
    <section
      className="stock-search"
      aria-busy={loading}
      aria-labelledby="stock-search-title"
    >
      <div className="stock-search__heading">
        <div>
          <p>Consulta somente leitura</p>
          <h2 id="stock-search-title">Localizar estoque por placa</h2>
        </div>
        <span>Homologação RENAVE</span>
      </div>

      <form
        className="stock-search__form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="stock-search__field">
          <label htmlFor="stock-search-plate">Placa do veículo</label>
          <input
            id="stock-search-plate"
            aria-describedby="stock-search-help"
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            maxLength={7}
            pattern="[A-Z0-9]{7}"
            placeholder="ABC1D23"
            spellCheck={false}
            value={plate}
            onChange={(event) => {
              setPlate(
                event.currentTarget.value
                  .toUpperCase()
                  .replaceAll(/[^A-Z0-9]/gu, "")
                  .slice(0, 7),
              );
              setState({ status: "idle" });
            }}
          />
          <p id="stock-search-help">Informe os sete caracteres, sem hífen.</p>
        </div>
        <Button
          variant="primary"
          leadingIcon={<Search size={18} />}
          loading={loading}
          loadingLabel="Consultando estoque…"
          disabled={!/^[A-Z0-9]{7}$/u.test(plate)}
          type="submit"
        >
          Consultar estoque
        </Button>
      </form>

      <div className="stock-search__result" aria-live="polite">
        {state.status === "idle" ? (
          <p>O resultado aparecerá aqui sem habilitar nenhuma operação.</p>
        ) : null}
        {state.status === "loading" ? <p role="status">Consultando…</p> : null}
        {state.status === "error" ? (
          <p role="alert">{errorMessage(state.code)}</p>
        ) : null}
        {state.status === "success" && state.result.length === 0 ? (
          <p role="status">Nenhum estoque foi encontrado para esta placa.</p>
        ) : null}
        {state.status === "success" && state.result.length > 0 ? (
          <ul aria-label="Estoques encontrados">
            {state.result.map((stock) => (
              <li key={stock.id}>
                <div>
                  <strong>{stock.placa}</strong>
                  <span>Registro #{stock.id}</span>
                </div>
                <StockStateBadge state={stock.estado} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
