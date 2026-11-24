import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type SessionClient } from "./App.js";
import {
  PLATFORM_CONSOLE_PATH,
  type PlatformAccessClient,
  type PlatformAccessResult,
  type PlatformConsoleClient,
} from "./features/platform-console/index.js";

afterEach(cleanup);

function sessionClient(): SessionClient {
  return {
    load: vi.fn(async () => ({
      authenticated: true as const,
      authMode: "oidc" as const,
      environment: "homologation",
      expiresAt: "2026-11-24T18:00:00.000Z",
      user: { name: "Operadora Global" },
    })),
    loadTenants: vi.fn(async () => []),
  } as unknown as SessionClient;
}

function accessClient(
  result: PlatformAccessResult = { status: "authorized" },
): PlatformAccessClient {
  return { load: vi.fn(async () => result) };
}

describe("fronteira web do console global", () => {
  it.each([undefined, false])(
    "falha fechado quando a feature é %s sem autenticar nem consultar a API global",
    async (platformConsoleEnabled) => {
      const client = sessionClient();
      const platformClient = {
        loadQueue: vi.fn(),
      } as unknown as PlatformConsoleClient;
      const platformAccessClient = accessClient();

      render(
        <App
          client={client}
          locationPathname={PLATFORM_CONSOLE_PATH}
          platformAccessClient={platformAccessClient}
          platformConsoleClient={platformClient}
          {...(platformConsoleEnabled === undefined
            ? {}
            : { platformConsoleEnabled })}
        />,
      );

      expect(
        await screen.findByRole("heading", { name: "Página não encontrada" }),
      ).toBeVisible();
      expect(client.load).not.toHaveBeenCalled();
      expect(platformAccessClient.load).not.toHaveBeenCalled();
      expect(platformClient.loadQueue).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent("Operação global auditada");
      expect(document.body).not.toHaveTextContent(PLATFORM_CONSOLE_PATH);
    },
  );

  it("não consulta a capability antes de existir uma sessão autenticada", async () => {
    const client = {
      ...sessionClient(),
      load: vi.fn(async () => ({
        authenticated: false as const,
        authMode: "oidc" as const,
        environment: "homologation",
      })),
    } as unknown as SessionClient;
    const platformAccessClient = accessClient();

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={platformAccessClient}
        platformConsoleEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(platformAccessClient.load).not.toHaveBeenCalled();
    expect(client.loadTenants).not.toHaveBeenCalled();
  });

  it("abre o console para sessão global sem consultar diretório de tenants quando habilitado", async () => {
    const client = sessionClient();
    const platformClient = {
      loadQueue: vi.fn(),
    } as unknown as PlatformConsoleClient;
    const platformAccessClient = accessClient();

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={platformAccessClient}
        platformConsoleClient={platformClient}
        platformConsoleEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Fila nacional de vínculos RENAVE",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "Voltar ao painel" })).toBeNull();
    expect(client.load).toHaveBeenCalledOnce();
    expect(platformAccessClient.load).toHaveBeenCalledOnce();
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(platformClient.loadQueue).not.toHaveBeenCalled();
  });

  it("não pisca o console enquanto a capability está pendente", async () => {
    const client = sessionClient();
    let resolveAccess!: (value: PlatformAccessResult) => void;
    const pendingAccess = new Promise<PlatformAccessResult>((resolve) => {
      resolveAccess = resolve;
    });
    const platformAccessClient: PlatformAccessClient = {
      load: vi.fn(() => pendingAccess),
    };

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={platformAccessClient}
        platformConsoleEnabled
      />,
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Verificando autorização segura…",
    );
    expect(document.body).not.toHaveTextContent("Operação global auditada");
    expect(document.body).not.toHaveTextContent(
      "Fila nacional de vínculos RENAVE",
    );

    resolveAccess({ status: "authorized" });
    expect(
      await screen.findByRole("heading", {
        name: "Fila nacional de vínculos RENAVE",
      }),
    ).toBeVisible();
    expect(client.loadTenants).not.toHaveBeenCalled();
  });

  it("trata grant ausente como a mesma página inexistente", async () => {
    const client = sessionClient();
    const platformAccessClient = accessClient({ status: "not_found" });

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={platformAccessClient}
        platformConsoleEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeVisible();
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("Operação global auditada");
    expect(document.body).not.toHaveTextContent("console");
  });

  it.each(["MFA_REQUIRED", "MFA_RECENT_REQUIRED"] as const)(
    "mostra somente step-up mínimo para %s",
    async (code) => {
      const client = sessionClient();
      const platformAccessClient = accessClient({
        code,
        status: "mfa_required",
      });

      render(
        <App
          client={client}
          locationPathname={PLATFORM_CONSOLE_PATH}
          platformAccessClient={platformAccessClient}
          platformConsoleEnabled
        />,
      );

      expect(
        await screen.findByRole("heading", { name: "Confirme seu acesso" }),
      ).toBeVisible();
      expect(
        screen.getByRole("link", { name: "Confirmar acesso corporativo" }),
      ).toHaveAttribute(
        "href",
        `/api/auth/login?returnTo=${encodeURIComponent(PLATFORM_CONSOLE_PATH)}`,
      );
      expect(client.loadTenants).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent("Operação global auditada");
      expect(document.body).not.toHaveTextContent(
        "Fila nacional de vínculos RENAVE",
      );
    },
  );

  it("volta ao login sem revelar o console quando a sessão expirou entre as consultas", async () => {
    const client = sessionClient();

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={accessClient({ status: "auth_required" })}
        platformConsoleEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Entrar na sua conta" }),
    ).toBeVisible();
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("Operação global auditada");
  });

  it("falha fechado e permite repetir somente o preflight", async () => {
    const client = sessionClient();
    const platformAccessClient: PlatformAccessClient = {
      load: vi
        .fn<PlatformAccessClient["load"]>()
        .mockResolvedValueOnce({ status: "unavailable" })
        .mockResolvedValueOnce({ status: "authorized" }),
    };
    const platformClient = {
      loadQueue: vi.fn(),
    } as unknown as PlatformConsoleClient;

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
        platformAccessClient={platformAccessClient}
        platformConsoleClient={platformClient}
        platformConsoleEnabled
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Não foi possível verificar o acesso",
      }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("Operação global auditada");
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(platformClient.loadQueue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() =>
      expect(platformAccessClient.load).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Fila nacional de vínculos RENAVE",
      }),
    ).toBeVisible();
    expect(client.load).toHaveBeenCalledOnce();
  });
});
