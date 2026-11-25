import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StockExitCreationClientError,
  type CreateStockExitInput,
  type CreateStockExitResult,
} from "../App.js";
import { UsedStockExitPanel } from "./UsedStockExitPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const clock = () => new Date(2026, 10, 24, 12, 0, 0, 0);

const created: CreateStockExitResult = {
  createdAt: "2026-11-24T15:00:00.000Z",
  operationId: "22222222-2222-4222-8222-222222222222",
  replayed: false,
  status: "HELD_LOCAL",
};

function fillValidForm(options?: {
  complement?: string;
  confirm?: boolean;
  documentType?: "CPF" | "CNPJ";
  documentNumber?: string;
}) {
  const {
    complement = "Apto 42",
    confirm = true,
    documentType = "CPF",
    documentNumber = documentType === "CPF" ? "52998224725" : "11222333000181",
  } = options ?? {};

  fireEvent.change(screen.getByLabelText("Registro de estoque"), {
    target: { value: "71" },
  });
  fireEvent.change(screen.getByLabelText("Placa"), {
    target: { value: "ABC1D23" },
  });
  fireEvent.change(screen.getByLabelText("RENAVAM"), {
    target: { value: "12345678901" },
  });
  fireEvent.change(screen.getByLabelText("Número do CRV"), {
    target: { value: "123456789012" },
  });
  fireEvent.change(screen.getByLabelText("Código de segurança do CRV"), {
    target: { value: "12345678901" },
  });

  if (documentType !== "CPF") {
    fireEvent.change(screen.getByLabelText("Tipo de documento do comprador"), {
      target: { value: documentType },
    });
  }
  fireEvent.change(screen.getByLabelText("Número do documento, sem máscara"), {
    target: { value: documentNumber },
  });
  fireEvent.change(screen.getByLabelText("Nome completo"), {
    target: { value: "Juliana Ribeiro Matos" },
  });
  fireEvent.change(
    screen.getByLabelText("E-mail do comprador (recebe a ATPV-e para assinar)"),
    {
      target: { value: "juliana.matos@example.com" },
    },
  );

  fireEvent.change(screen.getByLabelText("CEP"), {
    target: { value: "01310100" },
  });
  fireEvent.change(screen.getByLabelText("Logradouro"), {
    target: { value: "Avenida Paulista" },
  });
  fireEvent.change(screen.getByLabelText("Número"), {
    target: { value: "1000" },
  });
  fireEvent.change(screen.getByLabelText("Complemento (opcional)"), {
    target: { value: complement },
  });
  fireEvent.change(screen.getByLabelText("Bairro"), {
    target: { value: "Bela Vista" },
  });
  fireEvent.change(screen.getByLabelText("Código do município (RENAVE)"), {
    target: { value: "3550308" },
  });

  fireEvent.change(screen.getByLabelText("Data da venda"), {
    target: { value: "2026-11-23" },
  });
  fireEvent.change(screen.getByLabelText("Valor da venda"), {
    target: { value: "131900.50" },
  });

  if (confirm) {
    fireEvent.click(
      screen.getByLabelText(
        /confirmo que conferi os dados do veículo, do comprador e da venda/i,
      ),
    );
  }
}

function renderAvailable(
  onCreate: (input: CreateStockExitInput) => Promise<CreateStockExitResult>,
  options?: {
    clock?: () => Date;
    initialPlate?: string;
    initialStockId?: number;
  },
) {
  return render(
    <UsedStockExitPanel
      available
      clock={options?.clock ?? clock}
      onCreate={onCreate}
      selectionKey="tenant-a:store-a"
      {...(options?.initialPlate ? { initialPlate: options.initialPlate } : {})}
      {...(options?.initialStockId !== undefined
        ? { initialStockId: options.initialStockId }
        : {})}
    />,
  );
}

describe("UsedStockExitPanel", () => {
  it("não monta o formulário enquanto a capability explícita está bloqueada", () => {
    const onCreate = vi.fn();
    render(
      <UsedStockExitPanel
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
      screen.queryByRole("button", { name: "Registrar saída local" }),
    ).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("pré-preenche registro de estoque e placa quando iniciado pela ficha do veículo", () => {
    renderAvailable(
      vi.fn(async () => created),
      {
        initialPlate: "QTP4H82",
        initialStockId: 912,
      },
    );

    expect(screen.getByLabelText("Registro de estoque")).toHaveValue("912");
    expect(screen.getByLabelText("Placa")).toHaveValue("QTP4H82");
  });

  it("exige confirmação reforçada antes de liberar o envio", () => {
    const onCreate = vi.fn(async () => created);
    renderAvailable(onCreate);
    fillValidForm({ confirm: false });

    const button = screen.getByRole("button", {
      name: "Registrar saída local",
    });
    expect(button).toBeDisabled();

    fireEvent.submit(button.closest("form")!);
    expect(screen.getByText(/confirme a conferência dos dados/i)).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("envia somente dados comerciais do veículo, comprador e venda", async () => {
    const onCreate = vi.fn<
      (input: CreateStockExitInput) => Promise<CreateStockExitResult>
    >(async () => created);
    renderAvailable(onCreate);
    fillValidForm();

    const button = screen.getByRole("button", {
      name: "Registrar saída local",
    });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("type", "submit");
    fireEvent.submit(button.closest("form")!);

    expect(
      await screen.findByText(/solicitação local de saída registrada/i),
    ).toBeVisible();
    expect(onCreate).toHaveBeenCalledOnce();
    const input = onCreate.mock.calls[0]![0];
    expect(input.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(input).toMatchObject({
      comprador: {
        email: "juliana.matos@example.com",
        endereco: {
          bairro: "Bela Vista",
          cep: "01310100",
          codigoMunicipio: 3550308,
          complemento: "Apto 42",
          logradouro: "Avenida Paulista",
          numero: "1000",
        },
        nome: "Juliana Ribeiro Matos",
        numeroDocumento: "52998224725",
        tipoDocumento: "CPF",
      },
      dataVenda: "2026-11-23",
      stockId: 71,
      valorVenda: 131_900.5,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        numeroCrv: "123456789012",
        placa: "ABC1D23",
        renavam: "12345678901",
      },
    });
    expect(JSON.stringify(input)).not.toMatch(
      /cpfOperadorResponsavel|emailEstabelecimento/u,
    );
  });

  it("aceita comprador pessoa jurídica (CNPJ) sem complemento", async () => {
    const onCreate = vi.fn<
      (input: CreateStockExitInput) => Promise<CreateStockExitResult>
    >(async () => created);
    renderAvailable(onCreate);
    fillValidForm({
      complement: "",
      documentNumber: "11222333000181",
      documentType: "CNPJ",
    });

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar saída local" })
        .closest("form")!,
    );

    expect(
      await screen.findByText(/solicitação local de saída registrada/i),
    ).toBeVisible();
    const input = onCreate.mock.calls[0]![0];
    expect(input.comprador.tipoDocumento).toBe("CNPJ");
    expect(input.comprador.numeroDocumento).toBe("11222333000181");
    expect("complemento" in input.comprador.endereco).toBe(false);
  });

  it.each([
    new StockExitCreationClientError(0, "NETWORK_ERROR"),
    new StockExitCreationClientError(0, "INVALID_RESPONSE"),
    new StockExitCreationClientError(429, "STOCK_EXIT_RATE_LIMITED", 30),
    new StockExitCreationClientError(500, "INTERNAL_ERROR"),
    new StockExitCreationClientError(503, "STOCK_EXIT_PREFLIGHT_UNAVAILABLE"),
  ])("preserva a chave no retry após um desfecho incerto", async (failure) => {
    const onCreate = vi
      .fn<(input: CreateStockExitInput) => Promise<CreateStockExitResult>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(created);
    renderAvailable(onCreate);
    fillValidForm();

    const form = screen
      .getByRole("button", { name: "Registrar saída local" })
      .closest("form")!;
    fireEvent.submit(form);
    await screen.findByRole("alert");
    fireEvent.submit(form);
    await screen.findByText(/solicitação local de saída registrada/i);

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]![0].idempotencyKey).toBe(
      onCreate.mock.calls[0]![0].idempotencyKey,
    );
  });

  it("gera outra chave quando o usuário edita os dados após uma falha", async () => {
    const onCreate = vi
      .fn<(input: CreateStockExitInput) => Promise<CreateStockExitResult>>()
      .mockRejectedValueOnce(
        new StockExitCreationClientError(0, "NETWORK_ERROR"),
      )
      .mockResolvedValueOnce(created);
    renderAvailable(onCreate);
    fillValidForm();
    const form = screen
      .getByRole("button", { name: "Registrar saída local" })
      .closest("form")!;

    fireEvent.submit(form);
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Valor da venda"), {
      target: { value: "132000" },
    });
    fireEvent.submit(form);
    await screen.findByText(/solicitação local de saída registrada/i);

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
        .getByRole("button", { name: "Registrar saída local" })
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
        new Promise<CreateStockExitResult>((_resolve, nextReject) => {
          reject = nextReject;
        }),
    );
    renderAvailable(onCreate);
    fillValidForm();
    const plate = screen.getByLabelText("Placa");

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar saída local" })
        .closest("form")!,
    );

    for (const group of screen.getAllByRole("group")) {
      expect(group).toBeDisabled();
    }
    expect(plate).toBeDisabled();
    expect(screen.getByLabelText("Valor da venda")).toBeDisabled();
    fireEvent.change(plate, { target: { value: "XYZ9Z99" } });
    expect(plate).toHaveValue("ABC1D23");

    reject(new StockExitCreationClientError(0, "NETWORK_ERROR"));
    await screen.findByRole("alert");
    expect(plate).toBeEnabled();
    expect(plate).toHaveValue("ABC1D23");
  });

  it.each([
    [
      new StockExitCreationClientError(400, "INVALID_STOCK_EXIT_MUNICIPALITY"),
      /código do município/i,
    ],
    [new StockExitCreationClientError(401), /sessão expirou/i],
    [
      new StockExitCreationClientError(403, "MFA_RECENT_REQUIRED"),
      /autenticação corporativa recente/i,
    ],
    [
      new StockExitCreationClientError(409, "STOCK_EXIT_PREFLIGHT_REJECTED"),
      /não está apto para saída/i,
    ],
    [
      new StockExitCreationClientError(422, "STOCK_EXIT_IDEMPOTENCY_CONFLICT"),
      /dados diferem de uma tentativa anterior/i,
    ],
    [
      new StockExitCreationClientError(429, "STOCK_EXIT_RATE_LIMITED", 45),
      /aguarde 45 segundos/i,
    ],
    [
      new StockExitCreationClientError(
        503,
        "STOCK_EXIT_PRINCIPALS_UNAVAILABLE",
      ),
      /identidade verificada.*indisponível/i,
    ],
  ])(
    "prioriza feedback seguro para códigos reais da API",
    async (error, text) => {
      const onCreate = vi.fn(async () => Promise.reject(error));
      renderAvailable(onCreate);
      fillValidForm();

      fireEvent.submit(
        screen
          .getByRole("button", { name: "Registrar saída local" })
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
    fireEvent.change(screen.getByLabelText("Registro de estoque"), {
      target: { value: "0" },
    });
    fireEvent.change(
      screen.getByLabelText("Número do documento, sem máscara"),
      {
        target: { value: "11111111111" },
      },
    );
    fireEvent.change(screen.getByLabelText("CEP"), {
      target: { value: "123" },
    });
    fireEvent.change(screen.getByLabelText("Valor da venda"), {
      target: { value: "100000000" },
    });

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar saída local" })
        .closest("form")!,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/revise os campos/i);
    expect(screen.getByText(/CPF válido/i)).toBeVisible();
    expect(screen.getByText(/CEP com 8 dígitos/i)).toBeVisible();
    expect(screen.getByText(/até R\$ 99\.999\.999,99/i)).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("recusa venda do dia UTC seguinte antes da virada comercial em São Paulo", () => {
    const onCreate = vi.fn(async () => created);
    renderAvailable(onCreate, {
      clock: () => new Date("2026-11-25T02:59:59.999Z"),
    });
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Data da venda"), {
      target: { value: "2026-11-25" },
    });

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar saída local" })
        .closest("form")!,
    );

    expect(
      screen.getByText(/data da venda não pode estar no futuro/i),
    ).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("ignora a resposta pendente depois da troca de estabelecimento", async () => {
    let resolve!: (value: CreateStockExitResult) => void;
    const onCreate = vi.fn(
      () =>
        new Promise<CreateStockExitResult>((next) => {
          resolve = next;
        }),
    );
    const view = renderAvailable(onCreate);
    fillValidForm();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Registrar saída local" })
        .closest("form")!,
    );
    expect(screen.getByRole("button")).toBeDisabled();

    view.rerender(
      <UsedStockExitPanel
        available
        clock={clock}
        onCreate={onCreate}
        selectionKey="tenant-a:store-b"
      />,
    );
    resolve(created);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      screen.queryByText(/solicitação local de saída registrada/i),
    ).toBeNull();
    expect(screen.getByLabelText("Placa")).toHaveValue("");
  });
});
