export type IdentityEnvironment = "development" | "homologation" | "production";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Opcional: cliente público com PKCE dispensa segredo. */
  clientSecret: string | undefined;
  redirectUri: string;
  postLogoutRedirectUri: string | undefined;
  scopes: readonly string[];
  /** Origem pública da aplicação (derivada de `redirectUri`), usada no CSRF do logout. */
  publicOrigin: string;
  loginAttemptTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  httpTimeoutMs: number;
}

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

const REQUIRED = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_REDIRECT_URI",
] as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function secureUrl(
  name: string,
  value: string,
  environment: IdentityEnvironment,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigError(`${name} não é uma URL válida`);
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    LOOPBACK.has(url.hostname) &&
    environment !== "production";
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new OidcConfigError(
      `${name} deve usar https (http só em localhost fora de produção)`,
    );
  }
  if (url.username || url.password) {
    throw new OidcConfigError(`${name} não pode conter credenciais`);
  }
  return url;
}

function seconds(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = text(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OidcConfigError(
      `${name} deve ser um inteiro entre ${min} e ${max}`,
    );
  }
  return value;
}

/**
 * Lê e valida a configuração OIDC. Falha fechada: configuração incompleta ou
 * insegura lança erro que cita só NOMES de variáveis, nunca valores.
 */
export function loadOidcConfig(
  env: NodeJS.ProcessEnv,
  environment: IdentityEnvironment,
): OidcConfig {
  const missing = REQUIRED.filter((name) => text(env[name]) === undefined);
  if (missing.length > 0) {
    throw new OidcConfigError(
      `Configuração OIDC incompleta; defina: ${missing.join(", ")}`,
    );
  }

  const issuerUrl = secureUrl(
    "OIDC_ISSUER",
    text(env.OIDC_ISSUER)!,
    environment,
  );
  if (issuerUrl.search || issuerUrl.hash) {
    throw new OidcConfigError("OIDC_ISSUER não pode ter query nem fragmento");
  }
  const redirect = secureUrl(
    "OIDC_REDIRECT_URI",
    text(env.OIDC_REDIRECT_URI)!,
    environment,
  );
  if (redirect.hash) {
    throw new OidcConfigError("OIDC_REDIRECT_URI não pode ter fragmento");
  }
  const logoutRaw = text(env.OIDC_POST_LOGOUT_REDIRECT_URI);
  const logout = logoutRaw
    ? secureUrl("OIDC_POST_LOGOUT_REDIRECT_URI", logoutRaw, environment)
    : undefined;
  if (logout && logout.origin !== redirect.origin) {
    throw new OidcConfigError(
      "OIDC_POST_LOGOUT_REDIRECT_URI deve ter a mesma origem de OIDC_REDIRECT_URI",
    );
  }

  const scopes = (text(env.OIDC_SCOPES) ?? "openid profile email")
    .split(/\s+/u)
    .filter(Boolean);
  if (!scopes.includes("openid")) {
    throw new OidcConfigError("OIDC_SCOPES deve incluir openid");
  }

  const idle = seconds(env, "SESSION_IDLE_TTL_SECONDS", 1_800, 60, 86_400);
  const absolute = seconds(
    env,
    "SESSION_ABSOLUTE_TTL_SECONDS",
    43_200,
    300,
    604_800,
  );
  if (idle > absolute) {
    throw new OidcConfigError(
      "SESSION_IDLE_TTL_SECONDS não pode exceder SESSION_ABSOLUTE_TTL_SECONDS",
    );
  }

  return {
    // O issuer é comparado literalmente com o do discovery; não normalizar.
    issuer: text(env.OIDC_ISSUER)!,
    clientId: text(env.OIDC_CLIENT_ID)!,
    clientSecret: text(env.OIDC_CLIENT_SECRET),
    redirectUri: redirect.href,
    postLogoutRedirectUri: logout?.href,
    scopes,
    publicOrigin: redirect.origin,
    loginAttemptTtlSeconds: seconds(
      env,
      "OIDC_LOGIN_TTL_SECONDS",
      300,
      30,
      900,
    ),
    sessionIdleTtlSeconds: idle,
    sessionAbsoluteTtlSeconds: absolute,
    httpTimeoutMs: seconds(env, "OIDC_HTTP_TIMEOUT_MS", 10_000, 1_000, 60_000),
  };
}
