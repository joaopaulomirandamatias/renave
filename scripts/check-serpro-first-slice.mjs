const source =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)";

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

const response = await fetch(source, {
  headers: { accept: "application/json" },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
requireValue(response.ok, `Swagger respondeu HTTP ${response.status}`);
const document = await response.json();
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

const eligibility = operation(document, "/api/aptidao-veiculo-estoque", "get");
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

console.log("homologation: contrato semântico da primeira fatia compatível");
