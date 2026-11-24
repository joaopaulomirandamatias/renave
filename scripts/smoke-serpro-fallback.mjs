const endpoint =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado";

const response = await fetch(endpoint, {
  headers: { accept: "application/json" },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Homologação respondeu HTTP ${response.status}`);
}

const identity = await response.json();
if (!identity || typeof identity !== "object") {
  throw new Error("Homologação respondeu identidade em formato inválido");
}
if (typeof identity.cnpj !== "string") {
  throw new Error("Homologação não informou o CNPJ do cliente-padrão");
}
if (identity.cnpjIntegradora !== null) {
  throw new Error(
    "O endpoint sem certificado deixou de representar o fallback sem integradora; revise o gate antes de prosseguir",
  );
}

console.log(
  "homologation: fallback público sem integradora confirmado; não autoriza operação",
);
