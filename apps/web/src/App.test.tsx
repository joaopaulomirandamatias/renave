import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  type BrowserEstablishment,
  type BrowserSession,
  type BrowserTenant,
  type SessionClient,
} from "./App.js";

afterEach(cleanup);

function clientFor(
  session: BrowserSession,
  tenants: readonly BrowserTenant[] = [],
): SessionClient {
  return {
    load: vi.fn(async () => session),
    loadEstablishments: vi.fn(async () => []),
    loadRenaveLinkStatus: vi.fn(async () => ({
      preflightAvailable: false,
      status: "not_started" as const,
    })),
    loadTenants: vi.fn(async () => tenants),
    logout: vi.fn(async () => ({})),
    runRenaveLinkPreflight: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("App session boundary", () => {
  it("não mostra login nem painel enquanto verifica a sessão", () => {
    const client: SessionClient = {
      load: vi.fn(() => new Promise<BrowserSession>(() => undefined)),
      loadEstablishments: vi.fn(async () => []),
      loadRenaveLinkStatus: vi.fn(async () => ({
        preflightAvailable: false,
        status: "not_started" as const,
      })),
      loadTenants: vi.fn(async () => []),
      logout: vi.fn(async () => ({})),
      runRenaveLinkPreflight: vi.fn(async () => undefined),
    };
    render(<App client={client} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Verificando sua sessão segura",
    );
    expect(screen.queryByText("Entrar na sua conta")).toBeNull();
    expect(screen.queryByText("Visão operacional")).toBeNull();
  });

  it("mostra login somente quando a sessão não está autenticada", async () => {
    render(
      <App
        client={clientFor({
          authenticated: false,
          authMode: "oidc",
          environment: "homologation",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ambiente: Homologação",
    );
  });

  it("abre painel protegido sem conceder estabelecimento por claim do IdP", async () => {
    render(
      <App
        client={clientFor(
          {
            authenticated: true,
            authMode: "oidc",
            environment: "homologation",
            expiresAt: "2026-11-24T00:00:00.000Z",
            user: { name: "Operadora" },
          },
          [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
        )}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Olá, Operadora" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toBeDisabled();
    expect(screen.getByRole("option")).toHaveTextContent(
      "Nenhum estabelecimento disponível",
    );
  });

  it("explica acesso ainda não vinculado sem mostrar navegação operacional", async () => {
    render(
      <App
        client={clientFor({
          authenticated: true,
          authMode: "oidc",
          environment: "homologation",
          expiresAt: "2026-11-24T00:00:00.000Z",
          user: { name: "Operadora" },
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Seu acesso ainda não está vinculado a uma organização",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Visão operacional")).toBeNull();
  });

  it("permite alternar explicitamente entre várias organizações", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [
        { displayName: "Revenda Norte", tenantId: "tenant-a" },
        { displayName: "Revenda Sul", tenantId: "tenant-b" },
      ],
    );
    vi.mocked(client.loadEstablishments).mockImplementation(async (tenantId) =>
      tenantId === "tenant-b"
        ? [{ id: "store-b", tradeName: "Loja Sul" }]
        : [{ id: "store-a", tradeName: "Loja Norte" }],
    );
    render(<App client={client} />);

    const selector = await screen.findByRole("combobox", {
      name: "Organização ativa",
    });
    fireEvent.change(selector, { target: { value: "tenant-b" } });
    expect(selector).toHaveValue("tenant-b");
    expect(screen.getAllByText("Revenda Sul")).toHaveLength(2);
    expect(
      await screen.findByRole("option", { name: "Loja Sul" }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: "Loja Norte" })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
    ).toBeEnabled();
  });

  it("descarta estabelecimentos de uma resposta atrasada do tenant anterior", async () => {
    const lateSouth = deferred<readonly BrowserEstablishment[]>();
    const currentNorth = deferred<readonly BrowserEstablishment[]>();
    let northCalls = 0;
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [
        { displayName: "Revenda Norte", tenantId: "tenant-a" },
        { displayName: "Revenda Sul", tenantId: "tenant-b" },
      ],
    );
    vi.mocked(client.loadEstablishments).mockImplementation((tenantId) => {
      if (tenantId === "tenant-b") return lateSouth.promise;
      northCalls += 1;
      return northCalls === 1
        ? Promise.resolve([{ id: "store-a", tradeName: "Loja Norte" }])
        : currentNorth.promise;
    });
    render(<App client={client} />);

    const selector = await screen.findByRole("combobox", {
      name: "Organização ativa",
    });
    fireEvent.change(selector, { target: { value: "tenant-b" } });
    fireEvent.change(selector, { target: { value: "tenant-a" } });
    currentNorth.resolve([{ id: "store-a2", tradeName: "Loja Norte 2" }]);
    expect(
      await screen.findByRole("option", { name: "Loja Norte 2" }),
    ).toBeVisible();

    lateSouth.resolve([{ id: "store-b", tradeName: "Loja Sul atrasada" }]);
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Loja Sul atrasada" }),
      ).toBeNull(),
    );
  });

  it("encerra por callback POST e remove o painel localmente", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "development",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    const redirect = vi.fn();
    vi.mocked(client.logout).mockResolvedValue({
      endSessionUrl: "https://id.example/logout",
    });
    render(<App client={client} redirect={redirect} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));

    await waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(redirect).toHaveBeenCalledWith("https://id.example/logout");
  });

  it("recarrega o estado autoritativo após confirmar o vínculo", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: { name: "Operadora" },
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja Norte" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "enabled",
      });
    render(<App client={client} />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    await waitFor(() =>
      expect(client.runRenaveLinkPreflight).toHaveBeenCalledWith(
        "tenant-a",
        "store-a",
      ),
    );
    expect(await screen.findByText("Habilitado")).toBeVisible();
  });

  it("ignora resposta atrasada do vínculo da loja anterior", async () => {
    const oldLink = deferred<{
      preflightAvailable: boolean;
      status: "rejected";
    }>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja A" },
      { id: "store-b", tradeName: "Loja B" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus).mockImplementation(
      async (_tenantId, establishmentId) =>
        establishmentId === "store-a"
          ? oldLink.promise
          : { preflightAvailable: true, status: "confirmed" },
    );
    render(<App client={client} />);

    const establishment = await screen.findByRole("combobox", {
      name: "Estabelecimento ativo",
    });
    fireEvent.change(establishment, { target: { value: "store-b" } });
    expect(await screen.findByText("Confirmado")).toBeVisible();

    oldLink.resolve({ preflightAvailable: true, status: "rejected" });
    await waitFor(() => expect(screen.queryByText("Rejeitado")).toBeNull());
  });

  it("preserva o estado e permite repetir quando o preflight falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja A" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "pending",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      });
    vi.mocked(client.runRenaveLinkPreflight)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce(undefined);
    render(<App client={client} />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /a verificação não foi concluída/i,
    );
    expect(screen.getByText("Pendente")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByText("Confirmado")).toBeVisible();
    expect(client.runRenaveLinkPreflight).toHaveBeenCalledTimes(2);
  });

  it("recarrega a rejeição autoritativa mesmo quando o POST falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja A" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus)
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      })
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "rejected",
      });
    vi.mocked(client.runRenaveLinkPreflight).mockRejectedValueOnce(
      new Error("identity mismatch"),
    );
    render(<App client={client} />);

    expect(await screen.findByText("Confirmado")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    expect(await screen.findByText("Rejeitado")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /a verificação não foi concluída/i,
    );
  });

  it("permite recarregar o vínculo quando a leitura falha", async () => {
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja A" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce({
        preflightAvailable: true,
        status: "confirmed",
      });
    render(<App client={client} />);

    const retry = await screen.findByRole("button", {
      name: "Tentar carregar vínculo",
    });
    expect(retry).not.toHaveAccessibleDescription(/exige configuração/i);
    fireEvent.click(retry);
    expect(await screen.findByText("Confirmado")).toBeVisible();
    expect(client.loadRenaveLinkStatus).toHaveBeenCalledTimes(2);
  });

  it("não transfere o spinner do preflight para outra loja", async () => {
    const pendingPreflight = deferred<void>();
    const client = clientFor(
      {
        authenticated: true,
        authMode: "oidc",
        environment: "homologation",
        expiresAt: "2026-11-24T00:00:00.000Z",
        user: {},
      },
      [{ displayName: "Revenda Norte", tenantId: "tenant-a" }],
    );
    vi.mocked(client.loadEstablishments).mockResolvedValue([
      { id: "store-a", tradeName: "Loja A" },
      { id: "store-b", tradeName: "Loja B" },
    ]);
    vi.mocked(client.loadRenaveLinkStatus).mockResolvedValue({
      preflightAvailable: true,
      status: "pending",
    });
    vi.mocked(client.runRenaveLinkPreflight).mockReturnValue(
      pendingPreflight.promise,
    );
    render(<App client={client} />);

    expect(await screen.findByText("Pendente")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Verificar vínculo" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Estabelecimento ativo" }),
      { target: { value: "store-b" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Verificar vínculo" }),
      ).not.toHaveAttribute("data-loading", "true"),
    );
    pendingPreflight.resolve(undefined);
    await waitFor(() => expect(screen.queryByText("Confirmado")).toBeNull());
  });

  it("distingue indisponibilidade de sessão e permite tentar novamente", async () => {
    const client = clientFor({
      authenticated: false,
      authMode: "oidc",
      environment: "development",
    });
    vi.mocked(client.load)
      .mockRejectedValueOnce(new Error("indisponível"))
      .mockResolvedValueOnce({
        authenticated: false,
        authMode: "oidc",
        environment: "development",
      });
    render(<App client={client} />);

    expect(
      await screen.findByRole("heading", {
        name: "Não foi possível verificar o acesso",
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(client.load).toHaveBeenCalledTimes(2);
  });
});
