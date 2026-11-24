import {
  constants,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import type { OidcConfig } from "./config.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  OidcClient,
  VerifiedIdentity,
} from "./ports.js";

/**
 * Erro genérico do cliente OIDC. Mensagens são fixas e nunca incluem valores
 * recebidos do IdP, URLs completas, códigos ou tokens.
 */
export class OidcClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcClientError";
  }
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "error" | "follow" | "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface OidcClientOptions {
  config: OidcConfig;
  fetch?: FetchLike;
  now?: () => number;
  /** Tolerância de relógio em segundos. */
  clockSkewSeconds?: number;
}

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | undefined;
}

type JwkInput = Extract<
  Parameters<typeof createPublicKey>[0],
  { format: "jwk" }
>["key"];

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [member: string]: unknown;
}

const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 600_000;
const JWKS_REFRESH_MIN_INTERVAL_MS = 30_000;
const MAX_ROLES = 100;
const MAX_CLAIM_LENGTH = 512;
const MAX_ID_TOKEN_LENGTH = 65_536;
const MAX_JWKS_KEYS = 100;
const MAX_OIDC_JSON_BYTES = 1_048_576;

type Algorithm = "RS256" | "PS256" | "ES256";
const ALGORITHMS: readonly Algorithm[] = ["RS256", "PS256", "ES256"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new OidcClientError("ID token malformado");
  }
}

function oauthFormEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function claimText(value: unknown): string | undefined {
  const text = str(value);
  return text && text.length <= MAX_CLAIM_LENGTH ? text : undefined;
}

function authenticationContext(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLAIM_LENGTH ||
    !/^[\u0021-\u007e]+$/u.test(value)
  ) {
    throw new OidcClientError("ID token: acr inválido");
  }
  return value;
}

function extractRoles(claims: Record<string, unknown>): string[] {
  const roles = new Set<string>();
  const add = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string" && item.length <= 128) roles.add(item);
    }
  };
  add(claims.roles);
  if (isRecord(claims.realm_access)) add(claims.realm_access.roles);
  return [...roles].slice(0, MAX_ROLES);
}

export function createOidcClient(options: OidcClientOptions): OidcClient {
  const { config } = options;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const skewMs = (options.clockSkewSeconds ?? 60) * 1000;

  let discovery: { value: Discovery; fetchedAt: number } | undefined;
  let jwks:
    { keys: Jwk[]; fetchedAt: number; forcedRefreshAt: number } | undefined;

  async function getJson(
    url: string,
    init: Parameters<FetchLike>[1] = {},
  ): Promise<unknown> {
    let response;
    try {
      response = await doFetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
    } catch {
      throw new OidcClientError("Falha de rede ao contatar o provedor OIDC");
    }
    if (!response.ok) {
      throw new OidcClientError(
        `Provedor OIDC respondeu HTTP ${response.status}`,
      );
    }
    try {
      const declaredLength = Number(response.headers?.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_OIDC_JSON_BYTES
      ) {
        throw new OidcClientError("Resposta do provedor OIDC excede o limite");
      }
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_OIDC_JSON_BYTES) {
            await reader.cancel();
            throw new OidcClientError(
              "Resposta do provedor OIDC excede o limite",
            );
          }
          chunks.push(value);
        }
        const body = Buffer.concat(chunks, length).toString("utf8");
        return JSON.parse(body) as unknown;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof OidcClientError) throw error;
      throw new OidcClientError("Resposta do provedor OIDC não é JSON");
    }
  }

  function endpoint(value: unknown, name: string): string {
    const text = str(value);
    let url: URL | undefined;
    try {
      url = text ? new URL(text) : undefined;
    } catch {
      url = undefined;
    }
    const issuerUrl = new URL(config.issuer);
    const allowed =
      url !== undefined &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          issuerUrl.protocol === "http:" &&
          url.origin === issuerUrl.origin));
    if (!url || !allowed || url.username !== "" || url.password !== "") {
      throw new OidcClientError(`Discovery inválido: ${name}`);
    }
    return url.href;
  }

  async function getDiscovery(): Promise<Discovery> {
    if (discovery && now() - discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return discovery.value;
    }
    const url = `${config.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
    const body = await getJson(url);
    if (!isRecord(body) || body.issuer !== config.issuer) {
      throw new OidcClientError("Discovery: issuer divergente");
    }
    const value: Discovery = {
      authorizationEndpoint: endpoint(
        body.authorization_endpoint,
        "authorization_endpoint",
      ),
      tokenEndpoint: endpoint(body.token_endpoint, "token_endpoint"),
      jwksUri: endpoint(body.jwks_uri, "jwks_uri"),
      endSessionEndpoint: body.end_session_endpoint
        ? endpoint(body.end_session_endpoint, "end_session_endpoint")
        : undefined,
    };
    discovery = { value, fetchedAt: now() };
    return value;
  }

  async function loadKeys(force: boolean): Promise<Jwk[]> {
    const current = jwks;
    if (current && !force && now() - current.fetchedAt < JWKS_TTL_MS) {
      return current.keys;
    }
    // Anti-abuso: um kid desconhecido não pode forçar um fetch por requisição.
    if (
      current &&
      force &&
      current.forcedRefreshAt > 0 &&
      now() - current.forcedRefreshAt < JWKS_REFRESH_MIN_INTERVAL_MS
    ) {
      return current.keys;
    }
    const { jwksUri } = await getDiscovery();
    const attemptedAt = now();
    const body = await getJson(jwksUri);
    if (
      !isRecord(body) ||
      !Array.isArray(body.keys) ||
      body.keys.length > MAX_JWKS_KEYS
    ) {
      throw new OidcClientError("JWKS inválido");
    }
    const keys = body.keys.filter(isRecord) as Jwk[];
    jwks = {
      keys,
      fetchedAt: attemptedAt,
      forcedRefreshAt: force ? attemptedAt : (current?.forcedRefreshAt ?? 0),
    };
    return keys;
  }

  async function findKey(
    kid: string | undefined,
    alg: Algorithm,
  ): Promise<KeyObject> {
    const keyType = alg === "ES256" ? "EC" : "RSA";
    const matches = (keys: Jwk[]) =>
      keys.filter(
        (key) =>
          key.kty === keyType &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === alg) &&
          (kid === undefined || key.kid === kid),
      );

    let candidates = matches(await loadKeys(false));
    if (candidates.length === 0) candidates = matches(await loadKeys(true));
    // Exatamente uma candidata; ambiguidade (inclusive `kid` ausente com várias
    // chaves) é recusada.
    if (candidates.length !== 1) {
      throw new OidcClientError("Chave de assinatura não encontrada");
    }
    try {
      return createPublicKey({
        key: candidates[0]! as JwkInput,
        format: "jwk",
      });
    } catch {
      throw new OidcClientError("Chave de assinatura inválida");
    }
  }

  async function verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
    if (idToken.length > MAX_ID_TOKEN_LENGTH) {
      throw new OidcClientError("ID token excede o limite permitido");
    }
    const parts = idToken.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => part.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(part))
    ) {
      throw new OidcClientError("ID token malformado");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = decodeSegment(encodedHeader);
    const claims = decodeSegment(encodedPayload);
    if (!isRecord(header) || !isRecord(claims)) {
      throw new OidcClientError("ID token malformado");
    }

    // Lista fechada: recusa `none` e algoritmos simétricos (HS*).
    const alg = ALGORITHMS.find((candidate) => candidate === header.alg);
    if (!alg) throw new OidcClientError("Algoritmo de ID token não permitido");

    const key = await findKey(str(header.kid), alg);
    const data = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    const signature = Buffer.from(encodedSignature, "base64url");
    const valid =
      alg === "ES256"
        ? verifySignature(
            "sha256",
            data,
            { key, dsaEncoding: "ieee-p1363" },
            signature,
          )
        : alg === "PS256"
          ? verifySignature(
              "sha256",
              data,
              {
                key,
                padding: constants.RSA_PKCS1_PSS_PADDING,
                saltLength: 32,
              },
              signature,
            )
          : verifySignature("sha256", data, key, signature);
    if (!valid) throw new OidcClientError("Assinatura do ID token inválida");

    if (claims.iss !== config.issuer) {
      throw new OidcClientError("ID token: issuer inválido");
    }
    const audience = claims.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (!audiences.includes(config.clientId)) {
      throw new OidcClientError("ID token: audience inválida");
    }
    if (audiences.length > 1 && claims.azp !== config.clientId) {
      throw new OidcClientError("ID token: azp inválido");
    }
    const nowMs = now();
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs - skewMs) {
      throw new OidcClientError("ID token expirado");
    }
    if (
      !Number.isInteger(claims.iat) ||
      (claims.iat as number) * 1000 > nowMs + skewMs
    ) {
      throw new OidcClientError("ID token emitido no futuro");
    }
    if (claims.nbf !== undefined) {
      if (!Number.isInteger(claims.nbf)) {
        throw new OidcClientError("ID token: nbf inválido");
      }
      if ((claims.nbf as number) * 1000 > nowMs + skewMs) {
        throw new OidcClientError("ID token ainda não válido");
      }
    }
    const subject = claimText(claims.sub);
    if (!subject) throw new OidcClientError("ID token sem sub");

    const name = claimText(claims.name);
    const email = claimText(claims.email);
    const acr = authenticationContext(claims.acr);
    return {
      subject,
      nonce: claimText(claims.nonce),
      roles: extractRoles(claims),
      ...(acr !== undefined ? { authenticationContext: acr } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    };
  }

  return {
    async buildAuthorizationUrl(request: AuthorizationRequest) {
      const { authorizationEndpoint } = await getDiscovery();
      const url = new URL(authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", request.redirectUri);
      url.searchParams.set("scope", config.scopes.join(" "));
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (config.mfaAcceptedAcrValues.length > 0) {
        url.searchParams.set(
          "acr_values",
          config.mfaAcceptedAcrValues.join(" "),
        );
      }
      return url.href;
    },

    async exchangeCode(exchange: CodeExchange) {
      const { tokenEndpoint } = await getDiscovery();
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: exchange.code,
        redirect_uri: exchange.redirectUri,
        code_verifier: exchange.codeVerifier,
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };
      if (config.clientSecret) {
        const credentials = Buffer.from(
          `${oauthFormEncode(config.clientId)}:${oauthFormEncode(config.clientSecret)}`,
        ).toString("base64");
        headers.authorization = `Basic ${credentials}`;
      } else {
        form.set("client_id", config.clientId);
      }

      const body = await getJson(tokenEndpoint, {
        method: "POST",
        headers,
        body: form.toString(),
      });
      const idToken = isRecord(body) ? str(body.id_token) : undefined;
      if (!idToken) throw new OidcClientError("Resposta sem id_token");
      // access_token e refresh_token são ignorados e descartados: a sessão
      // guarda apenas claims de identidade.
      return verifyIdToken(idToken);
    },

    async buildEndSessionUrl() {
      const { endSessionEndpoint } = await getDiscovery();
      if (!endSessionEndpoint || !config.postLogoutRedirectUri)
        return undefined;
      const url = new URL(endSessionEndpoint);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set(
        "post_logout_redirect_uri",
        config.postLogoutRedirectUri,
      );
      return url.href;
    },
  };
}
