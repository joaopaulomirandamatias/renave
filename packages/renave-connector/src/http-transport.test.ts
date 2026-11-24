import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  HttpRenaveTransport,
  RenaveHttpError,
  RenaveMutationOutcomeUnknownError,
  PreparedRenaveMutation,
  RenaveProductionBlockedError,
  RenaveProtocolError,
  prepareRenaveMutation,
  restorePreparedRenaveMutation,
  type EstablishmentHeaders,
} from "./index.js";

const headers: EstablishmentHeaders = {
  "CNPJ-Estabelecimento": "85106037000585",
};

async function mutate<TResult>(
  transport: HttpRenaveTransport,
  payload: unknown,
): Promise<TResult> {
  const prepared = await prepareRenaveMutation("request-stock-entry", payload);
  return transport.mutate<TResult>(headers, prepared);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("HttpRenaveTransport", () => {
  it("consulta a identidade no host fixo do ambiente com o CNPJ autorizado", async () => {
    const request = vi.fn(async () =>
      Response.json({
        cnpj: "85106037000585",
        cnpjIntegradora: "69418503000188",
      }),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(transport.getAuthenticatedClient(headers)).resolves.toEqual({
      cnpj: "85106037000585",
      cnpjIntegradora: "69418503000188",
    });
    expect(request).toHaveBeenCalledWith(
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining(headers),
      }),
    );
  });

  it("envia entrada de estoque como JSON para a rota oficial", async () => {
    const request = vi.fn(async () =>
      Response.json({ id: 7, estado: "SOLICITADO" }, { status: 201 }),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(mutate(transport, { placa: "QTP4H82" })).resolves.toEqual({
      id: 7,
      estado: "SOLICITADO",
    });
    expect(request).toHaveBeenCalledWith(
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/solicitacoes-entrada-estoque",
      expect.objectContaining({
        body: new TextEncoder().encode('{"placa":"QTP4H82"}'),
        method: "POST",
        redirect: "error",
      }),
    );
  });

  it("envia exatamente os bytes preparados e o hash independente coincide", async () => {
    let sent: Uint8Array | undefined;
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      sent = Uint8Array.from(init.body as Uint8Array);
      return Response.json({ id: 7, estado: "SOLICITADO" }, { status: 201 });
    });
    const exact = Buffer.from('{ "z":1,\n"a":"ação 🚗" }\n', "utf8");
    const expectedHash = sha256(exact);
    const prepared = await restorePreparedRenaveMutation(
      "request-stock-entry",
      exact,
      expectedHash,
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await transport.mutate(headers, prepared);

    expect(Buffer.from(sent!)).toEqual(exact);
    expect(sha256(sent!)).toBe(prepared.requestSha256);
    expect(request).toHaveBeenCalledOnce();
  });

  it("bloqueia mutação direta em produção antes da rede", async () => {
    const request = vi.fn();
    const transport = new HttpRenaveTransport({
      environment: "production",
      request,
    });
    const prepared = await prepareRenaveMutation("request-stock-entry", {});

    await expect(transport.mutate(headers, prepared)).rejects.toBeInstanceOf(
      RenaveProductionBlockedError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("recusa envelope forjado antes da rede", async () => {
    const request = vi.fn();
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });
    const forged = Object.create(
      PreparedRenaveMutation.prototype,
    ) as PreparedRenaveMutation;

    await expect(transport.mutate(headers, forged)).rejects.toMatchObject({
      code: "INVALID_PREPARED_RENAVE_MUTATION",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("não segue redirect nem repete a mutação", async () => {
    const request = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(null, {
          headers: { location: "https://example.invalid/coleta" },
          status: 307,
        }),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(mutate(transport, {})).rejects.toMatchObject({ status: 307 });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it("consulta aptidão por um identificador na rota oficial", async () => {
    const request = vi.fn(async () =>
      Response.json({ diagnostico: { veiculoApto: true } }),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.getVehicleEligibility(headers, {
        renavam: "00607701676",
        tipoCrv: "DIGITAL",
      }),
    ).resolves.toEqual({ diagnostico: { veiculoApto: true } });
    expect(request).toHaveBeenCalledWith(
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/aptidao-veiculo-estoque?tipoCrv=DIGITAL&renavam=00607701676",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("usa limites distintos de 60 s para leitura e 120 s para mutação", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return init.method === "POST"
        ? Response.json({ id: 7, estado: "SOLICITADO" }, { status: 201 })
        : Response.json({ cnpj: null, cnpjIntegradora: null });
    });
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await transport.getAuthenticatedClient(headers);
    await mutate(transport, {});
    expect(request).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 60_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 120_000);
    timeout.mockRestore();
  });

  it.each([
    ["corpo vazio", ""],
    ["array", "[]"],
    ["string", '"resposta"'],
    ["objeto vazio", "{}"],
    ["booleano incompatível", '{"diagnostico":{"veiculoApto":"sim"}}'],
    ["motivos incompatíveis", '{"diagnostico":{"motivosParaNaoAptidao":[7]}}'],
  ])("recusa aptidão 200 com %s", async (_label, body) => {
    const request = vi.fn(async () => new Response(body, { status: 200 }));
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.getVehicleEligibility(headers, {
        placa: "QTP4H82",
        tipoCrv: "DIGITAL",
      }),
    ).rejects.toBeInstanceOf(RenaveProtocolError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("aceita aptidão com veículo e débitos mesmo sem diagnóstico", async () => {
    const payload = {
      informacoesDebitos: {
        codigosBancos: ["001"],
        existemDebitos: true,
        valorDebitoIpva: 125.5,
      },
      veiculo: {
        placa: "QTP4H82",
        renavam: "00607701676",
        veiculoAcabado: true,
      },
    };
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request: vi.fn(async () => Response.json(payload)),
    });

    await expect(
      transport.getVehicleEligibility(headers, {
        placa: "QTP4H82",
        tipoCrv: "DIGITAL",
      }),
    ).resolves.toEqual(payload);
  });

  it("recusa campos conhecidos de veículo e débitos com tipos incompatíveis", async () => {
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request: vi.fn(async () =>
        Response.json({
          informacoesDebitos: { valorDebitoIpva: "125,50" },
          veiculo: { veiculoAcabado: "sim" },
        }),
      ),
    });

    await expect(
      transport.getVehicleEligibility(headers, {
        placa: "QTP4H82",
        tipoCrv: "DIGITAL",
      }),
    ).rejects.toBeInstanceOf(RenaveProtocolError);
  });

  it("consulta estoques por placa para reconciliação", async () => {
    const request = vi.fn(async () =>
      Response.json([{ id: 7, placa: "QTP4H82" }]),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.findStocksByPlate(headers, "QTP4H82"),
    ).resolves.toEqual([{ id: 7, placa: "QTP4H82" }]);
    expect(request).toHaveBeenCalledWith(
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/estoques?placa=QTP4H82",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("normaliza a placa e nunca envia consulta de estoque sem filtro válido", async () => {
    const request = vi.fn(async () => Response.json([]));
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.findStocksByPlate(headers, " qtp4h82 "),
    ).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/estoques?placa=QTP4H82",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );

    for (const invalid of ["", "   ", "ABC123", "ABC-1234"]) {
      await expect(
        transport.findStocksByPlate(headers, invalid),
      ).rejects.toMatchObject({ code: "INVALID_STOCK_PLATE_QUERY" });
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserva identidade, estado e cancelamento do estoque", async () => {
    const payload = {
      cancelamentoEstoque: { motivo: "cancelado" },
      chassi: "9BWZZZ377VT004251",
      codigoSegurancaCrv: "12345678901",
      entradaEstoque: {
        cpfOperadorResponsavel: "12345678901",
        dataHoraRegistro: "2026-11-23T15:02:00.000Z",
      },
      estado: "FINALIZADO",
      entregas: [{ dataHora: "2026-11-23T16:00:00.000Z" }],
      id: 7,
      numeroCrv: "123456789012",
      placa: "QTP4H82",
      renavam: "00607701676",
      tipoCrv: "DIGITAL",
    };
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request: vi.fn(async () => Response.json([payload])),
    });

    await expect(
      transport.findStocksByPlate(headers, "QTP4H82"),
    ).resolves.toEqual([payload]);
  });

  it.each([500, 502, 503])(
    "marca HTTP %s como resultado incerto e não repete a mutação",
    async (status) => {
      const request = vi.fn(async () => new Response(null, { status }));
      const transport = new HttpRenaveTransport({
        environment: "homologation",
        request,
      });

      const prepared = await prepareRenaveMutation("request-stock-entry", {
        placa: "QTP4H82",
      });

      const outcome = transport.mutate(headers, prepared);

      await expect(outcome).rejects.toBeInstanceOf(
        RenaveMutationOutcomeUnknownError,
      );
      await expect(outcome).rejects.toMatchObject({
        code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        requestSha256: prepared.requestSha256,
        status,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["vazio", ""],
    ["JSON inválido", "{"],
  ])(
    "trata HTTP 201 com corpo %s como resultado incerto",
    async (_label, body) => {
      const request = vi.fn(async () => new Response(body, { status: 201 }));
      const transport = new HttpRenaveTransport({
        environment: "homologation",
        request,
      });
      const prepared = await prepareRenaveMutation("request-stock-entry", {
        placa: "QTP4H82",
      });

      await expect(transport.mutate(headers, prepared)).rejects.toMatchObject({
        code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        requestSha256: prepared.requestSha256,
        status: 201,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["objeto vazio", {}],
    ["id ausente", { estado: "SOLICITADO" }],
    ["id incompatível", { estado: "SOLICITADO", id: "7" }],
    ["estado desconhecido", { estado: "DESCONHECIDO", id: 7 }],
    ["placa incompatível", { estado: "SOLICITADO", id: 7, placa: 123 }],
  ])(
    "trata HTTP 201 com EstoqueJson %s como resultado incerto",
    async (_label, payload) => {
      const request = vi.fn(async () =>
        Response.json(payload, { status: 201 }),
      );
      const transport = new HttpRenaveTransport({
        environment: "homologation",
        request,
      });
      const prepared = await prepareRenaveMutation("request-stock-entry", {
        placa: "QTP4H82",
      });

      await expect(transport.mutate(headers, prepared)).rejects.toMatchObject({
        code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        requestSha256: prepared.requestSha256,
        status: 201,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("trata falha de transporte como resultado incerto sem repetir", async () => {
    const request = vi.fn(async () => {
      throw new Error("conexão perdida");
    });
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    const prepared = await prepareRenaveMutation("request-stock-entry", {});
    await expect(transport.mutate(headers, prepared)).rejects.toMatchObject({
      code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
      requestSha256: prepared.requestSha256,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("não transforma 503 em sucesso por uma segunda tentativa", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ id: 7, estado: "SOLICITADO" }, { status: 201 }),
      );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(mutate(transport, {})).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("não inclui corpo nem dados pessoais no erro de desfecho incerto", async () => {
    const request = vi.fn(async () => {
      throw new Error("timeout");
    });
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });
    const prepared = await prepareRenaveMutation("request-stock-entry", {
      cpf: "12345678901",
      email: "pessoa@example.com",
      placa: "QTP4H82",
    });

    let serialized = "";
    try {
      await transport.mutate(headers, prepared);
      throw new Error("deveria produzir desfecho incerto");
    } catch (error) {
      serialized = JSON.stringify(error);
    }

    expect(serialized).toContain(prepared.requestSha256);
    expect(serialized).not.toMatch(/12345678901|pessoa@example\.com|QTP4H82/u);
    expect(request).toHaveBeenCalledOnce();
  });

  it("trata rejeição 422 como resultado conhecido sem retry", async () => {
    const request = vi.fn(async () => new Response(null, { status: 422 }));
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    const outcome = mutate(transport, {});

    await expect(outcome).rejects.toBeInstanceOf(RenaveHttpError);
    await expect(outcome).rejects.toMatchObject({ status: 422 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["lista ausente", {}],
    ["id incompatível", [{ id: "7", placa: "QTP4H82" }]],
    ["estado desconhecido", [{ estado: "DESCONHECIDO", id: 7 }]],
  ])("recusa resposta de estoque com %s", async (_label, payload) => {
    const request = vi.fn(async () => Response.json(payload));
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.findStocksByPlate(headers, "QTP4H82"),
    ).rejects.toBeInstanceOf(RenaveProtocolError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("não repete consulta de estoque após falha de transporte", async () => {
    const request = vi.fn(async () => {
      throw new Error("timeout");
    });
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.findStocksByPlate(headers, "QTP4H82"),
    ).rejects.toMatchObject({
      code: "RENAVE_HTTP_ERROR",
      operation: "find-stocks-by-plate",
      status: 0,
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
