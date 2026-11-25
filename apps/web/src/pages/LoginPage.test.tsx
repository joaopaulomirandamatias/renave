import {
  BrandLogo,
  Button,
  EnvironmentBadge,
  SecurityNotice,
} from "@seu-renave/ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "./LoginPage.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(currentDir, "../../index.html"), "utf8");

afterEach(cleanup);

describe("LoginPage", () => {
  it("mantém a marca RenavEstoque e não carrega fontes por CDN", () => {
    expect(indexHtml).toContain("<title>Entrar — RenavEstoque</title>");
    expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
  });

  it("inicia o fluxo corporativo sem coletar credenciais e expõe semântica acessível", () => {
    const { container } = render(<LoginPage />);

    expect(screen.getByRole("main")).toBeVisible();
    expect(screen.getByRole("img", { name: "RenavEstoque" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ambiente: Desenvolvimento",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Entrar na sua conta" }),
    ).toBeVisible();

    const accessCard = screen.getByRole("region", {
      name: "Entrar na sua conta",
    });
    expect(accessCard).toBeVisible();

    const loginLink = screen.getByRole("link", {
      name: /continuar com acesso seguro/i,
    });
    expect(loginLink).toHaveAttribute("href", "/api/auth/login");
    expect(loginLink).toHaveClass(
      "sr-button",
      "sr-button--primary",
      "sr-button--lg",
    );

    const securityRegion = screen.getByRole("region", {
      name: "Proteções do acesso",
    });
    expect(within(securityRegion).getAllByRole("listitem")).toHaveLength(2);

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(
      screen.getByText(/não é o sistema oficial do governo/i),
    ).toBeVisible();
  });

  it("exibe o ambiente informado sem permitir seleção pelo usuário", () => {
    render(<LoginPage environment="homologation" />);

    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("Ambiente: Homologação");
    expect(badge).toHaveAttribute("data-environment", "homologation");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("anuncia feedback seguro do retorno OIDC sem alterar o início do login", () => {
    render(
      <LoginPage
        authFeedback={{
          title: "Não foi possível concluir o acesso",
          message: "Tente entrar novamente com sua conta corporativa.",
        }}
        environment="homologation"
      />,
    );

    const feedback = screen.getByRole("alert");
    expect(feedback).toHaveTextContent("Não foi possível concluir o acesso");
    expect(feedback).toHaveTextContent(
      "Tente entrar novamente com sua conta corporativa.",
    );
    expect(
      screen.getByRole("link", { name: /continuar com acesso seguro/i }),
    ).toHaveAttribute("href", "/api/auth/login");
  });
});

describe("@seu-renave/ui acessibilidade e semântica", () => {
  it("Button nativo usa type='button' por padrão, respeita disabled e bloqueia cliques", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="secondary" onClick={onClick}>
        Verificar no RENAVE
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Verificar no RENAVE" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass(
      "sr-button",
      "sr-button--secondary",
      "sr-button--md",
    );
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button variant="secondary" disabled onClick={onClick}>
        Verificar no RENAVE
      </Button>,
    );

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Button em estado loading expõe aria-busy, desabilita interação e anuncia carregamento", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        Enviar ao RENAVE
      </Button>,
    );

    const button = screen.getByRole("button", {
      name: /enviar ao renave \(carregando\)/i,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-loading", "true");

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button loading loadingLabel="Validando no RENAVE..." onClick={onClick}>
        Enviar ao RENAVE
      </Button>,
    );

    const labeledButton = screen.getByRole("button", {
      name: "Validando no RENAVE...",
    });
    expect(labeledButton).toBeDisabled();
    expect(labeledButton).toHaveAttribute("aria-busy", "true");
  });

  it("Button em modo link mantém role='link' e remove href quando disabled ou loading", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button
        href="/api/auth/login"
        trailingIcon={<svg data-testid="icon-svg" />}
        onClick={onClick}
      >
        Entrar
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Entrar" });
    expect(link).toHaveAttribute("href", "/api/auth/login");
    expect(screen.getByTestId("icon-svg").parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    rerender(
      <Button
        href="/api/auth/login"
        loading
        loadingLabel="Redirecionando..."
        onClick={onClick}
      >
        Entrar
      </Button>,
    );

    const busyLink = screen.getByRole("link", { name: "Redirecionando..." });
    expect(busyLink).not.toHaveAttribute("href");
    expect(busyLink).toHaveAttribute("aria-disabled", "true");
    expect(busyLink).toHaveAttribute("aria-busy", "true");

    fireEvent.click(busyLink);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("EnvironmentBadge comunica o ambiente em texto claro e mantém indicador visual decorativo", () => {
    const { container, rerender } = render(
      <EnvironmentBadge environment="production" />,
    );

    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("Ambiente: Produção");
    expect(badge).toHaveAttribute("data-environment", "production");
    expect(container.querySelector(".sr-env-badge__dot")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    rerender(
      <EnvironmentBadge environment="homologation" showPrefix={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Homologação");
  });

  it("SecurityNotice associa título via aria-labelledby e oculta ícones decorativos", () => {
    render(
      <SecurityNotice
        title="Segurança da sessão"
        headingLevel={3}
        tone="brand"
        items={[
          {
            id: "audit",
            icon: <svg data-testid="notice-icon" />,
            text: "Todo acesso gera trilha de auditoria imutável.",
          },
        ]}
      />,
    );

    const region = screen.getByRole("region", { name: "Segurança da sessão" });
    expect(
      within(region).getByRole("heading", {
        level: 3,
        name: "Segurança da sessão",
      }),
    ).toBeVisible();
    expect(within(region).getByRole("listitem")).toHaveTextContent(
      "Todo acesso gera trilha de auditoria imutável.",
    );
    expect(screen.getByTestId("notice-icon").parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("BrandLogo mantém nome acessível mesmo no modo compacto", () => {
    const { container } = render(<BrandLogo compact />);

    expect(screen.getByRole("img", { name: "RenavEstoque" })).toBeVisible();
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".sr-brand__name")).toBeNull();
  });

  it("BrandLogo inversa mantém nome acessível com wordmark", () => {
    const { container } = render(
      <BrandLogo compact showWordmark variant="inverse" />,
    );

    expect(screen.getByRole("img", { name: "RenavEstoque" })).toBeVisible();
    expect(container.querySelector(".sr-brand__name")).toHaveTextContent(
      "RenavEstoque",
    );
    expect(container.querySelector(".sr-brand--inverse")).toBeVisible();
  });
});
