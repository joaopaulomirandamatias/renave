import { describe, expect, it, vi } from "vitest";

import {
  loadReconciliationWorkerAppConfig,
  ReconciliationWorkerAppConfigError,
} from "./config.js";
import type { ReconciliationWorkerSecretFiles } from "./secret-files.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

function enabled(): NodeJS.ProcessEnv {
  return {
    APP_ENVIRONMENT: "homologation",
    RENAVE_INTEGRATOR_CNPJ: "11222333000181",
    RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID: "key-1",
    RENAVE_RECONCILIATION_LEASE_OWNER: OWNER,
    RENAVE_RECONCILIATION_TENANT_ALLOWLIST: TENANT,
    RENAVE_RECONCILIATION_WORKER_ENABLED: "true",
  };
}

function secretFiles(
  overrides: Partial<ReconciliationWorkerSecretFiles> = {},
): ReconciliationWorkerSecretFiles {
  return {
    databaseCa: undefined,
    databaseUrl: "postgres://renave_operation_worker:redacted@127.0.0.1/renave",
    limiterHmacKeyBase64: Buffer.alloc(32, 2).toString("base64"),
    mtlsCa: "ca",
    mtlsCertificate: "certificate",
    mtlsKey: "private-key",
    mtlsKeyPassphrase: undefined,
    projectionKeysJson: JSON.stringify({
      "key-1": Buffer.alloc(32, 1).toString("base64"),
    }),
    ...overrides,
  };
}

describe("configuração do app de reconciliação", () => {
  it("fica desabilitado por padrão sem ler arquivos secretos", async () => {
    const loadSecrets = vi.fn();
    await expect(
      loadReconciliationWorkerAppConfig({}, loadSecrets),
    ).resolves.toEqual({ mode: "disabled" });
    expect(loadSecrets).not.toHaveBeenCalled();
  });

  it("recusa segredo bruto por presença antes do modo desabilitado sem ler o valor", async () => {
    let valueReads = 0;
    const env: NodeJS.ProcessEnv = {};
    Object.defineProperty(env, "RENAVE_RECONCILIATION_DATABASE_URL", {
      configurable: true,
      enumerable: true,
      get: () => {
        valueReads += 1;
        throw new Error("não deve ler segredo bruto");
      },
    });
    const loadSecrets = vi.fn();
    await expect(
      loadReconciliationWorkerAppConfig(env, loadSecrets),
    ).rejects.toBeInstanceOf(ReconciliationWorkerAppConfigError);
    expect(valueReads).toBe(0);
    expect(loadSecrets).not.toHaveBeenCalled();
  });

  it("ativa somente homologação e mantém dry-run ligado por padrão", async () => {
    const loadSecrets = async () => secretFiles();
    await expect(
      loadReconciliationWorkerAppConfig(enabled(), loadSecrets),
    ).resolves.toMatchObject({
      appEnvironment: "homologation",
      dryRun: true,
      mode: "enabled",
      tenantAllowlist: [TENANT],
    });
    const run = enabled();
    run.RENAVE_RECONCILIATION_WORKER_DRY_RUN = "false";
    await expect(
      loadReconciliationWorkerAppConfig(run, loadSecrets),
    ).resolves.toMatchObject({ dryRun: false });
  });

  it("recusa qualquer segredo bruto no ambiente antes de ler arquivos", async () => {
    for (const name of [
      "RENAVE_RECONCILIATION_DATABASE_URL",
      "RENAVE_RECONCILIATION_DATABASE_TLS_CA_FILE",
      "RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON",
      "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
      "RENAVE_MTLS_CA_FILE",
      "RENAVE_MTLS_CERT_FILE",
      "RENAVE_MTLS_KEY_FILE",
      "RENAVE_MTLS_KEY_PASSPHRASE",
    ]) {
      const env = enabled();
      env[name] = "raw-secret";
      const loadSecrets = vi.fn(async () => secretFiles());
      await expect(
        loadReconciliationWorkerAppConfig(env, loadSecrets),
      ).rejects.toBeInstanceOf(ReconciliationWorkerAppConfigError);
      expect(loadSecrets).not.toHaveBeenCalled();
    }
  });

  it("recusa produção, keyring inválido e banco remoto sem CA", async () => {
    const production = enabled();
    production.APP_ENVIRONMENT = "production";
    await expect(
      loadReconciliationWorkerAppConfig(production, async () => secretFiles()),
    ).rejects.toBeInstanceOf(ReconciliationWorkerAppConfigError);

    await expect(
      loadReconciliationWorkerAppConfig(enabled(), async () =>
        secretFiles({ projectionKeysJson: "{}" }),
      ),
    ).rejects.toBeInstanceOf(ReconciliationWorkerAppConfigError);

    await expect(
      loadReconciliationWorkerAppConfig(enabled(), async () =>
        secretFiles({ databaseUrl: "postgres://worker@db.internal/renave" }),
      ),
    ).rejects.toBeInstanceOf(ReconciliationWorkerAppConfigError);
  });

  it("recusa parâmetros de conexão por query sem expor segredo", async () => {
    for (const query of [
      "sslmode=disable",
      "ssl=0",
      "ssl=no-verify",
      "host=attacker",
      "sslnegotiation=direct",
      "query_timeout=0",
      "statement_timeout=0",
    ]) {
      const password = `secret-${query}`;
      const error = await loadReconciliationWorkerAppConfig(
        enabled(),
        async () =>
          secretFiles({
            databaseUrl: `postgres://worker:${password}@db/renave?${query}`,
          }),
      ).catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(ReconciliationWorkerAppConfigError);
      expect(String(error)).not.toContain(password);
    }
  });

  it("captura cada configuração não secreta uma vez antes do await", async () => {
    const first = {
      activeKey: "key-1",
      cnpj: "11222333000181",
      dryRun: "true",
      healthPort: "9464",
      heartbeat: "30000",
      poll: "5000",
      tenant: TENANT,
    };
    const current = { ...first };
    const reads = new Map<string, number>();
    const env: NodeJS.ProcessEnv = {
      APP_ENVIRONMENT: "homologation",
      RENAVE_RECONCILIATION_LEASE_OWNER: OWNER,
      RENAVE_RECONCILIATION_WORKER_ENABLED: "true",
    };
    for (const [name, source] of [
      ["RENAVE_INTEGRATOR_CNPJ", "cnpj"],
      ["RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID", "activeKey"],
      ["RENAVE_RECONCILIATION_TENANT_ALLOWLIST", "tenant"],
      ["RENAVE_RECONCILIATION_WORKER_DRY_RUN", "dryRun"],
      ["RENAVE_RECONCILIATION_HEALTH_PORT", "healthPort"],
      ["RENAVE_RECONCILIATION_HEARTBEAT_MS", "heartbeat"],
      ["RENAVE_RECONCILIATION_POLL_MS", "poll"],
    ] as const) {
      Object.defineProperty(env, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return current[source];
        },
      });
    }

    const result = await loadReconciliationWorkerAppConfig(env, async () => {
      Object.assign(current, {
        activeKey: "key-inexistente",
        cnpj: "00000000000000",
        dryRun: "false",
        healthPort: "1",
        heartbeat: "1000",
        poll: "250",
        tenant: "tenant-inválido",
      });
      return secretFiles();
    });
    expect(result).toMatchObject({
      activeProjectionKeyId: first.activeKey,
      dryRun: true,
      healthPort: 9464,
      heartbeatIntervalMs: 30_000,
      integratorCnpj: first.cnpj,
      pollIntervalMs: 5_000,
      tenantAllowlist: [first.tenant],
    });
    expect([...reads.values()]).toEqual(Array(7).fill(1));
  });
});
