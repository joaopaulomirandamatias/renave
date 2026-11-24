import type { BrowserCrvType, BrowserRenaveReadiness } from "../../App.js";
import type { ReadonlyCanaryPort } from "./port.js";

export const canaryStages = [
  "initial_readiness",
  "preflight",
  "confirmed_readiness",
  "eligibility",
  "stocks",
  "vehicle",
] as const;

export type CanaryStage = (typeof canaryStages)[number];
export type CanaryStageStatus =
  "pending" | "running" | "passed" | "blocked" | "failed";

export interface CanaryStageUpdate {
  stage: CanaryStage;
  status: CanaryStageStatus;
}

export interface HomologationCanaryInput {
  crvType: BrowserCrvType;
  plate: string;
}

export type HomologationCanaryResult =
  | { status: "completed" }
  | {
      code:
        | "INITIAL_READINESS_BLOCKED"
        | "LINK_NOT_READY"
        | "STOCK_NOT_UNIQUE_CONFIRMED";
      stage: CanaryStage;
      status: "inconclusive";
    }
  | {
      code: "CANARY_ABORTED" | "CANARY_STAGE_FAILED";
      stage: CanaryStage;
      status: "failed";
    };

export type CanaryStageReporter = (update: CanaryStageUpdate) => void;

function initialReadinessAccepted(value: BrowserRenaveReadiness): boolean {
  return (
    value.environment === "homologation" &&
    value.integration === "configured" &&
    (value.certificate === "ready" || value.certificate === "warning") &&
    value.mutations === "blocked"
  );
}

function confirmedReadinessAccepted(value: BrowserRenaveReadiness): boolean {
  return (
    initialReadinessAccepted(value) &&
    (value.link === "confirmed" || value.link === "enabled") &&
    value.queries === "ready" &&
    value.operatorIdentity === "verified" &&
    value.establishmentContact === "verified"
  );
}

function aborted(signal: AbortSignal, error: unknown): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/**
 * Executa uma única sequência serial, sem repetição nem espera. O orquestrador
 * não persiste os DTOs recebidos; o preflight executado pela porta registra
 * evidência/auditoria e pode atualizar o vínculo local. Nenhuma etapa envia
 * mutação ao SERPRO.
 */
export async function runHomologationCanary(
  input: HomologationCanaryInput,
  port: ReadonlyCanaryPort,
  signal: AbortSignal,
  report: CanaryStageReporter = () => undefined,
): Promise<HomologationCanaryResult> {
  let stage: CanaryStage = "initial_readiness";
  const execute = async <T>(
    current: CanaryStage,
    operation: () => Promise<T>,
  ): Promise<T> => {
    stage = current;
    signal.throwIfAborted();
    report({ stage: current, status: "running" });
    const result = await operation();
    signal.throwIfAborted();
    report({ stage: current, status: "passed" });
    return result;
  };

  try {
    const initial = await execute("initial_readiness", () =>
      port.loadReadiness(signal),
    );
    if (!initialReadinessAccepted(initial)) {
      report({ stage: "initial_readiness", status: "blocked" });
      return {
        code: "INITIAL_READINESS_BLOCKED",
        stage: "initial_readiness",
        status: "inconclusive",
      };
    }

    await execute("preflight", () => port.runPreflight(signal));

    const confirmed = await execute("confirmed_readiness", () =>
      port.loadReadiness(signal),
    );
    if (!confirmedReadinessAccepted(confirmed)) {
      report({ stage: "confirmed_readiness", status: "blocked" });
      return {
        code: "LINK_NOT_READY",
        stage: "confirmed_readiness",
        status: "inconclusive",
      };
    }

    await execute("eligibility", () =>
      port.checkEligibility(input.plate, input.crvType, signal),
    );

    const stocks = await execute("stocks", () =>
      port.searchStocks(input.plate, signal),
    );
    if (
      stocks.length !== 1 ||
      stocks[0]?.estado !== "CONFIRMADO" ||
      stocks[0].placa !== input.plate
    ) {
      report({ stage: "stocks", status: "blocked" });
      return {
        code: "STOCK_NOT_UNIQUE_CONFIRMED",
        stage: "stocks",
        status: "inconclusive",
      };
    }

    const vehicle = await execute("vehicle", () =>
      port.lookupVehicle(input.plate, signal),
    );
    if (vehicle.placa !== input.plate) {
      report({ stage: "vehicle", status: "failed" });
      return {
        code: "CANARY_STAGE_FAILED",
        stage: "vehicle",
        status: "failed",
      };
    }
    return { status: "completed" };
  } catch (error) {
    report({ stage, status: "failed" });
    return {
      code: aborted(signal, error) ? "CANARY_ABORTED" : "CANARY_STAGE_FAILED",
      stage,
      status: "failed",
    };
  }
}
