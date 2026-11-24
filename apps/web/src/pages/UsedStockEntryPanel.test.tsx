import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StockEntryCreationClientError,
  type CreateStockEntryInput,
  type CreateStockEntryResult,
} from "../App.js";
import {
  businessDateInSaoPaulo,
  localDateTimeWithOffset,
  UsedStockEntryPanel,
} from "./UsedStockEntryPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const clock = () => new Date(2026, 10, 24, 12, 0, 0, 0);

const created: CreateStockEntryResult = {
  createdAt: "2026-11-24T15:00:00.000Z",
  operationId: "11111111-1111-4111-8111-111111111111",
  replayed: false,
  status: "HELD_LOCAL",
};

function fillValidForm() {
  fireEvent.change(screen.getByLabelText("Data da compra"), {
    target: { value: "2026-11-23" },
  });
  fireEvent.change(screen.getByLabelText("E-mail do vendedor"), {
    target: { value: "vendedor@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Valor da compra"), {
    target: { value: "55000.50" },
  });
  fireEvent.change(screen.getByLabelText("Placa"), {
    target: { value: "ABC1D23" },
  });
  fireEvent.change(screen.getByLabelText("Código de segurança do CRV"), {
    target: { value: "12345678901" },
  });
  fireEvent.change(screen.getByLabelText("Número do CRV (opcional)"), {
    target: { value: "123456789012" },
  });
  fireEvent.change(screen.getByLabelText("RENAVAM (opcional)"), {
    target: { value: "12345678901" },
  });
  fireEvent.change(screen.getByLabelText("Número do documento, sem máscara"), {
    target: { value: "12345678901" },
  });
  fireEvent.change(screen.getByLabelText("Quilometragem do hodômetro"), {
    target: { value: "12345" },
  });
  fireEvent.change(screen.getByLabelText("Data e hora da medição"), {
    target: { value: "2026-11-24T10:30" },
  });
}

function renderAvailable(
  onCreate: (input: CreateStockEntryInput) => Promise<CreateStockEntryResult>,
  currentClock = clock,
) {
  return render(
    <UsedStockEntryPanel
      available
      clock={currentClock}
      onCreate={onCreate}
      selectionKey="tenant-a:store-a"
    />,
  );
}

describe("UsedStockEntryPanel", () => {
  it("não monta o formulário enquanto a capability explícita está bloqueada", () => {
    const onCreate = vi.fn();
    render(
      <UsedStockEntryPanel
        available={false}
        clock={clock}
        onCreate={onCreate}
        selectionKey="tenant-a:store-a"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /capability explícita/i,
    );
    expect(screen.queryByRole("form")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Registrar solicitação local" }),
    ).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("envia somente dados comerciais, do vendedor e do veículo", async () => {
    const onCreate = vi.fn<
      (input: CreateStockEntryInput) => Promise<CreateStockEntryResult>
    >(async () => created);
    renderAvailable(onCreate);
    fillValidForm();

    const button = screen.getByRole("button", {
      name: "Registrar solicitação local",
    });
    expect(button).toHaveAttribute("type", "submit");
    fireEvent.submit(button.closest("form")!);

    expect(
      await screen.findByText(/solicitação local registrada/i),
    ).toBeVisible();
    expect(onCreate).toHaveBeenCalledOnce();
    const input = onCreate.mock.calls[0]![0];
    expect(input.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(input.veiculo.dataHoraMedicaoHodometro).toMatch(
      /^2026-11-24T10:30:00[+-]\d{2}:\d{2}$/u,
    );
    expect(input).toMatchObject({
      dataCompra: "2026-11-23",
      emailVendedor: "vendedor@example.com",
      valorCompra: 55_000.5,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        documentoProprietarioAtual: "12345678901",
        numeroCrv: "123456789012",
        placa: "ABC1D23",
        quilometragemHodometro: 12_345,
        renavam: "12345678901",
        tipoCrv: "DIGITAL",
        tipoDocumentoProprietarioAtual: "CPF",
      },
    });
    expect(JSON.stringify(input)).not.toMatch(
      /cpfOperadorResponsavel|emailEstabelecimento/u,
    );
  });

  it.each([
    new StockEntryCreationClientError(0, "NETWORK_ERROR"),
    new StockEntryCreationClientError(0, "INVALID_RESPONSE"),
    new StockEntryCreationClientError(429, "STOCK_ENTRY_RATE_LIMITED"),
    new StockEntryCreationClientError(500, "UPSTREAM_FAILURE"),
    new StockEntryCreationClientError(503, "SERVICE_UNAVAILABLE"),
  ])("preserva a chave no retry após um desfecho incerto", async (failure) => {
    const onCreate = vi
      .fn<(input: CreateStockEntryInput) => Promise<CreateStockEntryResult>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(created);
    renderAvailable(onCreate);
    fillValidForm();

    const form = screen
      .getByRole("button", { name: "Registrar solicitação local" })
      .closest("form")!;
    fireEvent.submit(form);
    await screen.findByRole("alert");
    fireEvent.submit(form);
    await screen.findByText(/solicitação local registrada/i);

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]![0].idempotencyKey).toBe(
      onCreate.mock.calls[0]![0].idempotencyKey,
    );
  });

  it("gera outra chave quando o usuário edita os dados após uma falha", async () => {
    const onCreate = vi
      .fn<(input: CreateStockEntryInput) => Promise<CreateStockEntryResult>>()
      .mockRejectedValueOnce(
        new StockEntryCreationClientError(0, "NETWORK_ERROR"),
      )
      .mockResolvedValueOnce(created);
    renderAvailable(onCreate);
    fillValidForm();
    const form = screen
      .getByRole("button", { name: "Registrar solicitação local" })
      .closest("form")!;

    fireEvent.submit(form);
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Valor da compra"), {
      target: { value: "56000" },
    });
    fireEvent.submit(form);
    await screen.findByText(/solicitação local registrada/i);

    expect(onCreate.mock.calls[1]![0].idempotencyKey).not.toBe(
      onCreate.mock.calls[0]![0].idempotencyKey,
    );
  });

  it("comunica replay idempotente sem expor identificadores internos", async () => {
    const onCreate = vi.fn(async () => ({ ...created, replayed: true }));
    renderAvailable(onCreate);
    fillValidForm();

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar solicitação local" })
        .closest("form")!,
    );

    expect(
      await screen.findByText(/já estava registrada e foi recuperada/i),
    ).toBeVisible();
    expect(screen.queryByText(created.operationId)).toBeNull();
  });

  it("congela todos os campos enquanto a tentativa está pendente", async () => {
    let reject!: (error: unknown) => void;
    const onCreate = vi.fn(
      () =>
        new Promise<CreateStockEntryResult>((_resolve, nextReject) => {
          reject = nextReject;
        }),
    );
    renderAvailable(onCreate);
    fillValidForm();
    const plate = screen.getByLabelText("Placa");

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar solicitação local" })
        .closest("form")!,
    );

    for (const group of screen.getAllByRole("group")) {
      expect(group).toBeDisabled();
    }
    expect(plate).toBeDisabled();
    expect(screen.getByLabelText("Valor da compra")).toBeDisabled();
    fireEvent.change(plate, { target: { value: "XYZ9Z99" } });
    expect(plate).toHaveValue("ABC1D23");
    expect(screen.getByLabelText("E-mail do vendedor")).toHaveValue(
      "vendedor@example.com",
    );

    reject(new StockEntryCreationClientError(0, "NETWORK_ERROR"));
    await screen.findByRole("alert");
    expect(plate).toBeEnabled();
    expect(plate).toHaveValue("ABC1D23");
    expect(screen.getByLabelText("E-mail do vendedor")).toHaveValue(
      "vendedor@example.com",
    );
  });

  it.each([
    [
      new StockEntryCreationClientError(
        503,
        "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE",
      ),
      /identidade verificada.*indisponível/i,
    ],
    [
      new StockEntryCreationClientError(409, "STOCK_ENTRY_OPERATION_CONFLICT"),
      /dados diferem de uma tentativa anterior/i,
    ],
  ])(
    "prioriza feedback seguro para códigos reais da API",
    async (error, text) => {
      const onCreate = vi.fn(async () => Promise.reject(error));
      renderAvailable(onCreate);
      fillValidForm();

      fireEvent.submit(
        screen
          .getByRole("button", { name: "Registrar solicitação local" })
          .closest("form")!,
      );

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert).not.toHaveTextContent(/detalhe|stack|cnpj|cpf/i);
    },
  );

  it("aplica os limites do contrato antes de chamar a API", () => {
    const onCreate = vi.fn(async () => created);
    renderAvailable(onCreate);
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Valor da compra"), {
      target: { value: "100000000" },
    });
    fireEvent.change(screen.getByLabelText("Quilometragem do hodômetro"), {
      target: { value: "2147483648" },
    });
    fireEvent.change(screen.getByLabelText("Código de segurança do CRV"), {
      target: { value: "123" },
    });
    fireEvent.change(screen.getByLabelText("Número do CRV (opcional)"), {
      target: { value: "123" },
    });

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar solicitação local" })
        .closest("form")!,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/revise os campos/i);
    expect(screen.getByText(/até R\$ 99\.999\.999,99/i)).toBeVisible();
    expect(screen.getByText(/2\.147\.483\.647/i)).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("ignora a resposta pendente depois da troca de estabelecimento", async () => {
    let resolve!: (value: CreateStockEntryResult) => void;
    const onCreate = vi.fn(
      () =>
        new Promise<CreateStockEntryResult>((next) => {
          resolve = next;
        }),
    );
    const view = renderAvailable(onCreate);
    fillValidForm();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar solicitação local" })
        .closest("form")!,
    );
    expect(screen.getByRole("button")).toBeDisabled();

    view.rerender(
      <UsedStockEntryPanel
        available
        clock={clock}
        onCreate={onCreate}
        selectionKey="tenant-a:store-b"
      />,
    );
    resolve(created);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText(/solicitação local registrada/i)).toBeNull();
    expect(screen.getByLabelText("Placa")).toHaveValue("");
  });

  it("converte datetime-local para um instante com offset explícito", () => {
    const converted = localDateTimeWithOffset("2026-11-24T10:30");
    expect(converted).toMatch(/^2026-11-24T10:30:00[+-]\d{2}:\d{2}$/u);
    expect(localDateTimeWithOffset("2026-02-30T10:30")).toBeNull();
  });

  it("calcula a data comercial na virada de Brasília, não na virada UTC", () => {
    expect(businessDateInSaoPaulo(new Date("2026-11-25T02:59:59.999Z"))).toBe(
      "2026-11-24",
    );
    expect(businessDateInSaoPaulo(new Date("2026-11-25T03:00:00.000Z"))).toBe(
      "2026-11-25",
    );
  });

  it("recusa compra do dia UTC seguinte antes da virada comercial", () => {
    const onCreate = vi.fn(async () => created);
    renderAvailable(onCreate, () => new Date("2026-11-25T02:59:59.999Z"));
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Data da compra"), {
      target: { value: "2026-11-25" },
    });

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar solicitação local" })
        .closest("form")!,
    );

    expect(
      screen.getByText(/data da compra não pode estar no futuro/i),
    ).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
