import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StockSearchPanel } from "./StockSearchPanel.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("StockSearchPanel", () => {
  it("normaliza a placa e comunica loading acessivelmente", async () => {
    const pending = deferred<readonly []>();
    const onSearch = vi.fn(() => pending.promise);
    render(
      <StockSearchPanel onSearch={onSearch} selectionKey="tenant-a:store-a" />,
    );

    const input = screen.getByRole("textbox", { name: "Placa do veículo" });
    fireEvent.change(input, { target: { value: "abc-1d23" } });
    expect(input).toHaveValue("ABC1D23");
    fireEvent.click(screen.getByRole("button", { name: "Consultar estoque" }));

    expect(onSearch).toHaveBeenCalledWith("ABC1D23");
    expect(
      screen.getByRole("region", { name: "Localizar estoque por placa" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Consultando estoque…" }),
    ).toBeDisabled();
    pending.resolve([]);
    expect(
      await screen.findByText(/nenhum estoque foi encontrado/i),
    ).toBeVisible();
  });

  it("mostra somente a projeção pública e o estado com texto", async () => {
    const onSearch = vi.fn(async () => [
      { estado: "CONFIRMADO" as const, id: 71, placa: "ABC1D23" },
    ]);
    render(
      <StockSearchPanel onSearch={onSearch} selectionKey="tenant-a:store-a" />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      {
        target: { value: "ABC1D23" },
      },
    );
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Consultar estoque" })
        .closest("form")!,
    );

    const list = await screen.findByRole("list", {
      name: "Estoques encontrados",
    });
    expect(list).toHaveTextContent("ABC1D23");
    expect(list).toHaveTextContent("Registro #71");
    expect(list).toHaveTextContent("Em estoque");
    expect(list.textContent).not.toMatch(
      /cpf|renavam|chassi|crv|nfe|cancelamento|segurança/iu,
    );
  });

  it("traduz erro fechado sem exibir detalhes recebidos", async () => {
    const error = Object.assign(new Error("CPF 12345678901"), {
      code: "RENAVE_HTTP_ERROR",
    });
    render(
      <StockSearchPanel
        onSearch={vi.fn(async () => Promise.reject(error))}
        selectionKey="tenant-a:store-a"
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      {
        target: { value: "ABC1D23" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar estoque" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/não respondeu de forma compatível/i);
    expect(alert).not.toHaveTextContent("12345678901");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Consultar estoque" }),
      ).toBeEnabled(),
    );
  });

  it("descarta resposta atrasada e limpa o painel ao trocar a seleção", async () => {
    const pending =
      deferred<
        readonly { estado: "CONFIRMADO"; id: number; placa: string }[]
      >();
    const onSearch = vi.fn(() => pending.promise);
    const view = render(
      <StockSearchPanel onSearch={onSearch} selectionKey="tenant-a:store-a" />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      {
        target: { value: "ABC1D23" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar estoque" }));

    view.rerender(
      <StockSearchPanel onSearch={onSearch} selectionKey="tenant-a:store-b" />,
    );
    expect(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
    ).toHaveValue("");
    pending.resolve([{ estado: "CONFIRMADO", id: 71, placa: "ABC1D23" }]);
    await waitFor(() => expect(screen.queryByText("Registro #71")).toBeNull());
  });

  it("oferece consulta do veículo somente para estoque confirmado", async () => {
    const onLookupVehicle = vi.fn(async () => ({
      chassi: "9BWZZZ377VT004251",
      placa: "ABC1D23",
      restricoes: [],
      veiculoAcabado: true,
    }));
    render(
      <StockSearchPanel
        onLookupVehicle={onLookupVehicle}
        onSearch={vi.fn(async () => [
          { estado: "CONFIRMADO" as const, id: 71, placa: "ABC1D23" },
          { estado: "SOLICITADO" as const, id: 72, placa: "ABC1D23" },
        ])}
        selectionKey="tenant-a:store-a"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar estoque" }));

    const lookup = await screen.findByRole("button", {
      name: "Consultar veículo",
    });
    expect(
      screen.getAllByRole("button", { name: "Consultar veículo" }),
    ).toHaveLength(1);
    fireEvent.click(lookup);
    expect(await screen.findByText("9BWZZZ377VT004251")).toBeVisible();
    expect(onLookupVehicle).toHaveBeenCalledWith("ABC1D23");
    expect(screen.getByText(/nenhuma operação foi habilitada/i)).toBeVisible();
  });

  it("descarta veículo atrasado quando o contexto muda", async () => {
    const stock = vi.fn(async () => [
      { estado: "CONFIRMADO" as const, id: 71, placa: "ABC1D23" },
    ]);
    const pending = deferred<{
      placa: string;
      restricoes: readonly [];
      renavam: string;
    }>();
    const view = render(
      <StockSearchPanel
        onLookupVehicle={vi.fn(() => pending.promise)}
        onSearch={stock}
        selectionKey="tenant-a:store-a"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Placa do veículo" }),
      { target: { value: "ABC1D23" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Consultar estoque" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Consultar veículo" }),
    );

    view.rerender(
      <StockSearchPanel
        onLookupVehicle={vi.fn(() => pending.promise)}
        onSearch={stock}
        selectionKey="tenant-a:store-b"
      />,
    );
    pending.resolve({
      placa: "ABC1D23",
      renavam: "00607701676",
      restricoes: [],
    });
    await waitFor(() => expect(screen.queryByText("00607701676")).toBeNull());
  });
});
