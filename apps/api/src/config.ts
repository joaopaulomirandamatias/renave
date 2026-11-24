import { isIP } from "node:net";

import { loadOidcConfig, type OidcConfig } from "@seu-renave/identity";

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

export interface RenaveIntegrationConfig {
  caFile: string;
  certificateFile: string;
  evidenceKeyBase64: string;
  evidenceKeyId: string;
  integratorCnpj: string;
  keyFile: string;
  keyPassphrase: string | undefined;
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
  identityDatabaseTlsCaFile: string | undefined;
  loginRateLimitHmacKeyBase64: string | undefined;
  sessionLookupMaxConcurrency: number;
  serproQueryLimitHmacKeyBase64: string | undefined;
  /** Banco de negócio SaaS; independe de a integração SERPRO estar ligada. */
  databaseUrl: string | undefined;
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

function loadRenaveIntegration(
  environment: NodeJS.ProcessEnv,
  appEnvironment: AppEnvironment,
  authMode: AuthMode,
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
    "RENAVE_MTLS_CA_FILE",
    "RENAVE_MTLS_CERT_FILE",
    "RENAVE_MTLS_KEY_FILE",
    "RENAVE_EVIDENCE_KEY_ID",
    "RENAVE_EVIDENCE_KEY_BASE64",
    "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
  ] as const;
  const missing = required.filter(
    (name) => optionalText(environment[name]) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Configuração RENAVE incompleta; defina: ${missing.join(", ")}`,
    );
  }
  return {
    integratorCnpj: optionalText(environment.RENAVE_INTEGRATOR_CNPJ)!,
    caFile: optionalText(environment.RENAVE_MTLS_CA_FILE)!,
    certificateFile: optionalText(environment.RENAVE_MTLS_CERT_FILE)!,
    keyFile: optionalText(environment.RENAVE_MTLS_KEY_FILE)!,
    keyPassphrase: optionalText(environment.RENAVE_MTLS_KEY_PASSPHRASE),
    evidenceKeyId: optionalText(environment.RENAVE_EVIDENCE_KEY_ID)!,
    evidenceKeyBase64: optionalText(environment.RENAVE_EVIDENCE_KEY_BASE64)!,
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

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
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
  const databaseUrl = optionalText(environment.DATABASE_URL);
  const databaseTlsCaFile = optionalText(environment.DATABASE_TLS_CA_FILE);
  const loginRateLimitHmacKeyBase64 = optionalText(
    environment.LOGIN_RATE_LIMIT_HMAC_KEY_BASE64,
  );
  const serproQueryLimitHmacKeyBase64 = optionalText(
    environment.SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64,
  );
  const renave = loadRenaveIntegration(environment, appEnvironment, authMode);

  validateDatabaseUrl(
    "IDENTITY_DATABASE_URL",
    identityDatabaseUrl,
    identityDatabaseTlsCaFile,
    appEnvironment,
  );
  validateDatabaseUrl(
    "DATABASE_URL",
    databaseUrl,
    databaseTlsCaFile,
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
  if (
    appEnvironment !== "development" &&
    authMode === "oidc" &&
    !loginRateLimitHmacKeyBase64
  ) {
    throw new Error(
      "OIDC fora de desenvolvimento exige LOGIN_RATE_LIMIT_HMAC_KEY_BASE64",
    );
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
    identityDatabaseTlsCaFile,
    loginRateLimitHmacKeyBase64,
    sessionLookupMaxConcurrency: parseSessionLookupMaxConcurrency(
      environment.SESSION_LOOKUP_MAX_CONCURRENCY,
    ),
    serproQueryLimitHmacKeyBase64,
    databaseUrl,
    databaseTlsCaFile,
    renave,
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    proxyTrust,
  };
}
