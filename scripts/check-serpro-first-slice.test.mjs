import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  checkSerproFirstSlice,
  FIRST_SLICE_SOURCE,
  validateFirstSlice,
} from "./check-serpro-first-slice.mjs";

function secured(operation) {
  return { security: [{ cnpjEstabelecimento: [] }], ...operation };
}

function properties(names) {
  return Object.fromEntries(names.map((name) => [name, {}]));
}

function compatibleDocument() {
  return {
    definitions: {
      AptidaoVeiculoEstoque: {
        properties: properties([
          "autorizacaoTransferencia",
          "comunicacaoComDetranFalhou",
          "diagnostico",
          "informacoesDebitos",
          "veiculo",
        ]),
      },
      ClienteAutenticadoJson: {
        properties: properties([
          "cnpj",
          "cnpjIntegradora",
          "nome",
          "nomeIntegradora",
        ]),
      },
      DiagnosticoAptidaoEstoque: {
        properties: properties([
          "motivosParaNaoAptidao",
          "veiculoApto",
          "veiculoComRecall",
          "veiculoComRestricaoNaReceitaFederal",
          "veiculoComRestricaoPgfn",
          "veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
          "veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
        ]),
      },
      EstoqueJson: {
        properties: {
          estado: {
            enum: ["SOLICITADO", "TRANSFERIDO", "CONFIRMADO", "FINALIZADO"],
          },
          id: {},
          placa: {},
        },
      },
      Restricao: { properties: properties(["codigoTipo", "tipo"]) },
      SolicitacaoEntradaEstoque: {
        required: [
          "cpfOperadorResponsavel",
          "dataCompra",
          "emailEstabelecimento",
          "emailVendedor",
          "valorCompra",
          "veiculo",
        ],
      },
      Veiculo: {
        properties: {
          chassi: {},
          dataPreCadastro: { format: "date" },
          placa: {},
          renavam: {},
          restricoes: {
            items: { $ref: "#/definitions/Restricao" },
            type: "array",
          },
          veiculoAcabado: {},
        },
      },
      VeiculoEntradaEstoque: {
        required: [
          "codigoSegurancaCrv",
          "dataHoraMedicaoHodometro",
          "documentoProprietarioAtual",
          "placa",
          "quilometragemHodometro",
          "tipoCrv",
          "tipoDocumentoProprietarioAtual",
        ],
      },
    },
    paths: {
      "/api/aptidao-veiculo-estoque": {
        get: secured({
          parameters: [
            { name: "numeroCrv" },
            { name: "placa" },
            { name: "renavam" },
            { name: "tipoCrv", required: true },
          ],
          responses: {
            200: { schema: { $ref: "#/definitions/AptidaoVeiculoEstoque" } },
          },
        }),
      },
      "/api/cliente-autenticado": {
        get: secured({
          responses: {
            200: { schema: { $ref: "#/definitions/ClienteAutenticadoJson" } },
          },
        }),
      },
      "/api/estoques": {
        get: secured({
          parameters: [{ name: "placa" }],
          responses: {
            200: {
              schema: {
                items: { $ref: "#/definitions/EstoqueJson" },
                type: "array",
              },
            },
          },
        }),
      },
      "/api/solicitacoes-entrada-estoque": {
        post: secured({
          parameters: [
            {
              in: "body",
              required: true,
              schema: { $ref: "#/definitions/SolicitacaoEntradaEstoque" },
            },
          ],
          responses: {
            201: { schema: { $ref: "#/definitions/EstoqueJson" } },
          },
        }),
      },
      "/api/veiculos": {
        get: secured({
          parameters: [
            { name: "chassi" },
            {
              in: "query",
              name: "placa",
              pattern: "[A-Za-z]{3}[0-9][A-Za-z0-9][0-9]{2}",
              type: "string",
            },
            { name: "renavam" },
          ],
          responses: {
            200: { schema: { $ref: "#/definitions/Veiculo" } },
          },
        }),
      },
    },
    securityDefinitions: {
      cnpjEstabelecimento: { name: "CNPJ-Estabelecimento" },
    },
  };
}

describe("contrato semântico da primeira fatia", () => {
  it("aceita a fixture mínima compatível e vincula a semântica ao hash", async () => {
    const document = compatibleDocument();
    const body = JSON.stringify(document);
    const logs = [];

    assert.doesNotThrow(() => validateFirstSlice(document));
    await checkSerproFirstSlice({
      expectedSha256: createHash("sha256").update(body).digest("hex"),
      fetchImpl: async (source, init) => {
        assert.equal(source, FIRST_SLICE_SOURCE);
        assert.equal(init.redirect, "error");
        return new Response(body);
      },
      output: { log: (message) => logs.push(message) },
    });

    assert.deepEqual(logs, [
      "homologation: contrato semântico da primeira fatia compatível",
    ]);
  });

  it("recusa bytes diferentes do baseline antes de validar a semântica", async () => {
    const body = JSON.stringify(compatibleDocument());
    await assert.rejects(
      checkSerproFirstSlice({
        expectedSha256: "0".repeat(64),
        fetchImpl: async () => new Response(body),
      }),
      /hash de homologação divergiu do baseline/,
    );
  });

  it("recusa mudanças no header, segurança, parâmetros, refs, propriedades e enum", () => {
    const mutations = [
      (document) => {
        document.securityDefinitions.cnpjEstabelecimento.name = "Outro";
      },
      (document) => {
        document.paths["/api/cliente-autenticado"].get.security = [];
      },
      (document) => {
        document.paths["/api/aptidao-veiculo-estoque"].get.parameters.find(
          ({ name }) => name === "tipoCrv",
        ).required = false;
      },
      (document) => {
        document.paths["/api/veiculos"].get.responses[200].schema.$ref =
          "#/definitions/Outro";
      },
      (document) => {
        delete document.definitions.DiagnosticoAptidaoEstoque.properties
          .veiculoApto;
      },
      (document) => {
        document.definitions.EstoqueJson.properties.estado.enum = ["OUTRO"];
      },
      (document) => {
        document.definitions.SolicitacaoEntradaEstoque.required = [];
      },
    ];

    for (const mutate of mutations) {
      const document = compatibleDocument();
      mutate(document);
      assert.throws(
        () => validateFirstSlice(document),
        /Contrato incompatível/,
      );
    }
  });
});
