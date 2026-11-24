import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredenciaLinkQueuePanel } from "./CredenciaLinkQueuePanel.js";

afterEach(cleanup);

describe("CredenciaLinkQueuePanel", () => {
  it("explica a origem local, prioriza pendências e só oferece recarga", () => {
    const onReload = vi.fn();
    render(
      <CredenciaLinkQueuePanel
        items={[
          {
            establishment: { id: "store-a", tradeName: "Loja A" },
            renaveLink: {
              status: "pending",
              updatedAt: "2026-11-24T12:30:00.000Z",
            },
          },
          {
            establishment: { id: "store-b", tradeName: "Loja B" },
            renaveLink: { status: "not_started" },
          },
        ]}
        onReload={onReload}
        truncated
      />,
    );

    const region = screen.getByRole("region", {
      name: "Fila de vínculos Credencia",
    });
    expect(region).toHaveTextContent(
      /Credencia continua sendo a fonte oficial/i,
    );
    expect(region).toHaveTextContent(/1\s*vínculo pendente/);
    expect(region).toHaveTextContent("Última atualização local");
    expect(region).toHaveTextContent("Sem verificação local registrada");
    expect(region).toHaveTextContent(/mostra os 500 vínculos prioritários/i);
    expect(region.querySelector(".credencia-queue__summary")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(
      within(region).queryByRole("button", {
        name: /confirmar|rejeitar|habilitar/i,
      }),
    ).toBeNull();
    fireEvent.click(
      within(region).getByRole("button", { name: "Atualizar lista" }),
    );
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("falha fechado e não presume estados quando a leitura erra", () => {
    render(<CredenciaLinkQueuePanel error onReload={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nenhum estado foi presumido",
    );
    expect(screen.queryByText(/nenhum estabelecimento ativo/i)).toBeNull();
  });

  it("comunica carregamento sem fabricar uma lista vazia", () => {
    render(<CredenciaLinkQueuePanel loading />);

    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Carregando vínculos da organização",
    );
  });
});
