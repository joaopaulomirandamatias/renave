import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  fetchBoundedJson,
  MAX_SERPRO_JSON_RESPONSE_BYTES,
} from "./serpro-json-monitor.mjs";

export const FIRST_SLICE_SOURCE =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)";
const baselineUrl = new URL(
  "../contracts/serpro/estabelecimento-baseline.json",
  import.meta.url,
);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Contrato incompatível: ${message}`);
}

function operation(document, path, method) {
  const value = document.paths?.[path]?.[method];
  requireValue(value, `${method.toUpperCase()} ${path} não existe`);
  requireValue(
    value.security?.some((item) => Object.hasOwn(item, "cnpjEstabelecimento")),
    `${method.toUpperCase()} ${path} não exige cnpjEstabelecimento`,
  );
  return value;
}

function definition(document, name) {
  const value = document.definitions?.[name];
  requireValue(value, `definition ${name} não existe`);
  return value;
}

function requireProperties(schema, names, label) {
  for (const name of names) {
    requireValue(schema.properties?.[name], `${label}.${name} não existe`);
  }
}

function requireRequired(schema, names, label) {
  for (const name of names) {
    requireValue(
      schema.required?.includes(name),
      `${label}.${name} não é obrigatório`,
    );
  }
}

export function validateFirstSlice(document) {
  requireValue(
    document.securityDefinitions?.cnpjEstabelecimento?.name ===
      "CNPJ-Estabelecimento",
    "cnpjEstabelecimento deixou de usar o header CNPJ-Estabelecimento",
  );

  const identity = operation(document, "/api/cliente-autenticado", "get");
  requireValue(
    identity.responses?.["200"]?.schema?.$ref ===
      "#/definitions/ClienteAutenticadoJson",
    "cliente-autenticado não retorna ClienteAutenticadoJson",
  );
  requireProperties(
    definition(document, "ClienteAutenticadoJson"),
    ["cnpj", "cnpjIntegradora", "nome", "nomeIntegradora"],
    "ClienteAutenticadoJson",
  );

  const eligibility = operation(
    document,
    "/api/aptidao-veiculo-estoque",
    "get",
  );
  const eligibilityParameters = new Map(
    eligibility.parameters?.map((parameter) => [parameter.name, parameter]),
  );
  for (const name of ["numeroCrv", "placa", "renavam", "tipoCrv"]) {
    requireValue(
      eligibilityParameters.has(name),
      `aptidao-veiculo-estoque não aceita ${name}`,
    );
  }
  requireValue(
    eligibilityParameters.get("tipoCrv")?.required === true,
    "tipoCrv deixou de ser obrigatório",
  );
  requireValue(
    eligibility.responses?.["200"]?.schema?.$ref ===
      "#/definitions/AptidaoVeiculoEstoque",
    "aptidão não retorna AptidaoVeiculoEstoque",
  );
  requireProperties(
    definition(document, "AptidaoVeiculoEstoque"),
    [
      "autorizacaoTransferencia",
      "comunicacaoComDetranFalhou",
      "diagnostico",
      "informacoesDebitos",
      "veiculo",
    ],
    "AptidaoVeiculoEstoque",
  );
  requireProperties(
    definition(document, "DiagnosticoAptidaoEstoque"),
    [
      "motivosParaNaoAptidao",
      "veiculoApto",
      "veiculoComRecall",
      "veiculoComRestricaoNaReceitaFederal",
      "veiculoComRestricaoPgfn",
      "veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
      "veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
    ],
    "DiagnosticoAptidaoEstoque",
  );

  const vehicles = operation(document, "/api/veiculos", "get");
  const vehicleParameters = new Map(
    vehicles.parameters?.map((parameter) => [parameter.name, parameter]),
  );
  requireValue(
    vehicleParameters.size === 3 &&
      ["chassi", "placa", "renavam"].every((name) =>
        vehicleParameters.has(name),
      ),
    "veiculos divergiu dos parâmetros chassi/placa/renavam",
  );
  requireValue(
    vehicleParameters.get("placa")?.in === "query" &&
      vehicleParameters.get("placa")?.type === "string" &&
      vehicleParameters.get("placa")?.pattern ===
        "[A-Za-z]{3}[0-9][A-Za-z0-9][0-9]{2}",
    "veiculos.placa divergiu do formato oficial",
  );
  requireValue(
    vehicles.responses?.["200"]?.schema?.$ref === "#/definitions/Veiculo",
    "veiculos não retorna Veiculo",
  );
  const vehicleDefinition = definition(document, "Veiculo");
  requireProperties(
    vehicleDefinition,
    [
      "chassi",
      "dataPreCadastro",
      "placa",
      "renavam",
      "restricoes",
      "veiculoAcabado",
    ],
    "Veiculo",
  );
  requireValue(
    vehicleDefinition.properties.dataPreCadastro.format === "date",
    "Veiculo.dataPreCadastro deixou de ser data civil",
  );
  requireValue(
    vehicleDefinition.properties.restricoes.type === "array" &&
      vehicleDefinition.properties.restricoes.items?.$ref ===
        "#/definitions/Restricao",
    "Veiculo.restricoes não referencia Restricao",
  );
  requireProperties(
    definition(document, "Restricao"),
    ["codigoTipo", "tipo"],
    "Restricao",
  );

  const stocks = operation(document, "/api/estoques", "get");
  const stockParameters = new Map(
    stocks.parameters?.map((parameter) => [parameter.name, parameter]),
  );
  requireValue(stockParameters.has("placa"), "estoques não aceita placa");
  requireValue(
    stocks.responses?.["200"]?.schema?.type === "array" &&
      stocks.responses?.["200"]?.schema?.items?.$ref ===
        "#/definitions/EstoqueJson",
    "estoques não retorna array de EstoqueJson",
  );
  const stockDefinition = definition(document, "EstoqueJson");
  requireProperties(stockDefinition, ["estado", "id", "placa"], "EstoqueJson");
  requireValue(
    JSON.stringify(stockDefinition.properties.estado.enum) ===
      JSON.stringify(["SOLICITADO", "TRANSFERIDO", "CONFIRMADO", "FINALIZADO"]),
    "EstoqueJson.estado divergiu do enum conhecido",
  );

  const stockEntry = operation(
    document,
    "/api/solicitacoes-entrada-estoque",
    "post",
  );
  requireValue(
    stockEntry.parameters?.some(
      (parameter) =>
        parameter.in === "body" &&
        parameter.required === true &&
        parameter.schema?.$ref === "#/definitions/SolicitacaoEntradaEstoque",
    ),
    "entrada em estoque não exige SolicitacaoEntradaEstoque no body",
  );
  requireValue(
    stockEntry.responses?.["201"]?.schema?.$ref === "#/definitions/EstoqueJson",
    "entrada em estoque não retorna EstoqueJson no HTTP 201",
  );

  requireRequired(
    definition(document, "SolicitacaoEntradaEstoque"),
    [
      "cpfOperadorResponsavel",
      "dataCompra",
      "emailEstabelecimento",
      "emailVendedor",
      "valorCompra",
      "veiculo",
    ],
    "SolicitacaoEntradaEstoque",
  );
  requireRequired(
    definition(document, "VeiculoEntradaEstoque"),
    [
      "codigoSegurancaCrv",
      "dataHoraMedicaoHodometro",
      "documentoProprietarioAtual",
      "placa",
      "quilometragemHodometro",
      "tipoCrv",
      "tipoDocumentoProprietarioAtual",
    ],
    "VeiculoEntradaEstoque",
  );
}

export async function checkSerproFirstSlice({
  expectedSha256,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_SERPRO_JSON_RESPONSE_BYTES,
  output = console,
  source = FIRST_SLICE_SOURCE,
} = {}) {
  const { bytes, document } = await fetchBoundedJson("homologation", source, {
    fetchImpl,
    maxBytes,
  });
  if (
    typeof expectedSha256 !== "string" ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  ) {
    throw new Error(
      "Contrato incompatível: hash de homologação divergiu do baseline",
    );
  }
  validateFirstSlice(document);
  output.log("homologation: contrato semântico da primeira fatia compatível");
}

export async function runFirstSliceCli() {
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  await checkSerproFirstSlice({
    expectedSha256: baseline.environments.homologation.sha256,
    source: baseline.environments.homologation.source,
  });
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) await runFirstSliceCli();
