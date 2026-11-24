import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadHomologationSmokeConfig,
  runHomologationSmoke,
  SerproSmokeConfigurationError,
  SerproSmokeMaterialReadError,
} from "./smoke-serpro-homologation.mjs";

const environment = {
  RENAVE_ESTABLISHMENT_CNPJ: "11222333000181",
  RENAVE_INTEGRATOR_CNPJ: "12ABC34501DE35",
  RENAVE_MTLS_CA_FILE: "/secret/ca.pem",
  RENAVE_MTLS_CERT_FILE: "/secret/cert.pem",
  RENAVE_MTLS_KEY_FILE: "/secret/key.pem",
};

describe("smoke SERPRO mTLS", () => {
  it("falha fechado quando a configuração está incompleta", () => {
    assert.throws(
      () => loadHomologationSmokeConfig({}),
      (error) =>
        error instanceof SerproSmokeConfigurationError &&
        error.code === "SERPRO_SMOKE_CONFIG_MISSING" &&
        error.missing.includes("RENAVE_MTLS_KEY_FILE"),
    );
  });

  it("oculta o caminho quando um material não pode ser lido", async () => {
    const config = loadHomologationSmokeConfig(environment);
    await assert.rejects(
      runHomologationSmoke(config, {
        reader: async () => {
          throw new Error("ENOENT /secret/key.pem");
        },
      }),
      (error) =>
        error instanceof SerproSmokeMaterialReadError &&
        !String(error).includes("/secret/"),
    );
  });

  it("usa homologação, confirma identidade e sempre fecha o cliente", async () => {
    const config = loadHomologationSmokeConfig(environment);
    const observed = {
      closed: false,
      context: undefined,
      environment: undefined,
    };
    await runHomologationSmoke(config, {
      reader: async (path) => `material:${path.split("/").at(-1)}`,
      loadConnector: async () => ({
        createHomologationPemMtlsClient: (targetEnvironment) => {
          observed.environment = targetEnvironment;
          return {
            close: () => {
              observed.closed = true;
            },
            request: async () => new Response(),
          };
        },
        HttpRenaveTransport: class {
          constructor() {}
        },
        RenaveConnector: class {
          async verifyIdentity(context) {
            observed.context = context;
          }
        },
      }),
    });

    assert.equal(observed.environment, "homologation");
    assert.equal(observed.context.environment, "homologation");
    assert.equal(observed.context.establishmentCnpj, "11222333000181");
    assert.equal(observed.closed, true);
  });

  it("fecha o cliente quando a verificação falha", async () => {
    const config = loadHomologationSmokeConfig(environment);
    let closed = false;
    await assert.rejects(
      runHomologationSmoke(config, {
        reader: async () => "material",
        loadConnector: async () => ({
          createHomologationPemMtlsClient: () => ({
            close: () => {
              closed = true;
            },
            request: async () => new Response(),
          }),
          HttpRenaveTransport: class {},
          RenaveConnector: class {
            async verifyIdentity() {
              throw Object.assign(new Error("dados sensíveis"), {
                code: "RENAVE_IDENTITY_MISMATCH",
              });
            }
          },
        }),
      }),
    );
    assert.equal(closed, true);
  });
});
