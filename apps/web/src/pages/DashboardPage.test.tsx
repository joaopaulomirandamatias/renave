import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "./DashboardPage.js";

afterEach(cleanup);

const establishments = [
  { id: "store-belem", label: "Loja Belém" },
  { id: "store-ananindeua", label: "Loja Ananindeua" },
] as const;

describe("DashboardPage", () => {
  it("mantém ambiente, estabelecimento e bloqueio operacional visíveis", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        onLogout={vi.fn()}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Ambiente: Homologação",
    );
    const establishmentSelect = screen.getByRole("combobox", {
      name: "Estabelecimento ativo",
    });
    expect(establishmentSelect).toHaveValue("store-belem");
    expect(establishmentSelect).toBeDisabled();
    expect(
      screen.queryByRole("heading", { name: "Consultar aptidão do veículo" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Integração ainda protegida" }),
    ).toHaveTextContent(/operações permanecem bloqueadas/i);
  });

  it("expõe navegação acessível e comunica a troca pelo identificador interno", () => {
    const onEstablishmentChange = vi.fn();
    render(
      <DashboardPage
        environment="development"
        establishments={establishments}
        onEstablishmentChange={onEstablishmentChange}
        onLogout={vi.fn()}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Seções da aplicação",
    });
    expect(
      within(navigation).getByRole("link", { name: "Painel" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getAllByRole("link")).toHaveLength(1);
    expect(
      within(navigation).queryByRole("link", { name: "Estoque" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Pendências" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Auditoria" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Configurações" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Sair" })).toHaveAttribute(
      "type",
      "button",
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
      { target: { value: "store-ananindeua" } },
    );
    expect(onEstablishmentChange).toHaveBeenCalledWith("store-ananindeua");
  });

  it("cai para o primeiro estabelecimento quando o selecionado não existe", () => {
    render(
      <DashboardPage
        environment="development"
        establishments={establishments}
        onEstablishmentChange={vi.fn()}
        onLogout={vi.fn()}
        selectedEstablishmentId="store-inexistente"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toHaveValue("store-belem");
  });

  it("delega logout por ação POST da composição em vez de navegar por GET", () => {
    const onLogout = vi.fn();
    render(
      <DashboardPage
        environment="development"
        establishments={establishments}
        onLogout={onLogout}
        userDisplayName="Operador"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "Sair" })).toBeNull();
  });

  it("mostra o estado do vínculo e dispara o preflight autorizado", () => {
    const onRunPreflight = vi.fn();
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="confirmed"
        onLogout={vi.fn()}
        onRunPreflight={onRunPreflight}
        preflightAvailable
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Vínculo do estabelecimento" }),
    ).toHaveTextContent("Confirmado");
    const integration = screen.getByRole("region", {
      name: "Identidade do vínculo confirmada",
    });
    expect(integration).not.toHaveTextContent(/homologaç/i);
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(onRunPreflight).toHaveBeenCalledOnce();
  });

  it("só mostra consultas RENAVE com seleção, vínculo e prontidão confirmados", () => {
    const onSearchStocks = vi.fn(async () => []);
    const onCheckEligibility = vi.fn(async () => ({
      detranUnavailable: false,
      impediments: [],
      status: "eligible" as const,
    }));
    const view = render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="pending"
        onCheckEligibility={onCheckEligibility}
        onLogout={vi.fn()}
        onSearchStocks={onSearchStocks}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Localizar estoque por placa" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Consultar aptidão do veículo" }),
    ).toBeNull();

    view.rerender(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="confirmed"
        onCheckEligibility={onCheckEligibility}
        onLogout={vi.fn()}
        onSearchStocks={onSearchStocks}
        readiness={{
          certificate: "blocked",
          environment: "homologation",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          queries: "blocked",
        }}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Localizar estoque por placa" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Consultar aptidão do veículo" }),
    ).toBeNull();

    view.rerender(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="confirmed"
        onCheckEligibility={onCheckEligibility}
        onLogout={vi.fn()}
        onSearchStocks={onSearchStocks}
        readiness={{
          certificate: "ready",
          environment: "homologation",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          queries: "ready",
        }}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Localizar estoque por placa" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Consultar aptidão do veículo" }),
    ).toBeVisible();
  });

  it("não apresenta zeros fictícios antes de existir uma fonte agregada", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        onLogout={vi.fn()}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    const summary = screen.getByRole("region", {
      name: "Resumo do estabelecimento",
    });
    expect(summary).toHaveTextContent("Indisponível nesta etapa");
    expect(summary).not.toHaveTextContent("Operações confirmadas");
    expect(summary).not.toHaveTextContent("Pendências abertas");
    expect(summary).not.toHaveTextContent("Resultados incertos");
    expect(
      screen.getByRole("region", { name: "Ativação do estabelecimento" }),
    ).toBeVisible();
  });

  it("mantém o painel e anuncia falhas de contexto e logout", () => {
    render(
      <DashboardPage
        contextError
        environment="homologation"
        establishments={establishments}
        logoutError
        onLogout={vi.fn()}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Olá, Operador" }),
    ).toBeVisible();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("O contexto anterior foi preservado");
    expect(alerts[1]).toHaveTextContent("Você continua conectado");
  });

  it("anuncia carregamento de contexto sem exibir um vazio definitivo", () => {
    render(
      <DashboardPage
        contextLoading
        environment="homologation"
        establishments={[]}
        onLogout={vi.fn()}
        userDisplayName="Operador"
      />,
    );

    expect(screen.getByText(/carregando estabelecimentos/i)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("expõe o checklist de prontidão sem confundir consulta com mutação", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="confirmed"
        onLogout={vi.fn()}
        readiness={{
          certificate: "warning",
          environment: "homologation",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          queries: "ready",
        }}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    const readiness = screen.getByRole("region", {
      name: "Prontidão da integração",
    });
    expect(readiness).toHaveTextContent("Homologação");
    expect(readiness).toHaveTextContent("Configurada");
    expect(readiness).toHaveTextContent("Atenção");
    expect(readiness).toHaveTextContent("Liberadas");
    expect(readiness).toHaveTextContent("Mutações RENAVE");
    expect(readiness).toHaveTextContent("Protegidas");
  });

  it("bloqueia preflight com certificado indisponível e preserva aviso como permitido", () => {
    const onRunPreflight = vi.fn();
    const view = render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="pending"
        onLogout={vi.fn()}
        onRunPreflight={onRunPreflight}
        preflightAvailable
        readiness={{
          certificate: "unavailable",
          environment: "homologation",
          integration: "configured",
          link: "pending",
          mutations: "blocked",
          queries: "blocked",
        }}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Verificar vínculo" }),
    ).toBeDisabled();

    view.rerender(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="pending"
        onLogout={vi.fn()}
        onRunPreflight={onRunPreflight}
        preflightAvailable
        readiness={{
          certificate: "warning",
          environment: "homologation",
          integration: "configured",
          link: "pending",
          mutations: "blocked",
          queries: "blocked",
        }}
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(onRunPreflight).toHaveBeenCalledOnce();
  });

  it("preserva o vínculo quando o diagnóstico de prontidão falha", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="confirmed"
        onLogout={vi.fn()}
        readinessError
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(screen.getByText("Confirmado")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /o vínculo já exibido foi preservado/i,
    );
  });

  it("mantém preflight bloqueado enquanto verifica a prontidão", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="pending"
        onLogout={vi.fn()}
        onRunPreflight={vi.fn()}
        preflightAvailable
        readinessLoading
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByText(/verificando controles locais de prontidão/i),
    ).toHaveAttribute("role", "status");
    expect(
      screen.getByRole("button", { name: "Verificar vínculo" }),
    ).toBeDisabled();
  });

  it("permite recarregar o vínculo mesmo se a prontidão estiver indisponível", () => {
    const onReloadLinkStatus = vi.fn();
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatusError
        onLogout={vi.fn()}
        onReloadLinkStatus={onReloadLinkStatus}
        readinessError
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    const reload = screen.getByRole("button", {
      name: "Tentar carregar vínculo",
    });
    expect(reload).toBeEnabled();
    fireEvent.click(reload);
    expect(onReloadLinkStatus).toHaveBeenCalledOnce();
  });
});
