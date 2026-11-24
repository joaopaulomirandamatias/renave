import { describe, expect, it } from "vitest";

import {
  loadReconciliationWorkerAppConfig,
  ReconciliationWorkerAppConfigError,
} from "./config.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

function enabled(): NodeJS.ProcessEnv {
  return {
    APP_ENVIRONMENT: "homologation",
    RENAVE_INTEGRATOR_CNPJ: "11222333000181",
    RENAVE_MTLS_CA_FILE: "/secret/ca.pem",
    RENAVE_MTLS_CERT_FILE: "/secret/cert.pem",
    RENAVE_MTLS_KEY_FILE: "/secret/key.pem",
    RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID: "key-1",
    RENAVE_RECONCILIATION_DATABASE_URL:
      "postgres://renave_operation_worker:redacted@127.0.0.1/renave",
    RENAVE_RECONCILIATION_LEASE_OWNER: OWNER,
    RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON: JSON.stringify({
      "key-1": Buffer.alloc(32, 1).toString("base64"),
    }),
    RENAVE_RECONCILIATION_TENANT_ALLOWLIST: TENANT,
    RENAVE_RECONCILIATION_WORKER_ENABLED: "true",
    SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
  };
}

describe("configuração do app de reconciliação", () => {
  it("fica desabilitado por padrão sem ler configuração operacional", () => {
    expect(
      loadReconciliationWorkerAppConfig({
        APP_ENVIRONMENT: "production",
        RENAVE_RECONCILIATION_DATABASE_URL: "segredo inválido",
      }),
    ).toEqual({ mode: "disabled" });
  });

  it("ativa somente homologação e mantém dry-run ligado por padrão", () => {
    expect(loadReconciliationWorkerAppConfig(enabled())).toMatchObject({
      appEnvironment: "homologation",
      dryRun: true,
      mode: "enabled",
      tenantAllowlist: [TENANT],
    });
    const run = enabled();
    run.RENAVE_RECONCILIATION_WORKER_DRY_RUN = "false";
    expect(loadReconciliationWorkerAppConfig(run)).toMatchObject({
      dryRun: false,
    });
  });

  it("recusa produção, chaves inválidas e URL com TLS por query", () => {
    for (const mutate of [
      (env: NodeJS.ProcessEnv) => (env.APP_ENVIRONMENT = "production"),
      (env: NodeJS.ProcessEnv) =>
        (env.RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON = "{}"),
      ...[
        "sslmode=disable",
        "ssl=0",
        "ssl=no-verify",
        "host=attacker",
        "sslnegotiation=direct",
        "query_timeout=0",
        "statement_timeout=0",
      ].map(
        (query) => (env: NodeJS.ProcessEnv) =>
          (env.RENAVE_RECONCILIATION_DATABASE_URL += `?${query}`),
      ),
      (env: NodeJS.ProcessEnv) =>
        (env.RENAVE_RECONCILIATION_DATABASE_URL =
          "postgres://renave_operation_worker:redacted@db.internal/renave"),
    ]) {
      const env = enabled();
      mutate(env);
      expect(() => loadReconciliationWorkerAppConfig(env)).toThrow(
        ReconciliationWorkerAppConfigError,
      );
    }
  });

  it("captura a CA do banco uma única vez", () => {
    const env = enabled();
    let reads = 0;
    Object.defineProperty(env, "RENAVE_RECONCILIATION_DATABASE_TLS_CA_FILE", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? undefined : "/attacker/ca.pem";
      },
    });
    const config = loadReconciliationWorkerAppConfig(env);
    expect(config).toMatchObject({ databaseTlsCaFile: undefined });
    expect(reads).toBe(1);
  });
});
