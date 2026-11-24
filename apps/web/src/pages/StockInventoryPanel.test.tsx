import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StockInventoryPanel } from "./StockInventoryPanel.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("StockInventoryPanel", () => {
  it("carrega automaticamente e mostra somente os campos públicos reais", async () => {
    const onLoad = vi.fn(async () => [
      {
        chassi: "9BWZZZ377VT004251",
        dataHoraRegistroEntrada: "2026-11-24T10:30",
        estado: "CONFIRMADO" as const,
        id: 71,
        placa: "ABC1D23",
        renavam: "00607701676",
        tipoCrv: "DIGITAL" as const,
      },
    ]);

    render(
      <StockInventoryPanel onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );

    expect(onLoad).toHaveBeenCalledOnce();
    const table = await screen.findByRole("table", {
      name: /estoques do estabelecimento/i,
    });
    expect(within(table).getByText("ABC1D23")).toBeVisible();
    expect(within(table).getByText("Registro #71")).toBeVisible();
    expect(within(table).getByText("9BWZZZ377VT004251")).toBeVisible();
    expect(within(table).getByText("00607701676")).toBeVisible();
    expect(within(table).getByText("DIGITAL")).toBeVisible();
    expect(within(table).getByText("24/11/2026 10:30")).toBeVisible();
    expect(
      within(table).getByText("Horário informado pelo SERPRO"),
    ).toBeVisible();
    expect(within(table).getByText("Em estoque")).toBeVisible();
    expect(table.textContent).not.toMatch(/cpf|segurança|número do crv/iu);
  });

  it("formata a data sem depender do fuso do ambiente", async () => {
    const dateParse = vi.spyOn(Date, "parse");
    render(
      <StockInventoryPanel
        onLoad={vi.fn(async () => [
          {
            dataHoraRegistroEntrada: "2026-11-24T10:30:45-03:00",
            estado: "SOLICITADO" as const,
            id: 72,
            placa: "QTP4H82",
          },
        ])}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(await screen.findByText("24/11/2026 10:30:45 -03:00")).toBeVisible();
    expect(dateParse).not.toHaveBeenCalled();
    dateParse.mockRestore();
  });

  it("descarta uma resposta atrasada quando o estabelecimento muda", async () => {
    const first =
      deferred<
        readonly { estado: "CONFIRMADO"; id: number; placa: string }[]
      >();
    const second =
      deferred<
        readonly { estado: "TRANSFERIDO"; id: number; placa: string }[]
      >();
    const onLoad = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = render(
      <StockInventoryPanel onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );

    view.rerender(
      <StockInventoryPanel onLoad={onLoad} selectionKey="tenant-a:store-b" />,
    );
    expect(onLoad.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(onLoad.mock.calls[0]?.[0].aborted).toBe(true);
    expect(onLoad.mock.calls[1]?.[0].aborted).toBe(false);
    first.resolve([{ estado: "CONFIRMADO", id: 71, placa: "ABC1D23" }]);
    second.resolve([{ estado: "TRANSFERIDO", id: 88, placa: "QTP4H82" }]);

    expect(await screen.findByText("QTP4H82")).toBeVisible();
    expect(screen.queryByText("ABC1D23")).toBeNull();
  });

  it("sanitiza falhas e permite tentar novamente", async () => {
    const onLoad = vi
      .fn()
      .mockRejectedValueOnce(new Error("CPF 12345678901"))
      .mockResolvedValueOnce([]);
    render(
      <StockInventoryPanel onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/não foi possível consultar o estoque/i);
    expect(alert).not.toHaveTextContent("12345678901");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Tentar novamente" }),
    );

    expect(
      await screen.findByText(/nenhum estoque recente foi informado/i),
    ).toBeVisible();
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
  });

  it("oferece atualização explícita sem habilitar ações de estoque", async () => {
    const onLoad = vi.fn(async () => [
      { estado: "FINALIZADO" as const, id: 90, placa: "BRA2E19" },
    ]);
    render(
      <StockInventoryPanel onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );

    await screen.findByText("BRA2E19");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar estoque" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("link", { name: /abrir|saída|transferir/i }),
    ).toBeNull();
  });
});
