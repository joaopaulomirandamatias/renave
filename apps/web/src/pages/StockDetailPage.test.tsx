import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StockDetailPage, type StockDetail } from "./StockDetailPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function detail(overrides: Partial<StockDetail> = {}): StockDetail {
  return {
    chassi: "9BWZZZ377VT004251",
    dataHoraMedicaoHodometro: "2026-11-24T10:25:30-03:00",
    entrada: {
      dataHora: "2026-11-24T10:30",
      dataHoraRegistro: "2026-11-24T10:31:45Z",
    },
    estado: "CONFIRMADO",
    id: 71,
    placa: "ABC1D23",
    quilometragemHodometro: 38_590,
    renavam: "00607701676",
    restricoes: [{ codigoTipo: "01", tipo: "Administrativa" }],
    tipoCrv: "DIGITAL",
    ...overrides,
  };
}

describe("StockDetailPage", () => {
  it("mostra a ficha somente leitura, mascara identificadores e não interpreta o fuso", async () => {
    const dateParse = vi.spyOn(Date, "parse");
    const onBack = vi.fn();
    const onLoad = vi.fn(async () => detail());

    render(
      <StockDetailPage
        onBack={onBack}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    expect(await screen.findByText("ABC1D23")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Ficha do estoque" }),
    ).toBeVisible();
    expect(screen.getByText("Em estoque")).toBeVisible();
    expect(screen.getByText("9BWZZZ37••••51")).toBeVisible();
    expect(screen.getByText("006••••1676")).toBeVisible();
    expect(screen.queryByText("9BWZZZ377VT004251")).toBeNull();
    expect(screen.queryByText("00607701676")).toBeNull();
    expect(screen.getByText("38.590 km")).toBeVisible();
    expect(screen.getByText("24/11/2026 10:25:30 -03:00")).toBeVisible();
    expect(screen.getByText("24/11/2026 10:30")).toBeVisible();
    expect(screen.getByText("24/11/2026 10:31:45 Z")).toBeVisible();
    expect(screen.getByText("Administrativa")).toBeVisible();
    expect(screen.getByText("Código 01")).toBeVisible();
    expect(dateParse).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /saída|transferir|documento/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: /saída|transferir|documento/i }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Voltar ao estoque" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledWith(71, expect.any(AbortSignal));
  });

  it("destaca cancelamento sem oferecer ação operacional", async () => {
    render(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={vi.fn(async () =>
          detail({
            cancelamento: {
              dataHora: "2026-11-24T12:40",
              motivo: "Solicitação do estabelecimento",
            },
          }),
        )}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    expect(await screen.findByText("Registro cancelado")).toBeVisible();
    const cancellation = screen.getByRole("region", {
      name: "Registro cancelado no RENAVE",
    });
    expect(cancellation).toHaveTextContent("24/11/2026 12:40");
    expect(cancellation).toHaveTextContent("Solicitação do estabelecimento");
    expect(screen.queryByText("Em estoque")).toBeNull();
  });

  it.each([
    ["ABC", "••••C"],
    ["ABCD1234", "••••34"],
    ["ABCDEF1234", "••••34"],
  ])(
    "nunca revela integralmente um chassi curto %s",
    async (chassi, expected) => {
      render(
        <StockDetailPage
          onBack={vi.fn()}
          onLoad={vi.fn(async () => detail({ chassi }))}
          selectionKey="tenant-a:store-a"
          stockId={71}
        />,
      );

      expect(await screen.findByText(expected)).toBeVisible();
      expect(screen.queryByText(chassi)).toBeNull();
    },
  );

  it("aborta a ficha anterior ao trocar de registro e ignora resposta atrasada", async () => {
    const first = deferred<StockDetail>();
    const second = deferred<StockDetail>();
    const onLoad = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = render(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    view.rerender(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={88}
      />,
    );

    expect(onLoad.mock.calls[0]?.[0]).toBe(71);
    expect(onLoad.mock.calls[0]?.[1].aborted).toBe(true);
    expect(onLoad.mock.calls[1]?.[0]).toBe(88);
    expect(onLoad.mock.calls[1]?.[1].aborted).toBe(false);

    first.resolve(detail({ id: 71, placa: "ABC1D23" }));
    second.resolve(detail({ id: 88, placa: "QTP4H82" }));

    expect(await screen.findByText("QTP4H82")).toBeVisible();
    expect(screen.queryByText("ABC1D23")).toBeNull();
  });

  it("aborta a consulta ao trocar de estabelecimento com o mesmo registro", async () => {
    const first = deferred<StockDetail>();
    const second = deferred<StockDetail>();
    const onLoad = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = render(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    view.rerender(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-b"
        stockId={71}
      />,
    );

    expect(onLoad.mock.calls[0]?.[1].aborted).toBe(true);
    second.resolve(detail({ placa: "QTP4H82" }));
    expect(await screen.findByText("QTP4H82")).toBeVisible();
  });

  it("sanitiza erro, permite tentar novamente e aborta ao desmontar", async () => {
    const onLoad = vi
      .fn()
      .mockRejectedValueOnce(new Error("CPF 12345678901"))
      .mockResolvedValueOnce(detail());
    const view = render(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ficha indisponível");
    expect(alert).not.toHaveTextContent("12345678901");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Tentar novamente" }),
    );

    expect(await screen.findByText("ABC1D23")).toBeVisible();
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    const latestSignal = onLoad.mock.calls[1]?.[1] as AbortSignal;
    expect(latestSignal.aborted).toBe(false);
    view.unmount();
    expect(latestSignal.aborted).toBe(true);
  });

  it("atualiza explicitamente sem adicionar navegação de operações futuras", async () => {
    const onLoad = vi.fn(async () => detail({ restricoes: [] }));
    render(
      <StockDetailPage
        onBack={vi.fn()}
        onLoad={onLoad}
        selectionKey="tenant-a:store-a"
        stockId={71}
      />,
    );

    expect(
      await screen.findByText("Nenhuma restrição informada pelo RENAVE."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar ficha" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
  });
});
