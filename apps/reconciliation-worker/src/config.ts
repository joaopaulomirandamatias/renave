const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface DisabledWorkerConfig {
  mode: "disabled";
}

export interface EnabledWorkerConfig {
  activeProjectionKeyId: string;
  appEnvironment: "homologation";
  databaseTlsCaFile: string | undefined;
  databaseUrl: string;
  dryRun: boolean;
  healthPort: number;
  heartbeatIntervalMs: number;
  integratorCnpj: string;
  leaseOwner: string;
  limiterHmacKeyBase64: string;
  mtlsCaFile: string;
  mtlsCertificateFile: string;
  mtlsKeyFile: string;
  mtlsKeyPassphrase: string | undefined;
  mode: "enabled";
  pollIntervalMs: number;
  projectionKeysBase64: readonly Readonly<{
    keyBase64: string;
    keyId: string;
  }>[];
  tenantAllowlist: readonly string[];
}

export type ReconciliationWorkerAppConfig =
  DisabledWorkerConfig | EnabledWorkerConfig;

export class ReconciliationWorkerAppConfigError extends Error {
  override name = "ReconciliationWorkerAppConfigError";

  constructor() {
    super("Configuração do app de reconciliação inválida");
  }
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ReconciliationWorkerAppConfigError();
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value) {
    throw new ReconciliationWorkerAppConfigError();
  }
  return value;
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new ReconciliationWorkerAppConfigError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ReconciliationWorkerAppConfigError();
  }
  return parsed;
}

function tenantAllowlist(value: string): readonly string[] {
  const tenants = value.split(",");
  if (
    tenants.length === 0 ||
    tenants.some((tenant) => !UUID_PATTERN.test(tenant)) ||
    new Set(tenants).size !== tenants.length
  ) {
    throw new ReconciliationWorkerAppConfigError();
  }
  return Object.freeze([...tenants]);
}

function projectionKeys(
  value: string,
): EnabledWorkerConfig["projectionKeysBase64"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReconciliationWorkerAppConfigError();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new ReconciliationWorkerAppConfigError();
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ReconciliationWorkerAppConfigError();
  }
  for (const [keyId, encoded] of entries) {
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      typeof encoded !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)
    ) {
      throw new ReconciliationWorkerAppConfigError();
    }
    const decoded = Buffer.from(encoded, "base64");
    try {
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
        throw new ReconciliationWorkerAppConfigError();
      }
    } finally {
      decoded.fill(0);
    }
  }
  return Object.freeze(
    entries.map(([keyId, keyBase64]) =>
      Object.freeze({ keyBase64: keyBase64 as string, keyId }),
    ),
  );
}

function validateDatabaseUrl(
  value: string,
  tlsCaFile: string | undefined,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReconciliationWorkerAppConfigError();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search !== ""
  ) {
    throw new ReconciliationWorkerAppConfigError();
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (!loopback && !tlsCaFile) {
    throw new ReconciliationWorkerAppConfigError();
  }
}

export function loadReconciliationWorkerAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReconciliationWorkerAppConfig {
  if (!booleanValue(env.RENAVE_RECONCILIATION_WORKER_ENABLED, false)) {
    return Object.freeze({ mode: "disabled" });
  }
  if (env.APP_ENVIRONMENT !== "homologation") {
    throw new ReconciliationWorkerAppConfigError();
  }
  const databaseUrl = required(env, "RENAVE_RECONCILIATION_DATABASE_URL");
  const databaseTlsCaFile = env.RENAVE_RECONCILIATION_DATABASE_TLS_CA_FILE;
  validateDatabaseUrl(databaseUrl, databaseTlsCaFile);
  const keys = projectionKeys(
    required(env, "RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON"),
  );
  const activeProjectionKeyId = required(
    env,
    "RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID",
  );
  if (!keys.some(({ keyId }) => keyId === activeProjectionKeyId)) {
    throw new ReconciliationWorkerAppConfigError();
  }
  const leaseOwner = required(env, "RENAVE_RECONCILIATION_LEASE_OWNER");
  if (!UUID_PATTERN.test(leaseOwner)) {
    throw new ReconciliationWorkerAppConfigError();
  }
  return Object.freeze({
    activeProjectionKeyId,
    appEnvironment: "homologation" as const,
    databaseTlsCaFile,
    databaseUrl,
    dryRun: booleanValue(env.RENAVE_RECONCILIATION_WORKER_DRY_RUN, true),
    healthPort: integerValue(
      env.RENAVE_RECONCILIATION_HEALTH_PORT,
      9464,
      1,
      65_535,
    ),
    heartbeatIntervalMs: integerValue(
      env.RENAVE_RECONCILIATION_HEARTBEAT_MS,
      30_000,
      1_000,
      60_000,
    ),
    integratorCnpj: required(env, "RENAVE_INTEGRATOR_CNPJ"),
    leaseOwner,
    limiterHmacKeyBase64: required(env, "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64"),
    mode: "enabled" as const,
    mtlsCaFile: required(env, "RENAVE_MTLS_CA_FILE"),
    mtlsCertificateFile: required(env, "RENAVE_MTLS_CERT_FILE"),
    mtlsKeyFile: required(env, "RENAVE_MTLS_KEY_FILE"),
    mtlsKeyPassphrase: env.RENAVE_MTLS_KEY_PASSPHRASE,
    pollIntervalMs: integerValue(
      env.RENAVE_RECONCILIATION_POLL_MS,
      5_000,
      250,
      300_000,
    ),
    projectionKeysBase64: keys,
    tenantAllowlist: tenantAllowlist(
      required(env, "RENAVE_RECONCILIATION_TENANT_ALLOWLIST"),
    ),
  });
}
