import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserRenaveReadiness } from "../App.js";
import {
  AttentionPanel,
  type AttentionState,
  deriveAttentionItems,
} from "./AttentionPanel.js";

afterEach(cleanup);

const ready: BrowserRenaveReadiness = {
  certificate: "ready",
  environment: "homologation",
  establishmentContact: "verified",
  integration: "configured",
  link: "enabled",
  mutations: "blocked",
  operatorIdentity: "verified",
  queries: "ready",
};

function state(overrides: Partial<AttentionState> = {}): AttentionState {
  return {
    canCreateEstablishment: false,
    canReloadLinkStatus: false,
    contextError: false,
    contextLoading: false,
    establishmentManagement: "denied",
    hasEstablishment: true,
    linkStatus: "enabled",
    linkStatusError: false,
    linkStatusLoading: false,
    preflightAvailable: false,
    readiness: ready,
    readinessError: false,
    readinessLoading: false,
    ...overrides,
  };
}

describe("deriveAttentionItems", () => {
  it("só conclui ausência de pendência quando consultas e vínculo estão comprovadamente prontos", () => {
    expect(deriveAttentionItems(state())).toEqual([
      expect.objectContaining({
        id: "queries-ready",
        tone: "complete",
      }),
    ]);

    expect(
      deriveAttentionItems(
        state({ readiness: { ...ready, queries: "blocked" } }),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "unknown-blocker",
        tone: "attention",
      }),
    ]);
  });

  it.each([
    ["enabled", "pending"],
    ["pending", "enabled"],
    ["confirmed", "rejected"],
  ] as const)(
    "falha fechado quando vínculo carregado %s diverge da prontidão %s",
    (linkStatus, readinessLink) => {
      const items = deriveAttentionItems(
        state({
          linkStatus,
          readiness: {
            ...ready,
            link: readinessLink,
            queries: "ready",
          },
        }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          id: "link-state-divergence",
          tone: "attention",
        }),
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ id: "queries-ready" }),
      );
    },
  );

  it.each([
    ["carregamento do contexto", { contextLoading: true }, "context-loading"],
    ["falha do contexto", { contextError: true }, "context-error"],
    [
      "carregamento da prontidão",
      { readinessLoading: true },
      "readiness-loading",
    ],
    ["falha da prontidão", { readinessError: true }, "readiness-error"],
    ["carregamento do vínculo", { linkStatusLoading: true }, "link-loading"],
    ["falha do vínculo", { linkStatusError: true }, "link-error"],
  ] satisfies ReadonlyArray<
    readonly [string, Partial<AttentionState>, string]
  >)("não transforma %s em um vazio definitivo", (_label, change, id) => {
    expect(deriveAttentionItems(state(change))).toContainEqual(
      expect.objectContaining({ id }),
    );
    expect(deriveAttentionItems(state(change))).not.toContainEqual(
      expect.objectContaining({ id: "queries-ready" }),
    );
  });

  it("trata prontidão e vínculo realmente ausentes como estados inconclusivos", () => {
    const { readiness: _readiness, ...withoutReadiness } = state();
    expect(deriveAttentionItems(withoutReadiness)).toContainEqual(
      expect.objectContaining({ id: "readiness-missing" }),
    );

    const { linkStatus: _linkStatus, ...withoutLink } = state();
    expect(deriveAttentionItems(withoutLink)).toContainEqual(
      expect.objectContaining({ id: "link-missing" }),
    );
  });

  it.each([
    ["available", true, "establishment-missing", "create-establishment"],
    ["mfa_required", true, "establishment-mfa", "confirm-access"],
    ["denied", false, "establishment-denied", undefined],
  ] satisfies ReadonlyArray<
    readonly [
      AttentionState["establishmentManagement"],
      boolean,
      string,
      string | undefined,
    ]
  >)(
    "orienta ausência de estabelecimento com capability %s",
    (capability, canCreate, id, action) => {
      const [item] = deriveAttentionItems(
        state({
          canCreateEstablishment: canCreate,
          establishmentManagement: capability,
          hasEstablishment: false,
        }),
      );
      expect(item).toEqual(expect.objectContaining({ id }));
      if (action) expect(item).toEqual(expect.objectContaining({ action }));
      else expect(item).not.toHaveProperty("action");
    },
  );

  it.each([
    [
      {
        ...ready,
        integration: "disabled" as const,
        queries: "blocked" as const,
      },
      "integration-disabled",
    ],
    [
      {
        ...ready,
        certificate: "blocked" as const,
        queries: "blocked" as const,
      },
      "certificate-blocked",
    ],
    [{ ...ready, certificate: "warning" as const }, "certificate-warning"],
    [
      {
        ...ready,
        operatorIdentity: "pending" as const,
        queries: "blocked" as const,
      },
      "operator-identity",
    ],
    [
      {
        ...ready,
        establishmentContact: "unavailable" as const,
        queries: "blocked" as const,
      },
      "establishment-contact",
    ],
  ])(
    "explica cada gate de prontidão sem inferir autorização",
    (readiness, id) => {
      expect(deriveAttentionItems(state({ readiness }))).toContainEqual(
        expect.objectContaining({ id }),
      );
    },
  );

  it.each([
    ["missing", "blocked", /sem cadastro verificado/i],
    ["pending", "waiting", /aguardando verificação/i],
    ["suspended", "blocked", /verificação suspensa/i],
    ["unavailable", "attention", /indisponível/i],
  ] as const)(
    "distingue perfil %s sem criar ação inexistente",
    (profileStatus, tone, cause) => {
      const items = deriveAttentionItems(
        state({
          readiness: {
            ...ready,
            operatorIdentity: profileStatus,
          },
        }),
      );
      const item = items.find(({ id }) => id === "operator-identity");
      expect(item).toEqual(expect.objectContaining({ tone }));
      expect(item?.cause).toMatch(cause);
      expect(item).not.toHaveProperty("action");
      expect(items).not.toContainEqual(
        expect.objectContaining({ id: "queries-ready" }),
      );
    },
  );

  it("não cria pendência para perfil verificado", () => {
    expect(deriveAttentionItems(state())).not.toContainEqual(
      expect.objectContaining({ id: "operator-identity" }),
    );
  });

  it.each([
    ["not_started", "link-not-started"],
    ["pending", "link-pending"],
    ["rejected", "link-review"],
    ["deactivated", "link-review"],
  ] as const)("explica o vínculo %s", (linkStatus, id) => {
    expect(
      deriveAttentionItems(
        state({
          linkStatus,
          readiness: { ...ready, link: linkStatus, queries: "blocked" },
        }),
      ),
    ).toContainEqual(expect.objectContaining({ id }));
  });
});

describe("AttentionPanel", () => {
  it("expõe região nomeada e estrutura causa, impacto e próxima ação", () => {
    render(<AttentionPanel {...state({ readinessError: true })} />);

    const panel = screen.getByRole("region", {
      name: "O que precisa da sua atenção agora",
    });
    expect(panel).toHaveTextContent("Prontidão da integração indisponível");
    expect(panel).toHaveTextContent("Impacto:");
    expect(panel).toHaveTextContent("Próxima ação:");
  });

  it("só renderiza a recarga quando a capability e o callback correspondentes existem", () => {
    const onReloadLinkStatus = vi.fn();
    const view = render(
      <AttentionPanel
        {...state({
          canReloadLinkStatus: true,
          linkStatusError: true,
        })}
        onReloadLinkStatus={onReloadLinkStatus}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Carregar vínculo novamente" }),
    );
    expect(onReloadLinkStatus).toHaveBeenCalledOnce();

    view.rerender(
      <AttentionPanel
        {...state({
          linkStatus: "not_started",
          preflightAvailable: true,
          readiness: {
            ...ready,
            link: "not_started",
            queries: "blocked",
          },
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Verificar vínculo" }),
    ).toBeNull();
    expect(
      screen.getByText(/abra compliance.*verificar vínculo/i),
    ).toBeVisible();
  });

  it("navega para a configuração no cadastro e no step-up", () => {
    const view = render(
      <AttentionPanel
        {...state({
          canCreateEstablishment: true,
          establishmentManagement: "available",
          hasEstablishment: false,
        })}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Cadastrar estabelecimento" }),
    ).toHaveAttribute("href", "/configuracoes/estabelecimentos");

    view.rerender(
      <AttentionPanel
        {...state({
          canCreateEstablishment: true,
          establishmentManagement: "mfa_required",
          hasEstablishment: false,
        })}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Ir para confirmação de acesso" }),
    ).toHaveAttribute("href", "/configuracoes/estabelecimentos");
  });
});
