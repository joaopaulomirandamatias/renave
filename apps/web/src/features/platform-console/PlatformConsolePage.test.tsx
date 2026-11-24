import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PlatformConsoleClientError,
  type PlatformConsoleClient,
  type PlatformQueuePage,
} from "./client.js";
import { PlatformConsolePage } from "./PlatformConsolePage.js";

afterEach(cleanup);

const firstPage: PlatformQueuePage = {
  items: [
    {
      establishment: {
        id: "22222222-2222-4222-8222-222222222222",
        tradeName: "Loja Norte",
      },
      renaveLink: {
        status: "pending",
        updatedAt: "2026-11-24T12:34:56.000Z",
      },
      tenant: {
        displayName: "Grupo Norte",
        id: "11111111-1111-4111-8111-111111111111",
      },
    },
  ],
  nextCursor: `page_2.${"a".repeat(43)}`,
  truncated: true,
};

function setup(loadQueue: PlatformConsoleClient["loadQueue"]) {
  const client = {
    loadQueue: vi.fn(loadQueue),
  } satisfies PlatformConsoleClient;
  render(
    <PlatformConsolePage
      client={client}
      environment="homologation"
      onLogout={vi.fn()}
      userDisplayName="Operadora Global"
    />,
  );
  return client;
}

function submitTicket(ticket = "SEC-1234") {
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Chamado ou autorização da consulta",
    }),
    { target: { value: ticket } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Consultar fila" }));
}

describe("PlatformConsolePage", () => {
  it("valida o chamado localmente e o remove da interface após a consulta", async () => {
    const client = setup(async () => ({ items: [], truncated: false }));

    expect(
      screen.getByRole("textbox", {
        name: "Chamado ou autorização da consulta",
      }),
    ).not.toHaveAttribute("name");

    submitTicket("inválido");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Informe um chamado válido",
    );
    expect(client.loadQueue).not.toHaveBeenCalled();

    submitTicket("  SEC-1234  ");
    expect(client.loadQueue).toHaveBeenCalledWith(
      expect.objectContaining({ reasonTicket: "SEC-1234" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Nenhum vínculo encontrado" }),
    ).toBeVisible();
    expect(screen.queryByDisplayValue("SEC-1234")).toBeNull();
    expect(document.body).not.toHaveTextContent("SEC-1234");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Não há estabelecimentos",
    );
  });

  it("expõe uma região de carregamento e preserva a semântica da página", async () => {
    let resolve!: (page: PlatformQueuePage) => void;
    const pending = new Promise<PlatformQueuePage>((next) => {
      resolve = next;
    });
    setup(() => pending);

    expect(
      screen.getByRole("heading", { name: "Fila nacional de vínculos RENAVE" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Ir para o conteúdo principal" }),
    ).toHaveAttribute("href", "#platform-console-content");
    submitTicket();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Carregando a fila global",
    );
    expect(screen.getByRole("main")).toHaveAttribute(
      "id",
      "platform-console-content",
    );

    resolve({ items: [], truncated: false });
    await screen.findByRole("heading", { name: "Nenhum vínculo encontrado" });
  });

  it("pagina com o cursor opaco, mantém o motivo somente em memória e mescla resultados", async () => {
    const secondPage: PlatformQueuePage = {
      items: [
        {
          establishment: {
            id: "44444444-4444-4444-8444-444444444444",
            tradeName: "Loja Sul",
          },
          renaveLink: {
            status: "confirmed",
            updatedAt: "2026-11-24T13:34:56.000Z",
          },
          tenant: {
            displayName: "Grupo Sul",
            id: "33333333-3333-4333-8333-333333333333",
          },
        },
      ],
      truncated: false,
    };
    const client = setup(
      vi
        .fn<PlatformConsoleClient["loadQueue"]>()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    );

    submitTicket();
    const results = await screen.findByRole("region", {
      name: "1 vínculo carregado",
    });
    expect(within(results).getByText("Grupo Norte")).toBeVisible();
    fireEvent.click(
      within(results).getByRole("button", { name: "Carregar mais" }),
    );

    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
    expect(client.loadQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: firstPage.nextCursor,
        reasonTicket: "SEC-1234",
      }),
    );
    expect(await screen.findByText("Grupo Sul")).toBeVisible();
    expect(screen.getByText("Grupo Norte")).toBeVisible();
    expect(document.body).not.toHaveTextContent("SEC-1234");
  });

  it("mantém os dados e anuncia erro de paginação sem repetir automaticamente", async () => {
    const loadQueue = vi
      .fn<PlatformConsoleClient["loadQueue"]>()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(
        new PlatformConsoleClientError(503, "PLATFORM_CONSOLE_UNAVAILABLE"),
      );
    setup(loadQueue);

    submitTicket();
    expect(await screen.findByText("Loja Norte")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível carregar mais vínculos");
    expect(screen.getByText("Loja Norte")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadQueue).toHaveBeenCalledTimes(2);
  });

  it("remove a projeção carregada se a autorização for revogada entre páginas", async () => {
    const loadQueue = vi
      .fn<PlatformConsoleClient["loadQueue"]>()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(
        new PlatformConsoleClientError(404, "PLATFORM_RESOURCE_NOT_FOUND"),
      );
    setup(loadQueue);

    submitTicket();
    expect(await screen.findByText("Loja Norte")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Console global indisponível");
    expect(screen.queryByText("Loja Norte")).toBeNull();
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });

  it.each([
    [403, "MFA_RECENT_REQUIRED", "Confirmação adicional necessária"],
    [403, "ACCESS_DENIED", "Acesso global não autorizado"],
    [404, "NOT_FOUND", "Console global indisponível"],
    [429, "PLATFORM_CONSOLE_RATE_LIMITED", "Limite temporário atingido"],
    [
      503,
      "PLATFORM_CONSOLE_UNAVAILABLE",
      "Serviço temporariamente indisponível",
    ],
  ])(
    "traduz status %i/%s sem refletir detalhe remoto",
    async (status, code, title) => {
      setup(async () => {
        throw new PlatformConsoleClientError(
          status,
          code,
          status === 429 ? 37 : undefined,
        );
      });

      submitTicket();
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByRole("heading", { name: title })).toBeVisible();
      expect(alert).not.toHaveTextContent("SEC-1234");
      if (status === 429) {
        expect(alert).toHaveTextContent("Aguarde 37 segundos");
      }
      if (code === "MFA_RECENT_REQUIRED") {
        expect(
          within(alert).getByRole("link", { name: "Confirmar acesso seguro" }),
        ).toHaveAttribute(
          "href",
          "/api/auth/login?returnTo=%2Fplatform%2Frenave-link-queue",
        );
      }
    },
  );
});
