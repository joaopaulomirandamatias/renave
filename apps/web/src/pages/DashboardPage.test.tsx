import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReadonlyCanaryPort } from "../features/homologation-canary/index.js";
import { DashboardPage } from "./DashboardPage.js";

afterEach(cleanup);

const establishments = [
  { id: "store-belem", label: "Loja Belém" },
  { id: "store-ananindeua", label: "Loja Ananindeua" },
] as const;

function canaryPort(): ReadonlyCanaryPort {
  return {
    checkEligibility: vi.fn(async () => ({
      detranUnavailable: false,
      impediments: [],
      status: "eligible" as const,
    })),
    loadReadiness: vi.fn(async () => ({
      certificate: "ready" as const,
      environment: "homologation" as const,
      establishmentContact: "verified" as const,
      integration: "configured" as const,
      link: "enabled" as const,
      mutations: "blocked" as const,
      operatorIdentity: "verified" as const,
      queries: "ready" as const,
    })),
    lookupVehicle: vi.fn(async (plate) => ({ placa: plate, restricoes: [] })),
    runPreflight: vi.fn(async () => undefined),
    searchStocks: vi.fn(async (plate) => [
      { estado: "CONFIRMADO" as const, id: 1, placa: plate },
    ]),
  };
}

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
    const view = render(
      <DashboardPage
        environment="development"
        establishmentManagement="mfa_required"
        establishments={establishments}
        onEstablishmentChange={onEstablishmentChange}
        onLogout={vi.fn()}
        selectedEstablishmentId="store-belem"
        stockEntryOperationsEnabled
        userDisplayName="Operador"
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Seções da aplicação",
    });
    expect(
      within(navigation).getByRole("link", { name: "Painel" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getAllByRole("link")).toHaveLength(5);
    expect(
      within(navigation).getByRole("link", { name: "Estoque" }),
    ).toHaveAttribute("href", "/estoque");
    expect(
      within(navigation).queryByRole("link", { name: "Pendências" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Auditoria" }),
    ).toBeNull();
    expect(
      within(navigation).getByRole("link", {
        name: "Estabelecimentos & Certificados",
      }),
    ).toHaveAttribute("href", "/configuracoes/estabelecimentos");
    expect(screen.getByRole("button", { name: "Sair" })).toHaveAttribute(
      "type",
      "button",
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
      { target: { value: "store-ananindeua" } },
    );
    expect(onEstablishmentChange).toHaveBeenCalledWith("store-ananindeua");

    view.rerender(
      <DashboardPage
        environment="development"
        establishmentManagement="mfa_required"
        establishments={establishments}
        onEstablishmentChange={onEstablishmentChange}
        onLogout={vi.fn()}
        route="stock"
        selectedEstablishmentId="store-belem"
        stockEntryOperationsEnabled
        userDisplayName="Operador"
      />,
    );
    expect(
      within(navigation).getByRole("link", { name: "Estoque" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(navigation).getByRole("link", { name: "Painel" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("não expõe rotas sem capability ou feature flag", () => {
    render(
      <DashboardPage
        environment="development"
        establishmentManagement="denied"
        establishments={establishments}
        onLogout={vi.fn()}
        userDisplayName="Operador"
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Seções da aplicação",
    });
    expect(
      within(navigation).queryByRole("link", { name: "Entradas" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", {
        name: "Estabelecimentos & Certificados",
      }),
    ).toBeNull();
    expect(within(navigation).getAllByRole("link")).toHaveLength(3);
  });

  it.each([
    ["dashboard", "Resumo do estabelecimento"],
    ["stock", "Consultar aptidão do veículo"],
    ["stock-entry", "Registrar compra do veículo"],
    ["compliance", "Vínculo do estabelecimento"],
    ["establishments", "Cadastrar estabelecimento"],
  ] as const)(
    "monta somente o conteúdo da rota %s",
    (route, expectedHeading) => {
      const routeHeadings = [
        "Resumo do estabelecimento",
        "Consultar aptidão do veículo",
        "Registrar compra do veículo",
        "Vínculo do estabelecimento",
        "Cadastrar estabelecimento",
      ] as const;

      render(
        <DashboardPage
          environment="homologation"
          establishmentManagement="available"
          establishments={establishments}
          linkStatus="enabled"
          onCheckEligibility={vi.fn(async () => ({
            detranUnavailable: false,
            impediments: [],
            status: "eligible" as const,
          }))}
          onCreateEstablishment={vi.fn(async () => ({
            establishment: { id: "store-created", tradeName: "Loja Centro" },
            renaveLink: { status: "not_started" as const },
          }))}
          onCreateStockEntry={vi.fn(async () => ({
            createdAt: "2026-11-24T15:00:00.000Z",
            operationId: "11111111-1111-4111-8111-111111111111",
            replayed: false,
            status: "HELD_LOCAL" as const,
          }))}
          onLogout={vi.fn()}
          onSearchStocks={vi.fn(async () => [])}
          readiness={{
            certificate: "ready",
            environment: "homologation",
            establishmentContact: "verified",
            integration: "configured",
            link: "enabled",
            mutations: "blocked",
            operatorIdentity: "verified",
            queries: "ready",
          }}
          route={route}
          selectedEstablishmentId="store-belem"
          selectedTenantId="tenant-a"
          stockEntryOperationsEnabled
          tenants={[{ id: "tenant-a", label: "Organização A" }]}
          userDisplayName="Operador"
        />,
      );

      for (const heading of routeHeadings) {
        const query = screen.queryByRole("heading", { name: heading });
        if (heading === expectedHeading) expect(query).toBeVisible();
        else expect(query).toBeNull();
      }
    },
  );

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
        route="compliance"
        selectedEstablishmentId="store-belem"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Vínculo do estabelecimento" }),
    ).toHaveTextContent("Confirmado");
    expect(
      screen.getByRole("heading", { name: "Conformidade e integração" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", {
        name: "Identidade do vínculo confirmada",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(onRunPreflight).toHaveBeenCalledOnce();
  });

  it("só mostra consultas RENAVE com seleção, vínculo e prontidão confirmados", () => {
    const onLoadRecentStocks = vi.fn(async () => []);
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
        onLoadRecentStocks={onLoadRecentStocks}
        onSearchStocks={onSearchStocks}
        route="stock"
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
        onLoadRecentStocks={onLoadRecentStocks}
        onSearchStocks={onSearchStocks}
        route="stock"
        readiness={{
          certificate: "blocked",
          environment: "homologation",
          establishmentContact: "pending",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          operatorIdentity: "pending",
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
        onLoadRecentStocks={onLoadRecentStocks}
        onSearchStocks={onSearchStocks}
        route="stock"
        readiness={{
          certificate: "ready",
          environment: "homologation",
          establishmentContact: "verified",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          operatorIdentity: "verified",
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
      screen.getByRole("heading", { name: "Estoque RENAVE recente" }),
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
      screen.queryByRole("region", { name: "Ativação do estabelecimento" }),
    ).toBeNull();
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
        route="compliance"
        readiness={{
          certificate: "warning",
          environment: "homologation",
          establishmentContact: "pending",
          integration: "configured",
          link: "confirmed",
          mutations: "blocked",
          operatorIdentity: "verified",
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
    expect(readiness).toHaveTextContent("Identidade do operador");
    expect(readiness).toHaveTextContent("Contato RENAVE do estabelecimento");
    expect(readiness).toHaveTextContent("Verificação concluída");
    expect(readiness).toHaveTextContent("Aguardando verificação");
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
        route="compliance"
        readiness={{
          certificate: "unavailable",
          environment: "homologation",
          establishmentContact: "unavailable",
          integration: "configured",
          link: "pending",
          mutations: "blocked",
          operatorIdentity: "pending",
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
        route="compliance"
        readiness={{
          certificate: "warning",
          environment: "homologation",
          establishmentContact: "pending",
          integration: "configured",
          link: "pending",
          mutations: "blocked",
          operatorIdentity: "verified",
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
        route="compliance"
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
        route="compliance"
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
        route="compliance"
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

  it("mantém a entrada de estoque bloqueada sem a capability explícita", () => {
    const onCreateStockEntry = vi.fn();
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="enabled"
        onCreateStockEntry={onCreateStockEntry}
        onLogout={vi.fn()}
        route="stock-entry"
        readiness={{
          certificate: "ready",
          environment: "homologation",
          establishmentContact: "verified",
          integration: "configured",
          link: "enabled",
          mutations: "blocked",
          operatorIdentity: "verified",
          queries: "ready",
        }}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        tenants={[{ id: "tenant-a", label: "Organização A" }]}
        userDisplayName="Operador"
      />,
    );

    expect(screen.getByText(/capability explícita/i)).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.queryByRole("button", { name: "Registrar solicitação local" }),
    ).toBeNull();
  });

  it("só exibe o formulário com capability, perfis, vínculo e integração prontos", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="enabled"
        onCreateStockEntry={vi.fn(async () => ({
          createdAt: "2026-11-24T15:00:00.000Z",
          operationId: "11111111-1111-4111-8111-111111111111",
          replayed: false,
          status: "HELD_LOCAL" as const,
        }))}
        onLogout={vi.fn()}
        route="stock-entry"
        readiness={{
          certificate: "warning",
          environment: "homologation",
          establishmentContact: "verified",
          integration: "configured",
          link: "enabled",
          mutations: "blocked",
          operatorIdentity: "verified",
          queries: "ready",
        }}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        stockEntryOperationsEnabled
        tenants={[{ id: "tenant-a", label: "Organização A" }]}
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Registrar solicitação local" }),
    ).toBeEnabled();
    expect(screen.getByText(/CPF do operador/i)).toHaveTextContent(
      /perfis verificados no servidor/i,
    );
  });

  it.each(["missing", "pending", "suspended", "unavailable"] as const)(
    "mantém entrada bloqueada com perfil %s e preserva consultas na rota própria",
    (profileStatus) => {
      const props = {
        environment: "homologation" as const,
        establishments,
        linkStatus: "enabled" as const,
        onCheckEligibility: vi.fn(),
        onCreateStockEntry: vi.fn(),
        onLogout: vi.fn(),
        onSearchStocks: vi.fn(),
        readiness: {
          certificate: "ready" as const,
          environment: "homologation" as const,
          establishmentContact: "verified" as const,
          integration: "configured" as const,
          link: "enabled" as const,
          mutations: "blocked" as const,
          operatorIdentity: profileStatus,
          queries: "ready" as const,
        },
        selectedEstablishmentId: "store-belem",
        selectedTenantId: "tenant-a",
        stockEntryOperationsEnabled: true,
        tenants: [{ id: "tenant-a", label: "Organização A" }],
        userDisplayName: "Operador",
      };
      const view = render(<DashboardPage {...props} route="stock-entry" />);

      expect(
        screen.queryByRole("button", { name: "Registrar solicitação local" }),
      ).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Localizar estoque por placa" }),
      ).toBeNull();

      view.rerender(<DashboardPage {...props} route="stock" />);
      expect(
        screen.getByRole("heading", { name: "Localizar estoque por placa" }),
      ).toBeVisible();
      expect(
        screen.getByRole("heading", {
          name: "Consultar aptidão do veículo",
        }),
      ).toBeVisible();
    },
  );

  it("não confia em um vínculo externo habilitado quando a prontidão diverge", () => {
    render(
      <DashboardPage
        environment="homologation"
        establishments={establishments}
        linkStatus="enabled"
        onCreateStockEntry={vi.fn()}
        onLogout={vi.fn()}
        route="stock-entry"
        readiness={{
          certificate: "ready",
          environment: "homologation",
          establishmentContact: "verified",
          integration: "configured",
          link: "pending",
          mutations: "blocked",
          operatorIdentity: "verified",
          queries: "blocked",
        }}
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        stockEntryOperationsEnabled
        tenants={[{ id: "tenant-a", label: "Organização A" }]}
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Registrar solicitação local" }),
    ).toBeNull();
    expect(screen.getByText(/capability explícita/i)).toBeVisible();
  });

  it("monta o ensaio somente no contexto de homologação autorizado", () => {
    const port = canaryPort();
    const view = render(
      <DashboardPage
        environment="homologation"
        establishmentManagement="available"
        establishments={establishments}
        homologationCanaryPort={port}
        onLogout={vi.fn()}
        route="compliance"
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Ensaio de homologação RENAVE" }),
    ).toBeVisible();

    view.rerender(
      <DashboardPage
        environment="development"
        establishmentManagement="available"
        establishments={establishments}
        homologationCanaryPort={port}
        onLogout={vi.fn()}
        route="compliance"
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Ensaio de homologação RENAVE" }),
    ).toBeNull();

    view.rerender(
      <DashboardPage
        environment="homologation"
        establishmentManagement="mfa_required"
        establishments={establishments}
        homologationCanaryPort={port}
        onLogout={vi.fn()}
        route="compliance"
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Ensaio de homologação RENAVE" }),
    ).toBeNull();
  });

  it("limpa o fixture quando muda a seleção ativa", () => {
    const port = canaryPort();
    const view = render(
      <DashboardPage
        environment="homologation"
        establishmentManagement="available"
        establishments={establishments}
        homologationCanaryPort={port}
        onLogout={vi.fn()}
        route="compliance"
        selectedEstablishmentId="store-belem"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );
    const plate = screen.getByRole("textbox", { name: "Placa sintética" });
    const confirmation = screen.getByRole("checkbox");
    fireEvent.change(plate, { target: { value: "ABC1D23" } });
    fireEvent.click(confirmation);
    expect(
      screen.getByRole("button", { name: "Executar uma vez" }),
    ).toBeEnabled();

    view.rerender(
      <DashboardPage
        environment="homologation"
        establishmentManagement="available"
        establishments={establishments}
        homologationCanaryPort={port}
        onLogout={vi.fn()}
        route="compliance"
        selectedEstablishmentId="store-ananindeua"
        selectedTenantId="tenant-a"
        userDisplayName="Operador"
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Placa sintética" }),
    ).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Executar uma vez" }),
    ).toBeDisabled();
  });
});
