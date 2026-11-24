import {
  readReconciliationWorkerSecretFiles,
  type ReconciliationWorkerSecretFiles,
} from "./secret-files.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface DisabledWorkerConfig {
  mode: "disabled";
}

export interface EnabledWorkerConfig {
  activeProjectionKeyId: string;
  appEnvironment: "homologation";
  databaseTlsCa: string | undefined;
  databaseUrl: string;
  dryRun: boolean;
  healthPort: number;
  heartbeatIntervalMs: number;
  integratorCnpj: string;
  leaseOwner: string;
  limiterHmacKeyBase64: string;
  mtlsCa: string;
  mtlsCertificate: string;
  mtlsKey: string;
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

function validateDatabaseUrl(value: string, tlsCa: string | undefined): void {
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
  if (!loopback && !tlsCa) {
    throw new ReconciliationWorkerAppConfigError();
  }
}

const RAW_SECRET_ENV_NAMES = Object.freeze([
  "RENAVE_RECONCILIATION_DATABASE_URL",
  "RENAVE_RECONCILIATION_DATABASE_TLS_CA_FILE",
  "RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON",
  "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
  "RENAVE_MTLS_CA_FILE",
  "RENAVE_MTLS_CERT_FILE",
  "RENAVE_MTLS_KEY_FILE",
  "RENAVE_MTLS_KEY_PASSPHRASE",
] as const);

const NON_SECRET_ENV_NAMES = Object.freeze([
  "APP_ENVIRONMENT",
  "RENAVE_INTEGRATOR_CNPJ",
  "RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID",
  "RENAVE_RECONCILIATION_HEALTH_PORT",
  "RENAVE_RECONCILIATION_HEARTBEAT_MS",
  "RENAVE_RECONCILIATION_LEASE_OWNER",
  "RENAVE_RECONCILIATION_POLL_MS",
  "RENAVE_RECONCILIATION_TENANT_ALLOWLIST",
  "RENAVE_RECONCILIATION_WORKER_DRY_RUN",
  "RENAVE_RECONCILIATION_WORKER_ENABLED",
] as const);

function snapshotEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    let rawSecretPresent = false;
    for (const name of RAW_SECRET_ENV_NAMES) {
      if (Object.hasOwn(env, name)) rawSecretPresent = true;
    }
    if (rawSecretPresent) throw new ReconciliationWorkerAppConfigError();

    const snapshot: NodeJS.ProcessEnv = {};
    for (const name of NON_SECRET_ENV_NAMES) {
      const value = env[name];
      if (value !== undefined) {
        if (typeof value !== "string") {
          throw new ReconciliationWorkerAppConfigError();
        }
        snapshot[name] = value;
      }
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof ReconciliationWorkerAppConfigError) throw error;
    throw new ReconciliationWorkerAppConfigError();
  }
}

export async function loadReconciliationWorkerAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  loadSecrets: () => Promise<ReconciliationWorkerSecretFiles> = readReconciliationWorkerSecretFiles,
): Promise<ReconciliationWorkerAppConfig> {
  const snapshot = snapshotEnvironment(env);
  if (!booleanValue(snapshot.RENAVE_RECONCILIATION_WORKER_ENABLED, false)) {
    return Object.freeze({ mode: "disabled" });
  }
  if (snapshot.APP_ENVIRONMENT !== "homologation") {
    throw new ReconciliationWorkerAppConfigError();
  }
  let secrets: ReconciliationWorkerSecretFiles;
  try {
    secrets = await loadSecrets();
  } catch {
    throw new ReconciliationWorkerAppConfigError();
  }
  validateDatabaseUrl(secrets.databaseUrl, secrets.databaseCa);
  const keys = projectionKeys(secrets.projectionKeysJson);
  const activeProjectionKeyId = required(
    snapshot,
    "RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID",
  );
  if (!keys.some(({ keyId }) => keyId === activeProjectionKeyId)) {
    throw new ReconciliationWorkerAppConfigError();
  }
  const leaseOwner = required(snapshot, "RENAVE_RECONCILIATION_LEASE_OWNER");
  if (!UUID_PATTERN.test(leaseOwner)) {
    throw new ReconciliationWorkerAppConfigError();
  }
  return Object.freeze({
    activeProjectionKeyId,
    appEnvironment: "homologation" as const,
    databaseTlsCa: secrets.databaseCa,
    databaseUrl: secrets.databaseUrl,
    dryRun: booleanValue(snapshot.RENAVE_RECONCILIATION_WORKER_DRY_RUN, true),
    healthPort: integerValue(
      snapshot.RENAVE_RECONCILIATION_HEALTH_PORT,
      9464,
      1,
      65_535,
    ),
    heartbeatIntervalMs: integerValue(
      snapshot.RENAVE_RECONCILIATION_HEARTBEAT_MS,
      30_000,
      1_000,
      60_000,
    ),
    integratorCnpj: required(snapshot, "RENAVE_INTEGRATOR_CNPJ"),
    leaseOwner,
    limiterHmacKeyBase64: secrets.limiterHmacKeyBase64,
    mode: "enabled" as const,
    mtlsCa: secrets.mtlsCa,
    mtlsCertificate: secrets.mtlsCertificate,
    mtlsKey: secrets.mtlsKey,
    mtlsKeyPassphrase: secrets.mtlsKeyPassphrase,
    pollIntervalMs: integerValue(
      snapshot.RENAVE_RECONCILIATION_POLL_MS,
      5_000,
      250,
      300_000,
    ),
    projectionKeysBase64: keys,
    tenantAllowlist: tenantAllowlist(
      required(snapshot, "RENAVE_RECONCILIATION_TENANT_ALLOWLIST"),
    ),
  });
}
