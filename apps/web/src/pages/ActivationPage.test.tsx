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
    const statusList = within(region).getAllByRole("list")[0]!;
    const steps = within(statusList).getAllByRole("listitem");
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent("Acesso à organização");
    expect(steps[0]).toHaveTextContent("Concluído");
    expect(steps[1]).toHaveTextContent("Aguardando acesso");
    expect(steps[2]).toHaveTextContent("Vínculo Credencia");
    expect(steps[2]).toHaveTextContent("Bloqueado");
    expect(steps[3]).toHaveTextContent("Mutações RENAVE");
    expect(steps[3]).toHaveTextContent("Protegidas");
    expect(
      screen.getByRole("complementary", { name: "Como preparar o vínculo" }),
    ).toHaveTextContent("Obtenha acesso a um estabelecimento");
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

  it.each([
    [
      "pending",
      "O vínculo aguarda verificação. Acompanhe no Credencia as confirmações e habilitações aplicáveis; não refaça a solicitação sem orientação",
    ],
    [
      "confirmed",
      "A liberação final ainda pode depender da habilitação pelo órgão competente",
    ],
    ["enabled", "Não refaça o processo sem necessidade"],
    [
      "rejected",
      "Revise o vínculo no Credencia e as orientações do órgão competente",
    ],
    [
      "deactivated",
      "Revise o vínculo no Credencia e as orientações do órgão competente",
    ],
  ] as const)(
    "orienta o vínculo %s sem presumir nova ativação",
    (linkStatus, guidance) => {
      render(<ActivationPage hasEstablishment linkStatus={linkStatus} />);

      const guide = screen.getByRole("complementary", {
        name: "Como preparar o vínculo",
      });
      expect(guide).toHaveTextContent(guidance);
      expect(guide).toHaveTextContent("Esta tela não concede a ativação");
    },
  );

  it("usa somente canais oficiais isolados e não coleta credenciais", () => {
    render(<ActivationPage hasEstablishment linkStatus="pending" />);

    const guide = screen.getByRole("complementary", {
      name: "Como preparar o vínculo",
    });
    const credencia = within(guide).getByRole("link", {
      name: /Acessar Credencia.*abre em nova aba/u,
    });
    const help = within(guide).getByRole("link", {
      name: /Ver orientação oficial.*abre em nova aba/u,
    });

    expect(credencia).toHaveAttribute(
      "href",
      "https://credencia.serpro.gov.br/",
    );
    expect(help).toHaveAttribute(
      "href",
      "https://centraldeajuda.serpro.gov.br/renave/institucional/como-credenciar/",
    );
    for (const link of [credencia, help]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      const url = new URL(link.getAttribute("href")!);
      expect(url.protocol).toBe("https:");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
    }
    expect(new URL(credencia.getAttribute("href")!).host).toBe(
      "credencia.serpro.gov.br",
    );
    expect(new URL(credencia.getAttribute("href")!).pathname).toBe("/");
    expect(new URL(help.getAttribute("href")!).host).toBe(
      "centraldeajuda.serpro.gov.br",
    );
    expect(new URL(help.getAttribute("href")!).pathname).toBe(
      "/renave/institucional/como-credenciar/",
    );
    expect(within(guide).queryByRole("form")).toBeNull();
    expect(within(guide).queryByRole("textbox")).toBeNull();
    expect(within(guide).queryByRole("button")).toBeNull();
    expect(guide.querySelector("form,input,textarea,select")).toBeNull();
    expect(guide).toHaveTextContent(
      "Não compartilhe certificado, chave privada ou senha",
    );
    expect(guide).toHaveTextContent("não solicita CPF ou CNPJ");
  });

  it("mantém o guia inconclusivo durante carregamento ou falha", () => {
    const { rerender } = render(
      <ActivationPage
        hasEstablishment
        linkStatus="enabled"
        linkStatusLoading
      />,
    );
    let guide = screen.getByRole("complementary", {
      name: "Como preparar o vínculo",
    });
    expect(guide).toHaveTextContent("consulta do vínculo está em andamento");
    expect(guide).not.toHaveTextContent("O vínculo está habilitado");

    rerender(
      <ActivationPage hasEstablishment linkStatus="enabled" linkStatusError />,
    );
    guide = screen.getByRole("complementary", {
      name: "Como preparar o vínculo",
    });
    expect(guide).toHaveTextContent(
      "estado do vínculo ainda não foi confirmado",
    );
    expect(guide).not.toHaveTextContent("O vínculo está habilitado");
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
