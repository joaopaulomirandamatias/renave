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
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(onRunPreflight).toHaveBeenCalledOnce();
  });

  it("só mostra consultas RENAVE com seleção e vínculo confirmado", () => {
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
});
