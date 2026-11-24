import { describe, expect, it, vi } from "vitest";

import type {
  BrowserEligibilitySummary,
  BrowserRenaveReadiness,
  BrowserStockSummary,
  BrowserVehicle,
} from "../../App.js";
import type { ReadonlyCanaryPort } from "./port.js";
import {
  canaryStages,
  runHomologationCanary,
  type CanaryStageUpdate,
} from "./runner.js";

const initialReadiness: BrowserRenaveReadiness = {
  certificate: "warning",
  environment: "homologation",
  establishmentContact: "pending",
  integration: "configured",
  link: "pending",
  mutations: "blocked",
  operatorIdentity: "pending",
  queries: "blocked",
};

const confirmedReadiness: BrowserRenaveReadiness = {
  ...initialReadiness,
  certificate: "ready",
  establishmentContact: "verified",
  link: "confirmed",
  operatorIdentity: "verified",
  queries: "ready",
};

const eligibility: BrowserEligibilitySummary = {
  detranUnavailable: false,
  impediments: [],
  status: "eligible",
};

const confirmedStock: BrowserStockSummary = {
  estado: "CONFIRMADO",
  id: 41,
  placa: "ABC1D23",
};

const vehicle: BrowserVehicle = {
  placa: "ABC1D23",
  restricoes: [],
};

function makePort(overrides: Partial<ReadonlyCanaryPort> = {}) {
  const calls: string[] = [];
  let readinessCall = 0;
  const port: ReadonlyCanaryPort = {
    checkEligibility: vi.fn(async () => {
      calls.push("eligibility");
      return eligibility;
    }),
    loadReadiness: vi.fn(async () => {
      readinessCall += 1;
      calls.push(readinessCall === 1 ? "readiness:initial" : "readiness:final");
      return readinessCall === 1 ? initialReadiness : confirmedReadiness;
    }),
    lookupVehicle: vi.fn(async () => {
      calls.push("vehicle");
      return vehicle;
    }),
    runPreflight: vi.fn(async () => {
      calls.push("preflight");
    }),
    searchStocks: vi.fn(async () => {
      calls.push("stocks");
      return [confirmedStock];
    }),
    ...overrides,
  };
  return { calls, port };
}

describe("runHomologationCanary", () => {
  it("executa uma única sequência serial na ordem fixa", async () => {
    const { calls, port } = makePort();
    const updates: CanaryStageUpdate[] = [];

    await expect(
      runHomologationCanary(
        { crvType: "DIGITAL", plate: "ABC1D23" },
        port,
        new AbortController().signal,
        (update) => updates.push(update),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toEqual([
      "readiness:initial",
      "preflight",
      "readiness:final",
      "eligibility",
      "stocks",
      "vehicle",
    ]);
    expect(updates.filter(({ status }) => status === "running")).toEqual(
      canaryStages.map((stage) => ({ stage, status: "running" })),
    );
    expect(port.loadReadiness).toHaveBeenCalledTimes(2);
    expect(port.runPreflight).toHaveBeenCalledOnce();
    expect(port.checkEligibility).toHaveBeenCalledOnce();
    expect(port.searchStocks).toHaveBeenCalledOnce();
    expect(port.lookupVehicle).toHaveBeenCalledOnce();
  });

  it.each([
    ["environment", { ...initialReadiness, environment: "production" }],
    ["integration", { ...initialReadiness, integration: "disabled" }],
    ["certificate", { ...initialReadiness, certificate: "blocked" }],
  ] as const)(
    "bloqueia no gate inicial quando %s não está pronto",
    async (_, value) => {
      const { calls, port } = makePort({
        loadReadiness: vi.fn(async () => value as BrowserRenaveReadiness),
      });

      await expect(
        runHomologationCanary(
          { crvType: "DIGITAL", plate: "ABC1D23" },
          port,
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        code: "INITIAL_READINESS_BLOCKED",
        stage: "initial_readiness",
        status: "inconclusive",
      });
      expect(calls).toEqual([]);
      expect(port.runPreflight).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["link", { ...confirmedReadiness, link: "pending" }],
    ["queries", { ...confirmedReadiness, queries: "blocked" }],
    ["operator", { ...confirmedReadiness, operatorIdentity: "pending" }],
    [
      "establishment",
      { ...confirmedReadiness, establishmentContact: "missing" },
    ],
  ] as const)(
    "bloqueia após o preflight quando %s não foi confirmado",
    async (_, finalValue) => {
      let call = 0;
      const { port } = makePort({
        loadReadiness: vi.fn(async () =>
          ++call === 1 ? initialReadiness : finalValue,
        ) as ReadonlyCanaryPort["loadReadiness"],
      });

      const result = await runHomologationCanary(
        { crvType: "VERDE", plate: "ABC1D23" },
        port,
        new AbortController().signal,
      );

      expect(result).toEqual({
        code: "LINK_NOT_READY",
        stage: "confirmed_readiness",
        status: "inconclusive",
      });
      expect(port.runPreflight).toHaveBeenCalledOnce();
      expect(port.checkEligibility).not.toHaveBeenCalled();
    },
  );

  it.each(["eligible", "ineligible", "undetermined"] as const)(
    "aceita uma resposta de aptidão válida com status %s",
    async (status) => {
      const { port } = makePort({
        checkEligibility: vi.fn(async () => ({ ...eligibility, status })),
      });

      await expect(
        runHomologationCanary(
          { crvType: "AZUL", plate: "ABC1D23" },
          port,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ status: "completed" });
    },
  );

  it.each([
    ["vazio", []],
    ["não confirmado", [{ ...confirmedStock, estado: "SOLICITADO" }]],
    ["placa divergente", [{ ...confirmedStock, placa: "XYZ9Z99" }]],
    ["dois confirmados", [confirmedStock, { ...confirmedStock, id: 42 }]],
    [
      "confirmado e outro",
      [confirmedStock, { ...confirmedStock, estado: "FINALIZADO", id: 42 }],
    ],
  ] satisfies readonly (readonly [string, readonly BrowserStockSummary[]])[])(
    "não consulta veículo quando o estoque é %s",
    async (_, stocks) => {
      const { port } = makePort({ searchStocks: vi.fn(async () => stocks) });

      await expect(
        runHomologationCanary(
          { crvType: "BRANCO", plate: "ABC1D23" },
          port,
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        code: "STOCK_NOT_UNIQUE_CONFIRMED",
        stage: "stocks",
        status: "inconclusive",
      });
      expect(port.lookupVehicle).not.toHaveBeenCalled();
    },
  );

  it("falha de modo sanitizado quando o veículo diverge", async () => {
    const secret = "SENTINELA-RENAVAM-123456789";
    const { port } = makePort({
      lookupVehicle: vi.fn(async () => ({
        chassi: secret,
        placa: "XYZ9Z99",
        restricoes: [{ tipo: secret }],
      })),
    });

    const result = await runHomologationCanary(
      { crvType: "DIGITAL", plate: "ABC1D23" },
      port,
      new AbortController().signal,
    );

    expect(result).toEqual({
      code: "CANARY_STAGE_FAILED",
      stage: "vehicle",
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["preflight", "eligibility", "stocks", "vehicle"] as const)(
    "para no primeiro erro em %s, sem repetição nem vazamento",
    async (failingStage) => {
      const secret = `SENTINELA-${failingStage}-CPF-00000000000`;
      const { port } = makePort({
        ...(failingStage === "preflight"
          ? {
              runPreflight: vi.fn(async () =>
                Promise.reject(new Error(secret)),
              ),
            }
          : {}),
        ...(failingStage === "eligibility"
          ? {
              checkEligibility: vi.fn(async () =>
                Promise.reject(new Error(secret)),
              ),
            }
          : {}),
        ...(failingStage === "stocks"
          ? {
              searchStocks: vi.fn(async () =>
                Promise.reject(new Error(secret)),
              ),
            }
          : {}),
        ...(failingStage === "vehicle"
          ? {
              lookupVehicle: vi.fn(async () =>
                Promise.reject(new Error(secret)),
              ),
            }
          : {}),
      });

      const result = await runHomologationCanary(
        { crvType: "DIGITAL", plate: "ABC1D23" },
        port,
        new AbortController().signal,
      );

      expect(result).toEqual({
        code: "CANARY_STAGE_FAILED",
        stage: failingStage,
        status: "failed",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(
        port[
          failingStage === "preflight"
            ? "runPreflight"
            : failingStage === "eligibility"
              ? "checkEligibility"
              : failingStage === "stocks"
                ? "searchStocks"
                : "lookupVehicle"
        ],
      ).toHaveBeenCalledOnce();
      if (failingStage !== "vehicle")
        expect(port.lookupVehicle).not.toHaveBeenCalled();
    },
  );

  it("obedece AbortSignal antes de qualquer chamada", async () => {
    const { port } = makePort();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runHomologationCanary(
        { crvType: "DIGITAL", plate: "ABC1D23" },
        port,
        controller.signal,
      ),
    ).resolves.toEqual({
      code: "CANARY_ABORTED",
      stage: "initial_readiness",
      status: "failed",
    });
    for (const method of Object.values(port)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
