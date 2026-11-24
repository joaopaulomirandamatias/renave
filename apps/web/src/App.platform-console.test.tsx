import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type SessionClient } from "./App.js";
import {
  PLATFORM_CONSOLE_PATH,
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

describe("fronteira web do console global", () => {
  it.each([undefined, false])(
    "falha fechado quando a feature é %s sem autenticar nem consultar a API global",
    async (platformConsoleEnabled) => {
      const client = sessionClient();
      const platformClient = {
        loadQueue: vi.fn(),
      } as unknown as PlatformConsoleClient;

      render(
        <App
          client={client}
          locationPathname={PLATFORM_CONSOLE_PATH}
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
      expect(platformClient.loadQueue).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent("Operação global auditada");
      expect(document.body).not.toHaveTextContent(PLATFORM_CONSOLE_PATH);
    },
  );

  it("abre o console para sessão global sem consultar diretório de tenants quando habilitado", async () => {
    const client = sessionClient();
    const platformClient = {
      loadQueue: vi.fn(),
    } as unknown as PlatformConsoleClient;

    render(
      <App
        client={client}
        locationPathname={PLATFORM_CONSOLE_PATH}
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
    expect(client.loadTenants).not.toHaveBeenCalled();
    expect(platformClient.loadQueue).not.toHaveBeenCalled();
  });
});
