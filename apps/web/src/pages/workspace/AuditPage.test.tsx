import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LoadTenantAuditEventsInput,
  TenantAuditEventItem,
  TenantAuditEventsResult,
} from "../../features/audit/client.js";
import { AuditPage } from "./AuditPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";

function makeEvent(
  sequence: number,
  overrides: Partial<TenantAuditEventItem> = {},
): TenantAuditEventItem {
  return {
    action: "stock-entry.held-local.created",
    entityType: "stock_entry",
    establishmentId: ESTABLISHMENT_ID,
    eventHashPrefix: "abcdef012345",
    occurredAt: "2026-11-24T15:00:00.000Z",
    outcome: "succeeded",
    sequence,
    traceId: `trace-${sequence}`,
    ...overrides,
  };
}

describe("AuditPage", () => {
  it("renderiza tabela acessível, filtros e paginação preservando eventos anteriores", async () => {
    const onLoad = vi
      .fn<
        (
          input: Omit<LoadTenantAuditEventsInput, "tenantId">,
        ) => Promise<TenantAuditEventsResult>
      >()
      .mockResolvedValueOnce({
        page: {
          hasMore: true,
          items: [
            makeEvent(20, { outcome: "succeeded" }),
            makeEvent(19, {
              action: "renave.stock-exit.request",
              entityType: "stock_exit",
              eventHashPrefix: "998877665544",
              outcome: "rejected",
            }),
          ],
          nextBeforeSequence: 19,
        },
        status: "ready",
      })
      .mockResolvedValueOnce({
        page: {
          hasMore: false,
          items: [
            makeEvent(19, { outcome: "rejected" }),
            makeEvent(18, {
              action: "renave.stock-entry.reconciled",
              eventHashPrefix: "112233445566",
              outcome: "outcome_unknown",
              traceId: null,
            }),
          ],
        },
        status: "ready",
      });

    render(
      <AuditPage
        onLoad={onLoad}
        selectedEstablishmentId={ESTABLISHMENT_ID}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(await screen.findByText("#20")).toBeVisible();
    expect(screen.getByText("#19")).toBeVisible();
    expect(screen.getByText("abcdef012345")).toBeVisible();
    expect(screen.getByText("trace-20")).toBeVisible();
    expect(
      screen.getByRole("table", {
        name: "Eventos de auditoria da organização",
      }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Carregar eventos anteriores" }),
    );

    expect(await screen.findByText("#18")).toBeVisible();
    expect(screen.getByText("#20")).toBeVisible();
    expect(screen.getAllByText("#19")).toHaveLength(1);
    expect(screen.getByText("Sem trace")).toBeVisible();
    expect(onLoad).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ beforeSequence: 19, limit: 25 }),
    );
  });

  it("aplica filtros de resultado e escopo do estabelecimento ativo", async () => {
    const onLoad = vi.fn<
      (
        input: Omit<LoadTenantAuditEventsInput, "tenantId">,
      ) => Promise<TenantAuditEventsResult>
    >(async () => ({
      page: { hasMore: false, items: [makeEvent(10)] },
      status: "ready",
    }));

    render(
      <AuditPage
        onLoad={onLoad}
        selectedEstablishmentId={ESTABLISHMENT_ID}
        selectionKey="tenant-a:store-a"
      />,
    );
    await screen.findByText("#10");

    fireEvent.change(screen.getByLabelText("Resultado"), {
      target: { value: "rejected" },
    });
    await screen.findByText("#10");
    expect(onLoad).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "rejected" }),
    );

    fireEvent.change(screen.getByLabelText("Escopo"), {
      target: { value: "active" },
    });
    await screen.findByText("#10");
    expect(onLoad).toHaveBeenLastCalledWith(
      expect.objectContaining({
        establishmentId: ESTABLISHMENT_ID,
        outcome: "rejected",
      }),
    );
  });

  it("preserva a lista carregada e anuncia erro quando a paginação falha", async () => {
    const onLoad = vi
      .fn<
        (
          input: Omit<LoadTenantAuditEventsInput, "tenantId">,
        ) => Promise<TenantAuditEventsResult>
      >()
      .mockResolvedValueOnce({
        page: {
          hasMore: true,
          items: [makeEvent(30)],
          nextBeforeSequence: 30,
        },
        status: "ready",
      })
      .mockRejectedValueOnce(new Error("network"));

    render(
      <AuditPage
        onLoad={onLoad}
        selectedEstablishmentId={ESTABLISHMENT_ID}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(await screen.findByText("#30")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Carregar eventos anteriores" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /eventos já exibidos foram preservados/i,
    );
    expect(screen.getByText("#30")).toBeVisible();
  });

  it("exibe estado vazio quando não há eventos", async () => {
    render(
      <AuditPage
        onLoad={vi.fn(async () => ({
          page: { hasMore: false, items: [] },
          status: "ready" as const,
        }))}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(
      await screen.findByText("Nenhum evento de auditoria encontrado"),
    ).toBeVisible();
  });

  it("exibe aviso fail-closed quando o acesso à auditoria é negado", async () => {
    render(
      <AuditPage
        onLoad={vi.fn(async () => ({ status: "denied" as const }))}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(
      await screen.findByText(
        /não possui permissão de leitura da trilha de auditoria/i,
      ),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      /não possui permissão de leitura da trilha de auditoria/i,
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
