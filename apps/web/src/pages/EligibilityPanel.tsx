import { Button } from "@seu-renave/ui";
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  BrowserCrvType,
  BrowserEligibilityImpediment,
  BrowserEligibilitySummary,
} from "../App.js";

export interface EligibilityPanelProps {
  onCheck: (
    plate: string,
    crvType: BrowserCrvType,
  ) => Promise<BrowserEligibilitySummary>;
  selectionKey: string;
}

type EligibilityState =
  | { status: "idle" | "loading" }
  | { code?: string; status: "error" }
  | { result: BrowserEligibilitySummary; status: "success" };

const impedimentLabels: Record<BrowserEligibilityImpediment, string> = {
  UNSPECIFIED_INELIGIBILITY: "Motivo de não aptidão não detalhado",
  VEHICLE_WRITTEN_OFF: "Veículo baixado",
  VEHICLE_ALARM: "Alarme cadastrado",
  PROVISIONAL_REGISTRATION: "Licenciamento provisório",
  CRV_ISSUANCE_PENDING: "Emissão de CRV pendente",
  RECALL_PENDING: "Recall pendente",
  EXTRAJUDICIAL_RESTRICTION: "Restrição extrajudicial",
  DETRAN_BLOCKING_RESTRICTION: "Restrição impeditiva no DETRAN",
  JUDICIAL_RESTRICTION: "Restrição judicial",
  FEDERAL_REVENUE_RESTRICTION: "Restrição na Receita Federal",
  PGFN_RESTRICTION: "Restrição na PGFN",
  THEFT_OR_ROBBERY: "Registro de roubo ou furto",
  ATPV_MISSING: "ATPV-e indisponível",
  TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT:
    "Autorização de transferência para outro estabelecimento",
  SALE_NOTICE_FOR_DIFFERENT_BUYER: "Comunicação de venda para outro comprador",
  SALE_INTENT_FOR_DIFFERENT_BUYER: "Intenção de venda para outro comprador",
};

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
  return "Não foi possível consultar a aptidão. Nenhuma operação foi iniciada.";
}

function resultTitle(result: BrowserEligibilitySummary): string {
  if (result.status === "eligible") return "Veículo apto";
  if (result.status === "ineligible") return "Veículo não apto";
  return "Aptidão não determinada";
}

function resultDescription(result: BrowserEligibilitySummary): string {
  if (result.detranUnavailable) {
    return "A comunicação com o DETRAN não foi concluída. Tente novamente mais tarde.";
  }
  if (result.status === "eligible") {
    return "A consulta não encontrou impedimentos nas informações disponibilizadas.";
  }
  if (result.status === "ineligible") {
    return "Revise os impedimentos indicados antes de qualquer operação.";
  }
  return "O RENAVE não informou um resultado conclusivo nesta consulta.";
}

export function EligibilityPanel({
  onCheck,
  selectionKey,
}: EligibilityPanelProps) {
  const [plate, setPlate] = useState("");
  const [crvType, setCrvType] = useState<BrowserCrvType>("DIGITAL");
  const [state, setState] = useState<EligibilityState>({ status: "idle" });
  const requestVersion = useRef(0);
  const loading = state.status === "loading";

  useEffect(() => {
    requestVersion.current += 1;
    setPlate("");
    setCrvType("DIGITAL");
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
      const result = await onCheck(plate, crvType);
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
      className="stock-search eligibility-panel"
      aria-busy={loading}
      aria-labelledby="eligibility-title"
    >
      <div className="stock-search__heading">
        <div>
          <p>Consulta somente leitura</p>
          <h2 id="eligibility-title">Consultar aptidão do veículo</h2>
        </div>
        <span>Homologação RENAVE</span>
      </div>

      <form
        className="stock-search__form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="stock-search__field">
          <label htmlFor="eligibility-plate">Placa do veículo</label>
          <input
            id="eligibility-plate"
            aria-describedby="eligibility-plate-help"
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            maxLength={7}
            pattern="[A-Z0-9]{7}"
            placeholder="ABC1D23"
            spellCheck={false}
            value={plate}
            onChange={(event) => {
              requestVersion.current += 1;
              setPlate(
                event.currentTarget.value
                  .toUpperCase()
                  .replaceAll(/[^A-Z0-9]/gu, "")
                  .slice(0, 7),
              );
              setState({ status: "idle" });
            }}
          />
          <p id="eligibility-plate-help">
            Informe os sete caracteres, sem hífen.
          </p>
        </div>
        <div className="stock-search__field">
          <label htmlFor="eligibility-crv-type">Tipo do CRV</label>
          <select
            id="eligibility-crv-type"
            value={crvType}
            onChange={(event) => {
              requestVersion.current += 1;
              setCrvType(event.currentTarget.value as BrowserCrvType);
              setState({ status: "idle" });
            }}
          >
            <option value="AZUL">CRV azul</option>
            <option value="VERDE">CRV verde</option>
            <option value="BRANCO">CRV branco</option>
            <option value="DIGITAL">CRV digital</option>
          </select>
        </div>
        <Button
          variant="primary"
          leadingIcon={<Search size={18} />}
          loading={loading}
          loadingLabel="Consultando aptidão…"
          disabled={!/^[A-Z0-9]{7}$/u.test(plate)}
          type="submit"
        >
          Consultar aptidão
        </Button>
      </form>

      <div className="stock-search__result" aria-live="polite">
        {state.status === "idle" ? (
          <p>O resultado aparecerá aqui sem iniciar nenhuma operação.</p>
        ) : null}
        {state.status === "loading" ? <p role="status">Consultando…</p> : null}
        {state.status === "error" ? (
          <p role="alert">{errorMessage(state.code)}</p>
        ) : null}
        {state.status === "success" ? (
          <div
            className={`eligibility-panel__summary is-${state.result.status}`}
          >
            <strong>{resultTitle(state.result)}</strong>
            <p>{resultDescription(state.result)}</p>
            {state.result.impediments.length > 0 ? (
              <ul aria-label="Impedimentos encontrados">
                {state.result.impediments.map((impediment) => (
                  <li key={impediment}>{impedimentLabels[impediment]}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
