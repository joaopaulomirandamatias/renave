import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserEligibilitySummary,
  BrowserRenaveReadiness,
  BrowserStockSummary,
} from "../../App.js";
import type { ReadonlyCanaryPort } from "./port.js";
import { HomologationCanaryPanel } from "./HomologationCanaryPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makePort(
  overrides: Partial<ReadonlyCanaryPort> = {},
): ReadonlyCanaryPort {
  let readinessCall = 0;
  return {
    checkEligibility: vi.fn(async (): Promise<BrowserEligibilitySummary> => ({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    })),
    loadReadiness: vi.fn(async (): Promise<BrowserRenaveReadiness> => {
      readinessCall += 1;
      return {
        certificate: "ready",
        environment: "homologation",
        establishmentContact: readinessCall === 1 ? "pending" : "verified",
        integration: "configured",
        link: readinessCall === 1 ? "pending" : "confirmed",
        mutations: "blocked",
        operatorIdentity: readinessCall === 1 ? "pending" : "verified",
        queries: readinessCall === 1 ? "blocked" : "ready",
      };
    }),
    lookupVehicle: vi.fn(async () => ({ placa: "ABC1D23", restricoes: [] })),
    runPreflight: vi.fn(async () => undefined),
    searchStocks: vi.fn(async (): Promise<readonly BrowserStockSummary[]> => [
      { estado: "CONFIRMADO", id: 41, placa: "ABC1D23" },
    ]),
    ...overrides,
  };
}

function prepareAndSubmit() {
  fireEvent.change(screen.getByLabelText("Placa sintética"), {
    target: { value: "abc-1d23" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /estou ciente de que nenhuma mutação é enviada ao serpro.*preflight registra evidência e auditoria.*atualizar o vínculo local/i,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Executar uma vez" }));
}

describe("HomologationCanaryPanel", () => {
  it("exige confirmação explícita e executa somente uma vez com entrada normalizada", async () => {
    const port = makePort();
    render(
      <HomologationCanaryPanel port={port} selectionKey="tenant-a/store-a" />,
    );

    const button = screen.getByRole("button", { name: "Executar uma vez" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Placa sintética"), {
      target: { value: "abc-1d23" },
    });
    expect(screen.getByLabelText("Placa sintética")).toHaveValue("ABC1D23");
    expect(button).toBeDisabled();

    prepareAndSubmit();
    fireEvent.click(button);

    expect(
      await screen.findByText(
        /ensaio concluído.*nenhuma mutação foi enviada ao serpro/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /preflight registra evidência e auditoria.*confirmar ou rejeitar o vínculo local/i,
      ),
    ).toBeVisible();
    expect(port.loadReadiness).toHaveBeenCalledTimes(2);
    expect(port.runPreflight).toHaveBeenCalledOnce();
    expect(port.checkEligibility).toHaveBeenCalledWith(
      "ABC1D23",
      "DIGITAL",
      expect.any(AbortSignal),
    );
    expect(port.searchStocks).toHaveBeenCalledOnce();
    expect(port.lookupVehicle).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Placa sintética")).toHaveValue("");
    expect(button).toBeDisabled();
  });

  it("anuncia o resultado terminal e move o foco para o resumo", async () => {
    render(
      <HomologationCanaryPanel
        port={makePort()}
        selectionKey="tenant-a/store-a"
      />,
    );
    prepareAndSubmit();

    const summary = await screen.findByRole("status");
    await waitFor(() => expect(summary).toHaveFocus());
    expect(summary).toHaveAttribute("aria-live", "polite");
    expect(screen.getAllByText("Concluído")).toHaveLength(6);
  });

  it("aborta no contexto trocado, descarta resposta atrasada e limpa a fixture", async () => {
    let resolvePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => {
      resolvePreflight = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const port = makePort({
      runPreflight: vi.fn(async (signal) => {
        capturedSignal = signal;
        await preflight;
      }),
    });
    const view = render(
      <HomologationCanaryPanel port={port} selectionKey="tenant-a/store-a" />,
    );
    prepareAndSubmit();
    await waitFor(() => expect(port.runPreflight).toHaveBeenCalledOnce());

    view.rerender(
      <HomologationCanaryPanel port={port} selectionKey="tenant-a/store-b" />,
    );
    expect(capturedSignal?.aborted).toBe(true);
    expect(screen.getByLabelText("Placa sintética")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Executar uma vez" }),
    ).toBeDisabled();
    resolvePreflight();

    await waitFor(() => {
      expect(
        screen.queryByText(/ensaio (concluído|cancelado|não concluído)/i),
      ).toBeNull();
      expect(screen.getAllByText("Aguardando")).toHaveLength(6);
    });
    expect(port.checkEligibility).not.toHaveBeenCalled();
  });

  it("não expõe resposta ou erro sensível nem escreve em console, histórico ou storage", async () => {
    const secret = "SENTINELA-CPF-12345678900-CERTIFICADO-PRIVADO";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const historyWrite = vi.spyOn(history, "pushState");
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const port = makePort({
      checkEligibility: vi.fn(async () => Promise.reject(new Error(secret))),
    });
    render(
      <HomologationCanaryPanel port={port} selectionKey="tenant-a/store-a" />,
    );
    prepareAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /interrompida no primeiro erro, sem repetição automática/i,
    );
    expect(document.body.textContent).not.toContain(secret);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
    expect(port.checkEligibility).toHaveBeenCalledOnce();
    expect(port.searchStocks).not.toHaveBeenCalled();
  });
});
