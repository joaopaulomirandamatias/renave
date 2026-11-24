import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActivationPage } from "./ActivationPage.js";

afterEach(cleanup);

describe("ActivationPage", () => {
  it("expõe checklist ordenado e mantém a operação protegida sem estabelecimento", () => {
    render(<ActivationPage hasEstablishment={false} />);

    const region = screen.getByRole("region", {
      name: "Ativação do estabelecimento",
    });
    expect(region).toHaveAttribute("aria-busy", "false");
    const steps = within(region).getAllByRole("listitem");
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent("Acesso à organização");
    expect(steps[0]).toHaveTextContent("Concluído");
    expect(steps[1]).toHaveTextContent("Aguardando acesso");
    expect(steps[2]).toHaveTextContent("Vínculo Credencia");
    expect(steps[2]).toHaveTextContent("Bloqueado");
    expect(steps[3]).toHaveTextContent("Mutações RENAVE");
    expect(steps[3]).toHaveTextContent("Protegidas");
  });

  it("não presume 'não iniciado' antes de receber o estado autoritativo", () => {
    render(<ActivationPage hasEstablishment />);

    const region = screen.getByRole("region", {
      name: "Ativação do estabelecimento",
    });
    const credentialStep = within(region)
      .getByRole("heading", { name: "Vínculo Credencia" })
      .closest("li");
    expect(credentialStep).toHaveTextContent("Aguardando consulta");
    expect(credentialStep).not.toHaveTextContent("Aguardando início");
    expect(credentialStep).not.toHaveTextContent("Não iniciado");
  });

  it("anuncia a consulta autoritativa sem presumir ativação", () => {
    render(
      <ActivationPage
        hasEstablishment
        linkStatusLoading
        linkStatus="enabled"
      />,
    );

    const region = screen.getByRole("region", {
      name: "Ativação do estabelecimento",
    });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(within(region).getByText("Consultando")).toBeVisible();
    expect(within(region).queryByText("Habilitado")).toBeNull();
    expect(within(region).getByText("Protegidas")).toBeVisible();
  });

  it.each([
    ["not_started", "Aguardando início"],
    ["pending", "Aguardando verificação"],
    ["confirmed", "Identidade confirmada"],
    ["enabled", "Pronto para consultas liberadas"],
    ["deactivated", "Revisão necessária"],
    ["rejected", "Correção necessária"],
  ] as const)("representa o vínculo %s como %s", (linkStatus, label) => {
    render(<ActivationPage hasEstablishment linkStatus={linkStatus} />);

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText("Protegidas")).toBeVisible();
  });

  it("trata falha de leitura como indisponibilidade, não como conclusão", () => {
    render(
      <ActivationPage
        hasEstablishment
        linkStatus="confirmed"
        linkStatusError
      />,
    );

    const region = screen.getByRole("region", {
      name: "Ativação do estabelecimento",
    });
    expect(within(region).getByText("Indisponível")).toBeVisible();
    expect(within(region).queryByText("Confirmado")).toBeNull();
    expect(region).toHaveTextContent("Nenhuma ativação foi presumida");
  });
});
