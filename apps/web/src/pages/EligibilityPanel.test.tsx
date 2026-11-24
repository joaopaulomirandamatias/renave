import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserEligibilitySummary } from "../App.js";
import { EligibilityPanel } from "./EligibilityPanel.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("EligibilityPanel", () => {
  it("normaliza placa, envia o tipo do CRV e comunica loading", async () => {
    const pending = deferred<BrowserEligibilitySummary>();
    const onCheck = vi.fn(() => pending.promise);
    render(
      <EligibilityPanel onCheck={onCheck} selectionKey="tenant-a:store-a" />,
    );

    const plate = screen.getByRole("textbox", { name: "Placa do veículo" });
    fireEvent.change(plate, { target: { value: "abc-1d23" } });
    expect(plate).toHaveValue("ABC1D23");
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));

    expect(onCheck).toHaveBeenCalledWith("ABC1D23", "DIGITAL");
    expect(
      screen.getByRole("region", { name: "Consultar aptidão do veículo" }),
    ).toHaveAttribute("aria-busy", "true");
    pending.resolve({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });
    expect(await screen.findByText("Veículo apto")).toBeVisible();
  });

  it.each(["AZUL", "VERDE", "BRANCO", "DIGITAL"] as const)(
    "envia o tipo de CRV %s selecionado",
    async (crvType) => {
      const onCheck = vi.fn(async () => ({
        detranUnavailable: false,
        impediments: [],
        status: "eligible" as const,
      }));
      render(
        <EligibilityPanel onCheck={onCheck} selectionKey="tenant-a:store-a" />,
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Placa do veículo" }),
        { target: { value: "ABC1D23" } },
      );
      fireEvent.change(screen.getByRole("combobox", { name: "Tipo do CRV" }), {
        target: { value: crvType },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Consultar aptidão" }),
      );

      await waitFor(() =>
        expect(onCheck).toHaveBeenCalledWith("ABC1D23", crvType),
      );
    },
  );

  it("traduz somente códigos públicos e explica indisponibilidade do DETRAN", async () => {
    render(
      <EligibilityPanel
        onCheck={vi.fn(async () => ({
          detranUnavailable: true,
          impediments: [
            "UNSPECIFIED_INELIGIBILITY",
            "THEFT_OR_ROBBERY",
            "PGFN_RESTRICTION",
          ] as const,
          status: "undetermined" as const,
        }))}
        selectionKey="tenant-a:store-a"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));

    expect(await screen.findByText("Aptidão não determinada")).toBeVisible();
    expect(screen.getByText(/comunicação com o DETRAN/i)).toBeVisible();
    const list = screen.getByRole("list", { name: "Impedimentos encontrados" });
    expect(list).toHaveTextContent("Registro de roubo ou furto");
    expect(list).toHaveTextContent("Restrição na PGFN");
    expect(list).toHaveTextContent("Motivo de não aptidão não detalhado");
    expect(list.textContent).not.toMatch(/renavam|chassi|boleto|valor|cpf/iu);
  });

  it("traduz erro fechado sem revelar detalhes recebidos", async () => {
    const error = Object.assign(new Error("RENAVAM 12345678901"), {
      code: "RENAVE_PROTOCOL_ERROR",
    });
    render(
      <EligibilityPanel
        onCheck={vi.fn(async () => Promise.reject(error))}
        selectionKey="tenant-a:store-a"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/não respondeu de forma compatível/i);
    expect(alert).not.toHaveTextContent("12345678901");
  });

  it("descarta resposta atrasada e limpa ao trocar estabelecimento", async () => {
    const pending = deferred<BrowserEligibilitySummary>();
    const onCheck = vi.fn(() => pending.promise);
    const view = render(
      <EligibilityPanel onCheck={onCheck} selectionKey="tenant-a:store-a" />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));

    view.rerender(
      <EligibilityPanel onCheck={onCheck} selectionKey="tenant-a:store-b" />,
    );
    expect(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
    ).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Tipo do CRV" })).toHaveValue(
      "DIGITAL",
    );
    pending.resolve({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });
    await waitFor(() => expect(screen.queryByText("Veículo apto")).toBeNull());
  });

  it("descarta resposta pendente ao editar a placa", async () => {
    const pending = deferred<BrowserEligibilitySummary>();
    render(
      <EligibilityPanel
        onCheck={vi.fn(() => pending.promise)}
        selectionKey="tenant-a:store-a"
      />,
    );
    const plate = screen.getByRole("textbox", { name: "Placa do veículo" });
    fireEvent.change(plate, { target: { value: "ABC1D23" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));
    fireEvent.change(plate, { target: { value: "DEF4G56" } });
    pending.resolve({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });

    await waitFor(() => expect(screen.queryByText("Veículo apto")).toBeNull());
    expect(plate).toHaveValue("DEF4G56");
  });

  it("descarta resposta pendente ao editar o tipo do CRV", async () => {
    const pending = deferred<BrowserEligibilitySummary>();
    render(
      <EligibilityPanel
        onCheck={vi.fn(() => pending.promise)}
        selectionKey="tenant-a:store-a"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar aptidão" }));
    const crvType = screen.getByRole("combobox", { name: "Tipo do CRV" });
    fireEvent.change(crvType, { target: { value: "AZUL" } });
    pending.resolve({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });

    await waitFor(() => expect(screen.queryByText("Veículo apto")).toBeNull());
    expect(crvType).toHaveValue("AZUL");
  });
});
