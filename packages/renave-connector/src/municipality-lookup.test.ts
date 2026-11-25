import { describe, expect, it, vi } from "vitest";

import {
  createHomologationRenaveReadOnlyRequest,
  HttpRenaveReadOnlyTransport,
  HttpRenaveTransport,
  InvalidMunicipalityIdQueryError,
  RenaveHttpError,
  RenaveIdentityMismatchError,
  RenaveMtlsOriginError,
  RenaveMunicipalityLookupConnector,
  RenaveProductionBlockedError,
  RenaveProtocolError,
  type RenaveHttpRequest,
  type RenaveMunicipality,
  type RenaveServerContext,
} from "./index.js";

const base = "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api";
const identityUrl = `${base}/cliente-autenticado`;
const municipalityUrl = `${base}/municipios/1501402`;
const municipality: RenaveMunicipality = {
  id: "1501402",
  nome: "Belém",
  uf: "PA",
};
const identity = { cnpj: "85106037000585", cnpjIntegradora: "69418503000188" };
const context: RenaveServerContext = {
  environment: "homologation",
  establishmentCnpj: "85.106.037/0005-85",
  establishmentId: "establishment-a",
  integratorCnpj: "69.418.503/0001-88",
  tenantId: "tenant-a",
};
const headers = { "CNPJ-Estabelecimento": identity.cnpj };

function readOnlyTransport(request: RenaveHttpRequest, readTimeoutMs?: number) {
  return new HttpRenaveReadOnlyTransport({
    environment: "homologation",
    request: createHomologationRenaveReadOnlyRequest("homologation", request),
    ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
  });
}

describe("consulta de município RENAVE por ID", () => {
  it("confirma a identidade em cada consulta e envia o CNPJ do contexto nos GETs canônicos", async () => {
    const request = vi.fn<RenaveHttpRequest>(async (url) =>
      Response.json(url === identityUrl ? identity : municipality),
    );
    const connector = new RenaveMunicipalityLookupConnector(
      readOnlyTransport(request),
    );

    const lookup = await connector.getMunicipalityById(context, 1501402);
    await connector.getMunicipalityById(context, 1501402);

    expect(lookup).toEqual({
      result: municipality,
      verifiedIdentity: {
        confirmedEstablishmentCnpj: identity.cnpj,
        confirmedIntegratorCnpj: identity.cnpjIntegradora,
        environment: "homologation",
        establishmentId: "establishment-a",
        tenantId: "tenant-a",
      },
    });
    expect(Object.isFrozen(lookup.result)).toBe(true);
    expect("mutate" in connector).toBe(false);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      identityUrl,
      municipalityUrl,
      identityUrl,
      municipalityUrl,
    ]);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init.headers).get("CNPJ-Estabelecimento")).toBe(
        identity.cnpj,
      );
      expect(new Headers(init.headers).get("accept")).toBe("application/json");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init.body).toBeUndefined();
    }
  });

  it.each([
    { ...identity, cnpj: identity.cnpjIntegradora },
    { ...identity, cnpjIntegradora: identity.cnpj },
    { ...identity, cnpj: null },
    { ...identity, cnpjIntegradora: null },
  ])(
    "não consulta município quando a identidade diverge (%j)",
    async (remoteIdentity) => {
      const request = vi.fn<RenaveHttpRequest>(async () =>
        Response.json(remoteIdentity),
      );
      const connector = new RenaveMunicipalityLookupConnector(
        readOnlyTransport(request),
      );

      await expect(
        connector.getMunicipalityById(context, 1501402),
      ).rejects.toBeInstanceOf(RenaveIdentityMismatchError);

      expect(request.mock.calls.map(([url]) => url)).toEqual([identityUrl]);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1501402"])(
    "recusa ID fora dos inteiros positivos seguros antes de autenticar (%s)",
    async (id) => {
      const request = vi.fn<RenaveHttpRequest>();
      const transport = readOnlyTransport(request);
      const connector = new RenaveMunicipalityLookupConnector(transport);
      await expect(
        connector.getMunicipalityById(context, id as number),
      ).rejects.toBeInstanceOf(InvalidMunicipalityIdQueryError);
      await expect(
        transport.getMunicipalityById(headers, id as number),
      ).rejects.toBeInstanceOf(RenaveProtocolError);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("aceita o maior inteiro seguro e mantém o ID decimal oficial", async () => {
    const largest = { ...municipality, id: "9007199254740991" };
    const request = vi.fn<RenaveHttpRequest>(async () =>
      Response.json(largest),
    );

    await expect(
      readOnlyTransport(request).getMunicipalityById(
        headers,
        Number.MAX_SAFE_INTEGER,
      ),
    ).resolves.toEqual(largest);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `${base}/municipios/9007199254740991`,
    ]);
  });

  it.each([
    ["lista", [municipality]],
    ["nulo", null],
    ["ID ausente", { nome: municipality.nome, uf: municipality.uf }],
    ["ID numérico", { ...municipality, id: 1501402 }],
    ["ID divergente", { ...municipality, id: "1501403" }],
    ["ID com zero à esquerda", { ...municipality, id: "01501402" }],
    ["ID com expoente", { ...municipality, id: "1.501402e6" }],
    ["ID com espaço", { ...municipality, id: "1501402 " }],
    ["nome numérico", { ...municipality, nome: 1 }],
    ["nome vazio", { ...municipality, nome: "" }],
    ["nome em branco", { ...municipality, nome: "  " }],
    ["nome com espaço à esquerda", { ...municipality, nome: " Belém" }],
    [
      "nome com espaço invisível na borda",
      { ...municipality, nome: "Belém\uFEFF" },
    ],
    ["nome longo", { ...municipality, nome: "á".repeat(257) }],
    ["nome com controles", { ...municipality, nome: "Belém\n" }],
    ["nome com direção invisível", { ...municipality, nome: "Bel\u202Eém" }],
    ["nome com separador invisível", { ...municipality, nome: "Bel\u200Bém" }],
    ["UF inválida", { ...municipality, uf: "XX" }],
    ["UF em minúsculas", { ...municipality, uf: "pa" }],
    ["propriedade extra", { ...municipality, cpf: "descartar" }],
  ])("rejeita payload incompatível (%s)", async (_label, payload) => {
    const request = vi.fn<RenaveHttpRequest>(async () =>
      Response.json(payload),
    );

    await expect(
      readOnlyTransport(request).getMunicipalityById(headers, 1501402),
    ).rejects.toMatchObject({
      code: "RENAVE_PROTOCOL_ERROR",
      operation: "get-municipality-by-id",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    () => new Response("{"),
    () => new Response(JSON.stringify(municipality) + " ".repeat(4096)),
    () => new Response(JSON.stringify(municipality), { status: 201 }),
    () =>
      Object.defineProperty(Response.json(municipality), "redirected", {
        value: true,
      }),
    () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new Error("erro interno")),
        }),
      ),
  ])(
    "sanitiza leitura malformada, excessiva, redirecionada ou incompleta",
    async (response) => {
      const request = vi.fn<RenaveHttpRequest>(async () => response());

      await expect(
        readOnlyTransport(request).getMunicipalityById(headers, 1501402),
      ).rejects.toBeInstanceOf(RenaveProtocolError);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([302, 401, 403, 404, 429, 500])(
    "reporta HTTP %s sem corpo ou nova tentativa",
    async (status) => {
      const request = vi.fn<RenaveHttpRequest>(
        async () => new Response("resposta interna", { status }),
      );

      await expect(
        readOnlyTransport(request).getMunicipalityById(headers, 1501402),
      ).rejects.toEqual(new RenaveHttpError(status, "get-municipality-by-id"));
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("sanitiza o timeout sem nova tentativa", async () => {
    const request = vi.fn<RenaveHttpRequest>(
      async (_url, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("erro interno")),
            { once: true },
          );
        }),
    );

    await expect(
      readOnlyTransport(request, 10).getMunicipalityById(headers, 1501402),
    ).rejects.toEqual(new RenaveHttpError(0, "get-municipality-by-id"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("bloqueia produção na consulta autenticada e no transporte direto", async () => {
    const request = vi.fn<RenaveHttpRequest>();
    const transport = new HttpRenaveTransport({
      environment: "production",
      request,
    });
    const connector = new RenaveMunicipalityLookupConnector(transport);

    await expect(
      connector.getMunicipalityById(
        { ...context, environment: "production" },
        1501402,
      ),
    ).rejects.toBeInstanceOf(RenaveProductionBlockedError);
    await expect(
      transport.getMunicipalityById(headers, 1501402),
    ).rejects.toBeInstanceOf(RenaveProductionBlockedError);
    expect(request).not.toHaveBeenCalled();
  });

  it("mantém a mesma rota e validação no transporte HTTP completo", async () => {
    const request = vi.fn<RenaveHttpRequest>(async () =>
      Response.json(municipality),
    );
    const transport = new HttpRenaveTransport({
      environment: "homologation",
      request,
    });

    await expect(
      transport.getMunicipalityById(headers, 1501402),
    ).resolves.toEqual(municipality);
    expect(request).toHaveBeenCalledWith(
      municipalityUrl,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });
});

describe("allowlist mTLS para detalhe de município", () => {
  it.each([
    [`${base}/municipios`, "GET", "error"],
    [`${base}/municipios?nome=Belem&uf=PA`, "GET", "error"],
    [`${base}/municipios/01501402`, "GET", "error"],
    [`${base}/municipios/1501402%2Foutro`, "GET", "error"],
    [`${base}/municipios/9007199254740992`, "GET", "error"],
    [`${municipalityUrl}?expand=true`, "GET", "error"],
    [`${municipalityUrl}#outro`, "GET", "error"],
    [municipalityUrl.replace("hom.", ""), "GET", "error"],
    [municipalityUrl, "POST", "error"],
    [municipalityUrl, "GET", "follow"],
  ] as const)(
    "recusa %s com %s e redirect=%s antes da rede",
    async (url, method, redirect) => {
      const request = vi.fn<RenaveHttpRequest>();
      const capability = createHomologationRenaveReadOnlyRequest(
        "homologation",
        request,
      );

      await expect(
        capability.request(url, { method, redirect }),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
      expect(request).not.toHaveBeenCalled();
    },
  );
});
