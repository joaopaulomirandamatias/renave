import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EstablishmentCreationClientError } from "../App.js";
import { EstablishmentCreationPanel } from "./EstablishmentCreationPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fill(cnpj = "11.222.333/0001-81", tradeName = "Loja Centro") {
  fireEvent.change(screen.getByLabelText("CNPJ"), {
    target: { value: cnpj },
  });
  fireEvent.change(screen.getByLabelText("Nome comercial"), {
    target: { value: tradeName },
  });
}

function result(tradeName = "Loja Centro") {
  return {
    establishment: {
      id: "33333333-3333-4333-8333-333333333333",
      tradeName,
    },
    renaveLink: { status: "not_started" as const },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("EstablishmentCreationPanel", () => {
  it("não expõe gestão negada e orienta step-up sem executar POST", () => {
    const onCreate = vi.fn();
    const denied = render(
      <EstablishmentCreationPanel
        capability="denied"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Cadastrar estabelecimento" }),
    ).toBeNull();

    denied.rerender(
      <EstablishmentCreationPanel
        capability="mfa_required"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    expect(
      screen.getByRole("link", { name: "Confirmar acesso corporativo" }),
    ).toHaveAttribute("href", "/api/auth/login");
    expect(screen.queryByLabelText("CNPJ")).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("valida campos, associa mensagens e foca o primeiro erro", () => {
    render(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={vi.fn()}
        selectionKey="tenant-a"
      />,
    );
    const cnpj = screen.getByLabelText("CNPJ");
    const tradeName = screen.getByLabelText("Nome comercial");
    expect(cnpj).toHaveAttribute("maxlength", "32");
    expect(tradeName).toHaveAttribute("maxlength", "160");

    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Revise os campos destacados",
    );
    expect(cnpj).toHaveAttribute("aria-invalid", "true");
    expect(tradeName).toHaveAttribute("aria-invalid", "true");
    expect(cnpj).toHaveFocus();
  });

  it("bloqueia clique duplo, usa UUID e anuncia sucesso sem criar vínculo", async () => {
    const pending = deferred<ReturnType<typeof result>>();
    const onCreate = vi.fn(() => pending.promise);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    render(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    fill();
    const form = screen
      .getByRole("button", { name: "Cadastrar estabelecimento" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      cnpj: "11.222.333/0001-81",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      tradeName: "Loja Centro",
    });
    expect(screen.getByRole("button", { name: "Cadastrando…" })).toBeDisabled();

    pending.resolve(result());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "foi cadastrado e selecionado",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "vínculo RENAVE ainda não foi iniciado",
    );
    expect(screen.getByLabelText("CNPJ")).toHaveValue("");
  });

  it("reutiliza a chave no retry transitório e gera outra após edição", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new EstablishmentCreationClientError(
          503,
          "TENANT_ADMINISTRATION_UNAVAILABLE",
        ),
      )
      .mockRejectedValueOnce(
        new EstablishmentCreationClientError(
          409,
          "ESTABLISHMENT_CNPJ_CONFLICT",
        ),
      )
      .mockResolvedValueOnce(result("Loja Centro 2"));
    render(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    fill();
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "temporariamente indisponível",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Já existe um estabelecimento",
    );
    expect(onCreate.mock.calls[0]?.[0].idempotencyKey).toBe(
      onCreate.mock.calls[1]?.[0].idempotencyKey,
    );

    fireEvent.change(screen.getByLabelText("Nome comercial"), {
      target: { value: "Loja Centro 2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );
    await screen.findByRole("status");
    expect(onCreate.mock.calls[2]?.[0].idempotencyKey).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("respeita Retry-After sem reenvio automático", async () => {
    const onCreate = vi.fn(async () => {
      throw new EstablishmentCreationClientError(
        429,
        "TENANT_MUTATION_RATE_LIMITED",
        17,
      );
    });
    render(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    fill();
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Aguarde 17 segundos",
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("CNPJ")).toHaveValue("11.222.333/0001-81");
  });

  it("ignora completamente uma resposta obsoleta após troca de tenant", async () => {
    const creation = deferred<ReturnType<typeof result>>();
    const onCreate = vi.fn(() => creation.promise);
    const view = render(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={onCreate}
        selectionKey="tenant-a"
      />,
    );
    fill();
    fireEvent.click(
      screen.getByRole("button", { name: "Cadastrar estabelecimento" }),
    );

    view.rerender(
      <EstablishmentCreationPanel
        capability="available"
        onCreate={onCreate}
        selectionKey="tenant-b"
      />,
    );
    creation.reject(new EstablishmentCreationClientError(0, "CONTEXT_CHANGED"));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("CNPJ")).toHaveValue("");
  });
});
