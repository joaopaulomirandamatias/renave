import { isIP } from "node:net";

import { loadOidcConfig, type OidcConfig } from "@seu-renave/identity";

import { readApiSecretFiles, type ApiSecretFiles } from "./secret-files.js";

export const appEnvironments = [
  "development",
  "homologation",
  "production",
] as const;

export type AppEnvironment = (typeof appEnvironments)[number];
export type AuthMode = "disabled" | "oidc";
export type SessionStoreKind = "memory" | "postgres";
export type ProxyTrustConfig =
  { mode: "direct" } | { cidrs: readonly string[]; mode: "trusted-proxy" };

export interface EvidenceKeyringConfig {
  activeKeyId: string;
  keys: readonly Readonly<{ keyBase64: string; keyId: string }>[];
}

export type RenaveMtlsMaterialConfig =
  | {
      caFile: string;
      certificateFile: string;
      keyFile: string;
      kind: "files";
    }
  | {
      ca: string;
      certificate: string;
      key: string;
      kind: "material";
    };

export interface RenaveIntegrationConfig {
  evidenceKeyring: EvidenceKeyringConfig;
  integratorCnpj: string;
  keyPassphrase: string | undefined;
  mtls: RenaveMtlsMaterialConfig;
}

export interface AppConfig {
  appEnvironment: AppEnvironment;
  authMode: AuthMode;
  /** Presente se, e somente se, `authMode === "oidc"`. */
  oidc: OidcConfig | undefined;
  /**
   * Armazenamento de sessão escolhido explicitamente. `undefined` exige que o
   * chamador injete um `SessionStore` persistente (Redis/Postgres).
   */
  sessionStore: SessionStoreKind | undefined;
  identityDatabaseUrl: string | undefined;
  identityDatabaseTlsCa?: string | undefined;
  identityDatabaseTlsCaFile: string | undefined;
  loginRateLimitHmacKeyBase64: string | undefined;
  tenantAdminHmacKeyBase64: string | undefined;
  sessionLookupMaxConcurrency: number;
  serproQueryLimitHmacKeyBase64: string | undefined;
  /** Habilita apenas a criação cifrada em HELD_LOCAL; nunca envia ao SERPRO. */
  stockEntryLocalEnabled: boolean;
  /** Banco de negócio SaaS; independe de a integração SERPRO estar ligada. */
  databaseUrl: string | undefined;
  databaseTlsCa?: string | undefined;
  databaseTlsCaFile: string | undefined;
  renave: RenaveIntegrationConfig | undefined;
  host: string;
  port: number;
  proxyTrust: ProxyTrustConfig;
}

function parseEnvironment(value: string | undefined): AppEnvironment {
  const normalized = value?.trim().toLowerCase() ?? "development";
  if (appEnvironments.includes(normalized as AppEnvironment)) {
    return normalized as AppEnvironment;
  }
  throw new Error(`APP_ENVIRONMENT inválido: ${normalized}`);
}

function parseAuthMode(value: string | undefined): AuthMode {
  const normalized = value?.trim().toLowerCase() ?? "disabled";
  if (normalized === "disabled" || normalized === "oidc") return normalized;
  throw new Error(`AUTH_MODE inválido: ${normalized}`);
}

function parseSessionStore(
  value: string | undefined,
  appEnvironment: AppEnvironment,
): SessionStoreKind | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized !== "memory" && normalized !== "postgres") {
    throw new Error(`SESSION_STORE inválido: ${normalized}`);
  }
  if (normalized === "memory" && appEnvironment === "production") {
    throw new Error(
      "SESSION_STORE=memory é proibido em produção; use um armazenamento persistente",
    );
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function validCidr(value: string): boolean {
  const separator = value.lastIndexOf("/");
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const version = isIP(address);
  return (
    version !== 0 &&
    Number.isInteger(prefix) &&
    prefix >= 0 &&
    prefix <= (version === 4 ? 32 : 128)
  );
}

function parseProxyTrust(
  modeValue: string | undefined,
  cidrsValue: string | undefined,
  appEnvironment: AppEnvironment,
  authMode: AuthMode,
): ProxyTrustConfig {
  const mode = optionalText(modeValue)?.toLowerCase();
  if (!mode) {
    if (appEnvironment !== "development" && authMode === "oidc") {
      throw new Error("OIDC fora de desenvolvimento exige PROXY_MODE");
    }
    return { mode: "direct" };
  }
  if (mode === "direct") return { mode: "direct" };
  if (mode !== "trusted-proxy") {
    throw new Error("PROXY_MODE deve ser direct ou trusted-proxy");
  }
  const cidrs = (cidrsValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (cidrs.length === 0 || cidrs.some((value) => !validCidr(value))) {
    throw new Error("TRUSTED_PROXY_CIDRS deve conter CIDRs válidos");
  }
  return { cidrs: [...new Set(cidrs)], mode: "trusted-proxy" };
}

function validateDatabaseUrl(
  name: "DATABASE_URL" | "IDENTITY_DATABASE_URL",
  connectionString: string | undefined,
  tlsCaFile: string | undefined,
  appEnvironment: AppEnvironment,
): void {
  if (!connectionString) return;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${name} inválida`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} deve usar postgres ou postgresql`);
  }
  const forbiddenTlsParameters = [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
  ];
  if (
    forbiddenTlsParameters.some((parameter) => url.searchParams.has(parameter))
  ) {
    throw new Error(`${name} não deve controlar TLS por query string`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (appEnvironment !== "development" && !loopback && !tlsCaFile) {
    throw new Error(`${name} remota exige arquivo de CA TLS`);
  }
}

function integrationEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("RENAVE_INTEGRATION_ENABLED deve ser true ou false");
}

function stockEntryLocalEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("RENAVE_STOCK_ENTRY_LOCAL_ENABLED deve ser true ou false");
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CANONICAL_32_BYTE_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function validKeyMaterial(value: string): boolean {
  if (!CANONICAL_32_BYTE_BASE64.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  try {
    return decoded.byteLength === 32 && decoded.toString("base64") === value;
  } finally {
    decoded.fill(0);
  }
}

function parseEvidenceKeyring(value: string): EvidenceKeyringConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Keyring de evidência inválido");
  }
  if (
    !plainObject(parsed) ||
    !exactKeys(parsed, ["activeKeyId", "keys", "version"]) ||
    parsed.version !== 1 ||
    typeof parsed.activeKeyId !== "string" ||
    !KEY_ID.test(parsed.activeKeyId) ||
    !Array.isArray(parsed.keys)
  ) {
    throw new Error("Keyring de evidência inválido");
  }
  const entries = parsed.keys;
  const uniqueIds = new Set<string>();
  const uniqueMaterial = new Set<string>();
  if (entries.length < 1 || entries.length > 8) {
    throw new Error("Keyring de evidência inválido");
  }
  const keys = entries.map((entry) => {
    if (
      !plainObject(entry) ||
      !exactKeys(entry, ["keyBase64", "keyId"]) ||
      typeof entry.keyId !== "string" ||
      typeof entry.keyBase64 !== "string"
    ) {
      throw new Error("Keyring de evidência inválido");
    }
    const { keyBase64, keyId } = entry;
    if (
      !KEY_ID.test(keyId) ||
      !validKeyMaterial(keyBase64) ||
      uniqueIds.has(keyId) ||
      uniqueMaterial.has(keyBase64)
    ) {
      throw new Error("Keyring de evidência inválido");
    }
    uniqueIds.add(keyId);
    uniqueMaterial.add(keyBase64);
    return Object.freeze({ keyBase64, keyId });
  });
  if (!uniqueIds.has(parsed.activeKeyId)) {
    throw new Error("Keyring de evidência inválido");
  }
  return Object.freeze({
    activeKeyId: parsed.activeKeyId,
    keys: Object.freeze(keys),
  });
}

function singleEvidenceKeyring(
  keyId: string,
  keyBase64: string,
): EvidenceKeyringConfig {
  if (!KEY_ID.test(keyId) || !validKeyMaterial(keyBase64)) {
    throw new Error("Keyring de evidência inválido");
  }
  return Object.freeze({
    activeKeyId: keyId,
    keys: Object.freeze([Object.freeze({ keyBase64, keyId })]),
  });
}

function loadRenaveIntegration(
  environment: NodeJS.ProcessEnv,
  appEnvironment: AppEnvironment,
  authMode: AuthMode,
  secretFiles?: ApiSecretFiles,
): RenaveIntegrationConfig | undefined {
  if (!integrationEnabled(environment.RENAVE_INTEGRATION_ENABLED)) {
    return undefined;
  }
  if (appEnvironment !== "homologation") {
    throw new Error(
      "A integração RENAVE executável está restrita ao ambiente de homologação",
    );
  }
  if (authMode !== "oidc") {
    throw new Error("A integração RENAVE exige AUTH_MODE=oidc");
  }
  const required = [
    "DATABASE_URL",
    "RENAVE_INTEGRATOR_CNPJ",
    "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
  ] as const;
  const legacyRequired = [
    "RENAVE_MTLS_CA_FILE",
    "RENAVE_MTLS_CERT_FILE",
    "RENAVE_MTLS_KEY_FILE",
    "RENAVE_EVIDENCE_KEY_ID",
    "RENAVE_EVIDENCE_KEY_BASE64",
  ] as const;
  const missing: string[] = required.filter(
    (name) => optionalText(environment[name]) === undefined,
  );
  if (!secretFiles) {
    missing.push(
      ...legacyRequired.filter(
        (name) => optionalText(environment[name]) === undefined,
      ),
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Configuração RENAVE incompleta; defina: ${missing.join(", ")}`,
    );
  }
  if (secretFiles) {
    if (
      !secretFiles.mtlsCa ||
      !secretFiles.mtlsCertificate ||
      !secretFiles.mtlsKey ||
      !secretFiles.evidenceKeyringJson
    ) {
      throw new Error(
        "Configuração RENAVE incompleta nos arquivos secretos da API",
      );
    }
    return {
      evidenceKeyring: parseEvidenceKeyring(secretFiles.evidenceKeyringJson),
      integratorCnpj: optionalText(environment.RENAVE_INTEGRATOR_CNPJ)!,
      keyPassphrase: secretFiles.mtlsKeyPassphrase,
      mtls: Object.freeze({
        ca: secretFiles.mtlsCa,
        certificate: secretFiles.mtlsCertificate,
        key: secretFiles.mtlsKey,
        kind: "material" as const,
      }),
    };
  }
  const evidenceKeyId = optionalText(environment.RENAVE_EVIDENCE_KEY_ID)!;
  const evidenceKeyBase64 = optionalText(
    environment.RENAVE_EVIDENCE_KEY_BASE64,
  )!;
  return {
    evidenceKeyring: singleEvidenceKeyring(evidenceKeyId, evidenceKeyBase64),
    integratorCnpj: optionalText(environment.RENAVE_INTEGRATOR_CNPJ)!,
    keyPassphrase: optionalText(environment.RENAVE_MTLS_KEY_PASSPHRASE),
    mtls: Object.freeze({
      caFile: optionalText(environment.RENAVE_MTLS_CA_FILE)!,
      certificateFile: optionalText(environment.RENAVE_MTLS_CERT_FILE)!,
      keyFile: optionalText(environment.RENAVE_MTLS_KEY_FILE)!,
      kind: "files" as const,
    }),
  };
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT deve ser um inteiro entre 1 e 65535");
  }
  return port;
}

function parseSessionLookupMaxConcurrency(value: string | undefined): number {
  const concurrency = Number(value ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error(
      "SESSION_LOOKUP_MAX_CONCURRENCY deve ser um inteiro entre 1 e 6",
    );
  }
  return concurrency;
}

function withSecretValues(
  environment: NodeJS.ProcessEnv,
  secretFiles: ApiSecretFiles | undefined,
): NodeJS.ProcessEnv {
  if (!secretFiles) return environment;
  const result: NodeJS.ProcessEnv = { ...environment };
  const values = {
    DATABASE_URL: secretFiles.databaseUrl,
    IDENTITY_DATABASE_URL: secretFiles.identityDatabaseUrl,
    LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: secretFiles.loginRateLimitHmacKeyBase64,
    OIDC_CLIENT_SECRET: secretFiles.oidcClientSecret,
    SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64:
      secretFiles.serproQueryLimitHmacKeyBase64,
    TENANT_ADMIN_HMAC_KEY_BASE64: secretFiles.tenantAdminHmacKeyBase64,
  } as const;
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function parseConfig(
  sourceEnvironment: NodeJS.ProcessEnv,
  secretFiles?: ApiSecretFiles,
): AppConfig {
  const environment = withSecretValues(sourceEnvironment, secretFiles);
  const appEnvironment = parseEnvironment(environment.APP_ENVIRONMENT);
  const authMode = parseAuthMode(environment.AUTH_MODE);
  const proxyTrust = parseProxyTrust(
    environment.PROXY_MODE,
    environment.TRUSTED_PROXY_CIDRS,
    appEnvironment,
    authMode,
  );
  const sessionStore = parseSessionStore(
    environment.SESSION_STORE,
    appEnvironment,
  );
  const identityDatabaseUrl = optionalText(environment.IDENTITY_DATABASE_URL);
  const identityDatabaseTlsCaFile = optionalText(
    environment.IDENTITY_DATABASE_TLS_CA_FILE,
  );
  const identityDatabaseTlsCa = secretFiles?.identityDatabaseCa;
  const databaseUrl = optionalText(environment.DATABASE_URL);
  const databaseTlsCaFile = optionalText(environment.DATABASE_TLS_CA_FILE);
  const databaseTlsCa = secretFiles?.databaseCa;
  const loginRateLimitHmacKeyBase64 = optionalText(
    environment.LOGIN_RATE_LIMIT_HMAC_KEY_BASE64,
  );
  const serproQueryLimitHmacKeyBase64 = optionalText(
    environment.SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64,
  );
  const tenantAdminHmacKeyBase64 = optionalText(
    environment.TENANT_ADMIN_HMAC_KEY_BASE64,
  );
  const enableStockEntryLocal = stockEntryLocalEnabled(
    environment.RENAVE_STOCK_ENTRY_LOCAL_ENABLED,
  );
  const renave = loadRenaveIntegration(
    environment,
    appEnvironment,
    authMode,
    secretFiles,
  );

  validateDatabaseUrl(
    "IDENTITY_DATABASE_URL",
    identityDatabaseUrl,
    identityDatabaseTlsCaFile ?? identityDatabaseTlsCa,
    appEnvironment,
  );
  validateDatabaseUrl(
    "DATABASE_URL",
    databaseUrl,
    databaseTlsCaFile ?? databaseTlsCa,
    appEnvironment,
  );

  if (appEnvironment === "production" && authMode !== "oidc") {
    throw new Error("AUTH_MODE=oidc é obrigatório em produção");
  }
  if (sessionStore === "postgres" && !identityDatabaseUrl) {
    throw new Error("SESSION_STORE=postgres exige IDENTITY_DATABASE_URL");
  }
  if (appEnvironment === "production" && sessionStore !== "postgres") {
    throw new Error("Produção exige SESSION_STORE=postgres");
  }
  if (appEnvironment === "production" && authMode === "oidc" && !databaseUrl) {
    throw new Error("Produção OIDC exige DATABASE_URL");
  }
  if (loginRateLimitHmacKeyBase64 && !identityDatabaseUrl) {
    throw new Error(
      "LOGIN_RATE_LIMIT_HMAC_KEY_BASE64 exige IDENTITY_DATABASE_URL",
    );
  }
  if (tenantAdminHmacKeyBase64 && !databaseUrl) {
    throw new Error("TENANT_ADMIN_HMAC_KEY_BASE64 exige DATABASE_URL");
  }
  if (
    appEnvironment !== "development" &&
    authMode === "oidc" &&
    !loginRateLimitHmacKeyBase64
  ) {
    throw new Error(
      "OIDC fora de desenvolvimento exige LOGIN_RATE_LIMIT_HMAC_KEY_BASE64",
    );
  }
  if (
    appEnvironment !== "development" &&
    authMode === "oidc" &&
    databaseUrl &&
    !tenantAdminHmacKeyBase64
  ) {
    throw new Error(
      "Banco SaaS fora de desenvolvimento exige TENANT_ADMIN_HMAC_KEY_BASE64",
    );
  }
  if (enableStockEntryLocal) {
    if (appEnvironment !== "homologation") {
      throw new Error(
        "RENAVE_STOCK_ENTRY_LOCAL_ENABLED está restrito à homologação",
      );
    }
    if (authMode !== "oidc") {
      throw new Error("A entrada de estoque local exige AUTH_MODE=oidc");
    }
    if (sessionStore !== "postgres" || !identityDatabaseUrl) {
      throw new Error(
        "A entrada de estoque local exige SESSION_STORE=postgres e IDENTITY_DATABASE_URL",
      );
    }
    if (!databaseUrl) {
      throw new Error("A entrada de estoque local exige DATABASE_URL");
    }
  }

  return {
    appEnvironment,
    authMode,
    // Falha fechada: AUTH_MODE=oidc com variáveis ausentes ou inseguras aborta.
    oidc:
      authMode === "oidc"
        ? loadOidcConfig(environment, appEnvironment)
        : undefined,
    sessionStore,
    identityDatabaseUrl,
    identityDatabaseTlsCa,
    identityDatabaseTlsCaFile,
    loginRateLimitHmacKeyBase64,
    tenantAdminHmacKeyBase64,
    sessionLookupMaxConcurrency: parseSessionLookupMaxConcurrency(
      environment.SESSION_LOOKUP_MAX_CONCURRENCY,
    ),
    serproQueryLimitHmacKeyBase64,
    stockEntryLocalEnabled: enableStockEntryLocal,
    databaseUrl,
    databaseTlsCa,
    databaseTlsCaFile,
    renave,
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    proxyTrust,
  };
}

/** Parser síncrono mantido para desenvolvimento e testes puros. */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return parseConfig(environment);
}

const RAW_SECRET_ENV_NAMES = Object.freeze([
  "DATABASE_TLS_CA_FILE",
  "DATABASE_URL",
  "IDENTITY_DATABASE_TLS_CA_FILE",
  "IDENTITY_DATABASE_URL",
  "LOGIN_RATE_LIMIT_HMAC_KEY_BASE64",
  "OIDC_CLIENT_SECRET",
  "RENAVE_EVIDENCE_KEY_BASE64",
  "RENAVE_EVIDENCE_KEY_ID",
  "RENAVE_MTLS_CA_FILE",
  "RENAVE_MTLS_CERT_FILE",
  "RENAVE_MTLS_KEY_FILE",
  "RENAVE_MTLS_KEY_PASSPHRASE",
  "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
  "TENANT_ADMIN_HMAC_KEY_BASE64",
] as const);

function hasOperationalCapability(environment: NodeJS.ProcessEnv): boolean {
  return (
    parseAuthMode(environment.AUTH_MODE) === "oidc" ||
    integrationEnabled(environment.RENAVE_INTEGRATION_ENABLED) ||
    stockEntryLocalEnabled(environment.RENAVE_STOCK_ENTRY_LOCAL_ENABLED)
  );
}

/**
 * Entrada usada pelo processo da API. Fora de desenvolvimento, qualquer
 * capability operacional lê segredos exclusivamente do mount fixo.
 */
export async function loadAppConfig(
  environment: NodeJS.ProcessEnv = process.env,
  loadSecrets: () => Promise<ApiSecretFiles> = readApiSecretFiles,
): Promise<AppConfig> {
  const appEnvironment = parseEnvironment(environment.APP_ENVIRONMENT);
  if (appEnvironment === "development") {
    return parseConfig(environment);
  }
  try {
    if (RAW_SECRET_ENV_NAMES.some((name) => Object.hasOwn(environment, name))) {
      throw new Error("Configuração secreta da API inválida");
    }
    if (!hasOperationalCapability(environment)) return parseConfig(environment);
    const secretFiles = await loadSecrets();
    return parseConfig(environment, secretFiles);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Configuração")) {
      throw error;
    }
    throw new Error("Configuração secreta da API inválida");
  }
}
