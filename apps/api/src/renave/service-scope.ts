import type { CredentialServiceNature } from "@seu-renave/db/api-runtime";

/**
 * A fatia executável atual cobre somente o grupo Estabelecimento do RENAVE.
 * O servidor escolhe a natureza; nenhum valor fornecido pelo navegador participa
 * da decisão de autorização.
 */
export const ESTABLISHMENT_SERVICE_NATURE =
  "establishment" satisfies CredentialServiceNature;
