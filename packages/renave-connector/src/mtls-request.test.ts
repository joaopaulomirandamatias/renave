import { describe, expect, it } from "vitest";

import {
  createHomologationPemMtlsClient,
  InvalidPemMtlsMaterialError,
  PemMtlsProductionBlockedError,
  RenaveMtlsOriginError,
  RenaveMtlsResponseTooLargeError,
  readBoundedResponseBody,
  type PemMtlsMaterial,
} from "./index.js";

const material: PemMtlsMaterial = {
  ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  cert: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----",
  key: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
};

describe("createHomologationPemMtlsClient", () => {
  it("interrompe a leitura antes de acumular resposta acima do limite", async () => {
    async function* chunks() {
      yield Buffer.alloc(4, 1);
      yield Buffer.alloc(4, 2);
    }

    await expect(readBoundedResponseBody(chunks(), 7)).rejects.toBeInstanceOf(
      RenaveMtlsResponseTooLargeError,
    );
    await expect(readBoundedResponseBody(chunks(), 8)).resolves.toHaveLength(8);
  });

  it("bloqueia PEM em produção antes de criar o agente", () => {
    expect(() =>
      createHomologationPemMtlsClient("production", material),
    ).toThrow(PemMtlsProductionBlockedError);
  });

  it.each([
    ["ca", { ...material, ca: "inválida" }],
    ["cert", { ...material, cert: "inválido" }],
    ["key", { ...material, key: "inválida" }],
  ] as const)("recusa material %s malformado", (field, candidate) => {
    try {
      createHomologationPemMtlsClient("homologation", candidate);
      throw new Error("deveria recusar o material");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPemMtlsMaterialError);
      expect(error).toMatchObject({ field });
    }
  });

  it("recusa qualquer origem fora da allowlist antes de abrir conexão", async () => {
    const client = createHomologationPemMtlsClient("homologation", material);
    try {
      await expect(
        client.request("https://example.com/api/cliente-autenticado", {
          method: "GET",
          redirect: "error",
        }),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });

  it.each([
    "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/rota-nao-classificada",
    "https://usuario:senha@hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado",
  ])("recusa rota ou credencial não autorizada: %s", async (url) => {
    const client = createHomologationPemMtlsClient("homologation", material);
    try {
      await expect(
        client.request(url, { method: "GET" }),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });

  it("exige política explícita contra redirecionamento", async () => {
    const client = createHomologationPemMtlsClient("homologation", material);
    try {
      await expect(
        client.request(
          "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado",
          { method: "GET" },
        ),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });
});
