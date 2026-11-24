import type { OidcConfig } from "../src/config.js";
import { codeChallengeS256 } from "../src/pkce.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  OidcClient,
  VerifiedIdentity,
} from "../src/ports.js";

export function testConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: "https://idp.test/realms/renave",
    clientId: "seu-renave-bff",
    clientSecret: "client secret",
    redirectUri: "https://app.test/api/auth/callback",
    postLogoutRedirectUri: undefined,
    scopes: ["openid", "profile", "email"],
    mfaAcceptedAcrValues: [],
    publicOrigin: "https://app.test",
    loginAttemptTtlSeconds: 300,
    sessionIdleTtlSeconds: 1_800,
    sessionAbsoluteTtlSeconds: 43_200,
    httpTimeoutMs: 5_000,
    ...overrides,
  };
}

export function manualClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

export interface FakeOidc extends OidcClient {
  authorize(
    url: string,
    identity?: Partial<VerifiedIdentity>,
  ): {
    code: string;
    state: string;
  };
  forceNonce(value: string | undefined): void;
  exchanges: CodeExchange[];
}

export function fakeOidc(): FakeOidc {
  const pending = new Map<
    string,
    { request: AuthorizationRequest; identity: VerifiedIdentity }
  >();
  const exchanges: CodeExchange[] = [];
  let forcedNonce: { value: string | undefined } | undefined;
  let sequence = 0;
  return {
    exchanges,
    forceNonce(value) {
      forcedNonce = { value };
    },
    async buildAuthorizationUrl(request) {
      const url = new URL("https://idp.test/authorize");
      for (const [name, value] of Object.entries(request)) {
        url.searchParams.set(name, value);
      }
      return url.href;
    },
    authorize(url, identity = {}) {
      const parsed = new URL(url);
      const request: AuthorizationRequest = {
        state: parsed.searchParams.get("state") ?? "",
        nonce: parsed.searchParams.get("nonce") ?? "",
        codeChallenge: parsed.searchParams.get("codeChallenge") ?? "",
        redirectUri: parsed.searchParams.get("redirectUri") ?? "",
      };
      const code = `code-${++sequence}`;
      pending.set(code, {
        request,
        identity: {
          subject: "subject-1",
          nonce: request.nonce,
          name: "Maria Operadora",
          email: "maria@example.invalid",
          roles: ["idp-role"],
          ...identity,
        },
      });
      return { code, state: request.state };
    },
    async exchangeCode(exchange) {
      exchanges.push(exchange);
      const entry = pending.get(exchange.code);
      pending.delete(exchange.code);
      if (
        !entry ||
        entry.request.redirectUri !== exchange.redirectUri ||
        entry.request.codeChallenge !== codeChallengeS256(exchange.codeVerifier)
      ) {
        throw new Error("invalid_grant");
      }
      return {
        ...entry.identity,
        nonce: forcedNonce ? forcedNonce.value : entry.identity.nonce,
      };
    },
  };
}
