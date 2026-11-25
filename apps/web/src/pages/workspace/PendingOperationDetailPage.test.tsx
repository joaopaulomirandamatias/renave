import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingOperationDetail } from "../../features/pending-operations/client.js";
import { PendingOperationDetailPage } from "./PendingOperationDetailPage.js";

afterEach(cleanup);

const operationId = "33333333-3333-4333-8333-333333333333";

function detail(
  status:
    | "PENDING_SEND"
    | "SENT"
    | "REJECTED"
    | "PENDING_RECONCILIATION"
    | "CONFIRMED"
    | "MANUAL_REVIEW" = "PENDING_RECONCILIATION",
): PendingOperationDetail {
  return {
    operation: {
      correlationId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-11-24T12:00:00.000Z",
      finalizedAt: status === "CONFIRMED" ? "2026-11-24T12:04:00.000Z" : null,
      kind: "USED_STOCK_ENTRY",
      operationId,
      reasonCode: null,
      remoteRecordId: status === "CONFIRMED" ? 71 : null,
      remoteState: status === "CONFIRMED" ? "CONFIRMADO" : null,
      sentAt: "2026-11-24T12:01:00.000Z",
      status,
      updatedAt: "2026-11-24T12:03:00.000Z",
      version: "3",
    },
    timeline: [
      {
        changedAt: "2026-11-24T12:00:00.000Z",
        previousStatus: null,
        reasonCode: "HELD_LOCAL_CREATED",
        status: "HELD_LOCAL",
        version: "1",
      },
      {
        changedAt: "2026-11-24T12:03:00.000Z",
        previousStatus: "SENT",
        reasonCode:
          status === "CONFIRMED" ? "RENAVE_RECONCILIATION_CONFIRMED" : null,
        status,
        version: "3",
      },
    ],
  };
}

describe("PendingOperationDetailPage", () => {
  it("renderiza timeline sem material protegido nem ação mutável", async () => {
    const onBack = vi.fn();
    render(
      <PendingOperationDetailPage
        onBack={onBack}
        onLoad={vi.fn(async () => detail())}
        operationId={operationId}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Operação 33333333" }),
    ).toBeVisible();
    expect(screen.getAllByText("Resultado incerto")).toHaveLength(2);
    expect(screen.getByRole("list")).toBeVisible();
    expect(screen.getByText("Linha do tempo")).toBeVisible();
    expect(screen.getByText(/reenvio bloqueado/i)).toBeVisible();
    expect(screen.queryByText(operationId)).toBeNull();
    expect(
      screen.queryByText(/cpf|e-mail|payload|idempotência|hash/i),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /reconciliar|reenviar/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Voltar às pendências" }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("continua legível depois de a operação sair da fila", async () => {
    render(
      <PendingOperationDetailPage
        onBack={vi.fn()}
        onLoad={vi.fn(async () => detail("CONFIRMED"))}
        operationId={operationId}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(await screen.findAllByText("Confirmada")).toHaveLength(2);
    expect(screen.queryByText(/reenvio bloqueado/i)).toBeNull();
    expect(
      screen.getByText("Registro confirmado pela verificação"),
    ).toBeVisible();
  });
});
