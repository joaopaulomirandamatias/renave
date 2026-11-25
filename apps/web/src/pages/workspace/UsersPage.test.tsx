import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantUsersResult } from "../../features/tenant-users/client.js";
import { UsersPage } from "./UsersPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const establishments = [
  { id: "22222222-2222-4222-8222-222222222222", label: "Matriz Belém" },
  { id: "33333333-3333-4333-8333-333333333333", label: "Filial Santos" },
];

describe("UsersPage", () => {
  it("renderiza tabela acessível com referência opaca, papel RBAC traduzido e escopo resolvido", async () => {
    const onLoad = vi.fn<(signal: AbortSignal) => Promise<TenantUsersResult>>(
      async () => ({
        items: [
          {
            active: true,
            createdAt: "2026-11-24T15:00:00.000Z",
            establishmentIds: [],
            memberId: "abcdef01-2345-5678-89ab-cdef01234567",
            role: "tenant_admin",
            status: "active",
          },
          {
            active: false,
            createdAt: "2026-11-20T12:00:00.000Z",
            establishmentIds: ["22222222-2222-4222-8222-222222222222"],
            memberId: "99887766-5544-5321-89ab-cdef01234567",
            role: "renave_operator",
            status: "suspended",
          },
          {
            active: true,
            createdAt: "2026-11-22T18:30:00.000Z",
            establishmentIds: [
              "22222222-2222-4222-8222-222222222222",
              "33333333-3333-4333-8333-333333333333",
            ],
            memberId: "11223344-5566-5789-89ab-cdef01234567",
            role: "compliance_auditor",
            status: "active",
          },
        ],
        status: "ready" as const,
      }),
    );

    render(
      <UsersPage
        establishments={establishments}
        onLoad={onLoad}
        selectionKey="tenant-a"
      />,
    );

    expect(await screen.findByText("ABCDEF01")).toBeVisible();
    expect(screen.getByText("99887766")).toBeVisible();
    expect(screen.getByText("11223344")).toBeVisible();
    expect(screen.getByText("Administrador da organização")).toBeVisible();
    expect(screen.getByText("Operador RENAVE")).toBeVisible();
    expect(screen.getByText("Auditor de conformidade")).toBeVisible();
    expect(screen.getByText("Todos os estabelecimentos")).toBeVisible();
    expect(screen.getByText("Matriz Belém")).toBeVisible();
    expect(screen.getByText("Matriz Belém, Filial Santos")).toBeVisible();
    expect(screen.getAllByText("Ativo")).toHaveLength(2);
    expect(screen.getByText("Inativo")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Usuários e perfis da organização" }),
    ).toBeVisible();
    expect(
      screen.getByText(/nunca exibe subject nem credenciais/i),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Atualizar usuários" }));
    expect(await screen.findByText("ABCDEF01")).toBeVisible();
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it("exibe estado vazio quando não há vínculos", async () => {
    render(
      <UsersPage
        establishments={establishments}
        onLoad={vi.fn(async () => ({ items: [], status: "ready" as const }))}
        selectionKey="tenant-a"
      />,
    );

    expect(
      await screen.findByText("Nenhum vínculo de usuário encontrado"),
    ).toBeVisible();
  });

  it("exibe aviso fail-closed distinguindo MFA pendente e acesso negado", async () => {
    const view = render(
      <UsersPage
        establishments={establishments}
        onLoad={vi.fn(async () => ({
          reason: "mfa_required" as const,
          status: "denied" as const,
        }))}
        selectionKey="tenant-a"
      />,
    );

    expect(
      await screen.findByText(/confirmação em duas etapas obrigatória/i),
    ).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();

    view.rerender(
      <UsersPage
        establishments={establishments}
        onLoad={vi.fn(async () => ({
          reason: "forbidden" as const,
          status: "denied" as const,
        }))}
        selectionKey="tenant-b"
      />,
    );

    expect(
      await screen.findByText(/acesso restrito a usuários e perfis/i),
    ).toBeVisible();
  });
});
