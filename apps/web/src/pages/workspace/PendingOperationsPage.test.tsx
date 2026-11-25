import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingOperationsPage as PendingOperationsPageResult } from "../../features/pending-operations/client.js";
import { PendingOperationsPage } from "./PendingOperationsPage.js";

afterEach(cleanup);

const operationA = "33333333-3333-4333-8333-333333333333";
const operationB = "44444444-4444-4444-8444-444444444444";

function page(
  operationId = operationA,
  status: "PENDING_RECONCILIATION" | "MANUAL_REVIEW" = "PENDING_RECONCILIATION",
): PendingOperationsPageResult {
  return {
    items: [
      {
        correlationId: "55555555-5555-4555-8555-555555555555",
        createdAt: "2026-11-24T12:00:00.000Z",
        kind: "USED_STOCK_ENTRY",
        operationId,
        reasonCode:
          status === "MANUAL_REVIEW" ? "RENAVE_RECONCILIATION_AMBIGUOUS" : null,
        sentAt: "2026-11-24T12:01:00.000Z",
        status,
        updatedAt: "2026-11-24T12:02:00.000Z",
      },
    ],
    truncated: false,
  };
}

describe("PendingOperationsPage", () => {
  it("explica a pendência sem oferecer reenvio ou reconciliação manual", async () => {
    render(
      <PendingOperationsPage
        onLoad={vi.fn(async () => page())}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Verificação no RENAVE em andamento",
      }),
    ).toBeVisible();
    expect(screen.getByText("Resultado incerto")).toBeVisible();
    expect(screen.getByText(/não reenvie esta operação/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Ver operação" })).toHaveAttribute(
      "href",
      `/pendencias/${operationA}`,
    );
    expect(
      screen.queryByRole("button", { name: /reconciliar|reenviar/i }),
    ).toBeNull();
  });

  it("preserva a lista anterior quando uma atualização falha", async () => {
    const onLoad = vi
      .fn<(signal: AbortSignal) => Promise<PendingOperationsPageResult>>()
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(new Error("indisponível"));
    render(
      <PendingOperationsPage onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );
    await screen.findByText("Resultado incerto");

    fireEvent.click(
      screen.getByRole("button", { name: "Atualizar pendências" }),
    );

    expect(
      await screen.findByRole("alert", {
        name: "",
      }),
    ).toHaveTextContent(/lista anterior foi preservada/i);
    expect(screen.getByText("Resultado incerto")).toBeVisible();
  });

  it("aborta a seleção anterior e não mistura estabelecimentos", async () => {
    let resolveFirst!: (value: PendingOperationsPageResult) => void;
    let firstSignal: AbortSignal | undefined;
    const onLoad = vi
      .fn<(signal: AbortSignal) => Promise<PendingOperationsPageResult>>()
      .mockImplementationOnce(
        (signal) =>
          new Promise((resolve) => {
            firstSignal = signal;
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(page(operationB, "MANUAL_REVIEW"));
    const view = render(
      <PendingOperationsPage onLoad={onLoad} selectionKey="tenant-a:store-a" />,
    );

    view.rerender(
      <PendingOperationsPage onLoad={onLoad} selectionKey="tenant-a:store-b" />,
    );
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByText("Revisão necessária")).toBeVisible();

    resolveFirst(page(operationA));
    await waitFor(() => {
      const list = screen.getByRole("list");
      expect(within(list).queryByText("Resultado incerto")).toBeNull();
    });
  });

  it("diferencia estado vazio de resposta truncada", async () => {
    const view = render(
      <PendingOperationsPage
        onLoad={vi.fn(async () => ({ items: [], truncated: false }))}
        selectionKey="tenant-a:store-a"
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Nenhuma pendência aberta" }),
    ).toBeVisible();

    view.rerender(
      <PendingOperationsPage
        onLoad={vi.fn(async () => ({ ...page(), truncated: true }))}
        selectionKey="tenant-a:store-b"
      />,
    );
    expect(
      await screen.findByText(/mostra as 50 pendências prioritárias/i),
    ).toBeVisible();
  });
});
