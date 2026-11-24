import { Button } from "@seu-renave/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { BrowserCrvType } from "../../App.js";
import type { ReadonlyCanaryPort } from "./port.js";
import {
  canaryStages,
  runHomologationCanary,
  type CanaryStage,
  type CanaryStageStatus,
  type HomologationCanaryResult,
} from "./runner.js";

export interface HomologationCanaryPanelProps {
  port: ReadonlyCanaryPort;
  selectionKey: string;
}

type StageState = Readonly<Record<CanaryStage, CanaryStageStatus>>;

const stageLabels: Readonly<Record<CanaryStage, string>> = Object.freeze({
  confirmed_readiness: "Prontidão após o vínculo",
  eligibility: "Consulta de aptidão",
  initial_readiness: "Prontidão local",
  preflight: "Identidade e vínculo",
  stocks: "Consulta de estoque",
  vehicle: "Consulta do veículo",
});

const statusLabels: Readonly<Record<CanaryStageStatus, string>> = Object.freeze(
  {
    blocked: "Inconclusivo",
    failed: "Falhou",
    passed: "Concluído",
    pending: "Aguardando",
    running: "Em andamento",
  },
);

function initialStages(): StageState {
  return Object.fromEntries(
    canaryStages.map((stage) => [stage, "pending"]),
  ) as StageState;
}

function resultMessage(result: HomologationCanaryResult): string {
  if (result.status === "completed") {
    return "Ensaio concluído. Nenhuma mutação foi enviada ao SERPRO; o preflight e as consultas responderam conforme o contrato.";
  }
  if (result.status === "inconclusive") {
    return "Ensaio inconclusivo. A sequência foi interrompida com segurança e nenhuma repetição foi feita.";
  }
  if (result.code === "CANARY_ABORTED") {
    return "Ensaio cancelado porque o contexto mudou. Respostas atrasadas foram descartadas.";
  }
  return "Ensaio não concluído. A sequência foi interrompida no primeiro erro, sem repetição automática.";
}

export function HomologationCanaryPanel({
  port,
  selectionKey,
}: HomologationCanaryPanelProps) {
  const [plate, setPlate] = useState("");
  const [crvType, setCrvType] = useState<BrowserCrvType>("DIGITAL");
  const [confirmed, setConfirmed] = useState(false);
  const [stages, setStages] = useState<StageState>(initialStages);
  const [result, setResult] = useState<HomologationCanaryResult>();
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const previousSelectionKey = useRef(selectionKey);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previousSelectionKey.current !== selectionKey) {
      previousSelectionKey.current = selectionKey;
      generation.current += 1;
      controller.current?.abort();
      controller.current = undefined;
      setPlate("");
      setCrvType("DIGITAL");
      setConfirmed(false);
      setStages(initialStages());
      setResult(undefined);
      setRunning(false);
    }
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [selectionKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      started.current ||
      !confirmed ||
      !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(plate)
    ) {
      return;
    }
    started.current = true;
    const currentGeneration = ++generation.current;
    const currentController = new AbortController();
    controller.current = currentController;
    const input = { crvType, plate };
    setPlate("");
    setConfirmed(false);
    setStages(initialStages());
    setResult(undefined);
    setRunning(true);

    const outcome = await runHomologationCanary(
      input,
      port,
      currentController.signal,
      ({ stage, status }) => {
        if (generation.current !== currentGeneration) return;
        setStages((current) => ({ ...current, [stage]: status }));
      },
    );
    if (generation.current !== currentGeneration) return;
    controller.current = undefined;
    setResult(outcome);
    setRunning(false);
    summary.current?.focus();
  }

  const canStart =
    !started.current &&
    confirmed &&
    /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(plate);

  return (
    <section
      className="homologation-canary"
      aria-busy={running}
      aria-labelledby="homologation-canary-title"
    >
      <header>
        <p>Verificação guiada sem mutação no SERPRO</p>
        <h2 id="homologation-canary-title">Ensaio de homologação RENAVE</h2>
      </header>
      <p>
        A sequência verifica prontidão, vínculo e consultas. Nenhuma mutação é
        enviada ao SERPRO. O preflight registra evidência e auditoria e pode
        confirmar ou rejeitar o vínculo local. Execute apenas com uma placa
        sintética aprovada para homologação.
      </p>

      <form onSubmit={(event) => void submit(event)} noValidate>
        <fieldset disabled={running || started.current}>
          <legend>Fixture do ensaio</legend>
          <label htmlFor="homologation-canary-plate">Placa sintética</label>
          <input
            id="homologation-canary-plate"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={7}
            pattern="[A-Z]{3}[0-9][A-Z0-9][0-9]{2}"
            spellCheck={false}
            value={plate}
            onChange={(event) => {
              setPlate(
                event.currentTarget.value
                  .toUpperCase()
                  .replaceAll(/[^A-Z0-9]/gu, "")
                  .slice(0, 7),
              );
              setResult(undefined);
              setStages(initialStages());
            }}
          />

          <label htmlFor="homologation-canary-crv-type">Tipo do CRV</label>
          <select
            id="homologation-canary-crv-type"
            value={crvType}
            onChange={(event) =>
              setCrvType(event.currentTarget.value as BrowserCrvType)
            }
          >
            <option value="AZUL">CRV azul</option>
            <option value="VERDE">CRV verde</option>
            <option value="BRANCO">CRV branco</option>
            <option value="DIGITAL">CRV digital</option>
          </select>

          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            Estou ciente de que nenhuma mutação é enviada ao SERPRO e de que o
            preflight registra evidência e auditoria e pode atualizar o vínculo
            local.
          </label>
        </fieldset>

        <Button
          type="submit"
          disabled={!canStart}
          loading={running}
          loadingLabel="Executando ensaio…"
        >
          Executar uma vez
        </Button>
      </form>

      <ol aria-label="Etapas do ensaio">
        {canaryStages.map((stage) => (
          <li key={stage}>
            <span>{stageLabels[stage]}</span>
            <strong>{statusLabels[stages[stage]]}</strong>
          </li>
        ))}
      </ol>

      <div
        ref={summary}
        className="homologation-canary__summary"
        aria-live="polite"
        role={result?.status === "failed" ? "alert" : "status"}
        tabIndex={-1}
      >
        {running ? "Executando uma única sequência, sem repetição…" : null}
        {result ? resultMessage(result) : null}
      </div>
    </section>
  );
}
