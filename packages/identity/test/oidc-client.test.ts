import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOidcClient,
  OidcClientError,
  type FetchLike,
} from "../src/oidc-client.js";
import { testConfig } from "./helpers.js";

const NOW = 1_700_000_000_000;

function key(kid: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      alg: "RS256",
      kid,
      use: "sig",
    },
  };
}

function jwt(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  alg = "RS256",
): string {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = sign(
    "sha256",
    Buffer.from(data, "ascii"),
    privateKey,
  ).toString("base64url");
  return `${data}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://idp.test/realms/renave",
    aud: "seu-renave-bff",
    sub: "subject-1",
    nonce: "nonce-1",
    exp: NOW / 1_000 + 300,
    iat: NOW / 1_000,
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function provider(options: {
  token: string;
  jwks: unknown[];
  secondJwks?: unknown[];
}) {
  let jwksCalls = 0;
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    expect(init?.redirect).toBe("error");
    if (input.endsWith("/.well-known/openid-configuration")) {
      return response({
        issuer: "https://idp.test/realms/renave",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
      });
    }
    if (input === "https://idp.test/token") {
      expect(init?.method).toBe("POST");
      expect(init?.headers?.authorization).toBe(
        `Basic ${Buffer.from("seu-renave-bff:client+secret").toString("base64")}`,
      );
      return response({ id_token: options.token });
    }
    if (input === "https://idp.test/jwks") {
      jwksCalls += 1;
      return response({
        keys:
          jwksCalls === 1 || !options.secondJwks
            ? options.jwks
            : options.secondJwks,
      });
    }
    throw new Error(`URL inesperada: ${input}`);
  });
  return { fetch, getJwksCalls: () => jwksCalls };
}

async function exchange(token: string, jwks: unknown[]) {
  const fake = provider({ token, jwks });
  const client = createOidcClient({
    config: testConfig(),
    fetch: fake.fetch,
    now: () => NOW,
  });
  return client.exchangeCode({
    code: "code",
    codeVerifier: "v".repeat(43),
    redirectUri: "https://app.test/api/auth/callback",
  });
}

describe("cliente OIDC", () => {
  it("monta authorization code + PKCE e valida um ID token assinado", async () => {
    const signing = key("key-1");
    const token = jwt(
      signing.privateKey,
      "key-1",
      claims({ acr: "urn:example:loa:2" }),
    );
    const fake = provider({ token, jwks: [signing.publicJwk] });
    const client = createOidcClient({
      config: testConfig({
        mfaAcceptedAcrValues: ["urn:example:loa:2", "urn:example:loa:3"],
      }),
      fetch: fake.fetch,
      now: () => NOW,
    });
    const authorization = new URL(
      await client.buildAuthorizationUrl({
        state: "state",
        nonce: "nonce-1",
        codeChallenge: "challenge",
        redirectUri: "https://app.test/api/auth/callback",
      }),
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("acr_values")).toBe(
      "urn:example:loa:2 urn:example:loa:3",
    );

    await expect(
      client.exchangeCode({
        code: "code",
        codeVerifier: "v".repeat(43),
        redirectUri: "https://app.test/api/auth/callback",
      }),
    ).resolves.toMatchObject({
      authenticationContext: "urn:example:loa:2",
      subject: "subject-1",
      nonce: "nonce-1",
    });
  });

  it.each([
    ["vazio", ""],
    ["array", ["urn:example:loa:2"]],
    ["longo", "a".repeat(513)],
    ["com controle", "urn:example:\nloa:2"],
    ["com espaço", "urn:example:loa 2"],
    ["com unicode", "urn:example:nível:2"],
    ["com borda em branco", " urn:example:loa:2"],
  ])("recusa claim acr malformado: %s", async (_label, acr) => {
    const signing = key("key-1");
    await expect(
      exchange(jwt(signing.privateKey, "key-1", claims({ acr })), [
        signing.publicJwk,
      ]),
    ).rejects.toBeInstanceOf(OidcClientError);
  });

  it("mantém acr ausente como ausência de evidência", async () => {
    const signing = key("key-1");
    await expect(
      exchange(jwt(signing.privateKey, "key-1", claims()), [signing.publicJwk]),
    ).resolves.not.toHaveProperty("authenticationContext");
  });

  it.each([
    ["issuer", { iss: "https://evil.test" }],
    ["audience", { aud: "other" }],
    ["azp", { aud: ["seu-renave-bff", "other"], azp: "other" }],
    ["expiração", { exp: NOW / 1_000 - 61 }],
    ["iat ausente", { iat: undefined }],
    ["iat futuro", { iat: NOW / 1_000 + 61 }],
    ["nbf futuro", { nbf: NOW / 1_000 + 61 }],
    ["nbf malformado", { nbf: "amanhã" }],
  ])("recusa claim inválida: %s", async (_label, override) => {
    const signing = key("key-1");
    await expect(
      exchange(jwt(signing.privateKey, "key-1", claims(override)), [
        signing.publicJwk,
      ]),
    ).rejects.toBeInstanceOf(OidcClientError);
  });

  it("recusa algoritmo não permitido, token enorme e JWKS excessivo", async () => {
    const signing = key("key-1");
    await expect(
      exchange(jwt(signing.privateKey, "key-1", claims(), "HS256"), [
        signing.publicJwk,
      ]),
    ).rejects.toBeInstanceOf(OidcClientError);
    await expect(
      exchange("x".repeat(65_537), [signing.publicJwk]),
    ).rejects.toBeInstanceOf(OidcClientError);
    await expect(
      exchange(
        jwt(signing.privateKey, "key-1", claims()),
        Array.from({ length: 101 }, () => signing.publicJwk),
      ),
    ).rejects.toBeInstanceOf(OidcClientError);
  });

  it("faz um único refresh imediato quando o kid gira", async () => {
    const old = key("old");
    const current = key("current");
    const token = jwt(current.privateKey, "current", claims());
    const fake = provider({
      token,
      jwks: [old.publicJwk],
      secondJwks: [current.publicJwk],
    });
    const client = createOidcClient({
      config: testConfig(),
      fetch: fake.fetch,
      now: () => NOW,
    });
    await expect(
      client.exchangeCode({
        code: "code",
        codeVerifier: "v".repeat(43),
        redirectUri: "https://app.test/api/auth/callback",
      }),
    ).resolves.toMatchObject({ subject: "subject-1" });
    expect(fake.getJwksCalls()).toBe(2);
  });

  it("não deixa discovery HTTP local apontar para outro host", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      response({
        issuer: "http://127.0.0.1:8080/issuer",
        authorization_endpoint: "http://169.254.169.254/authorize",
        token_endpoint: "http://127.0.0.1:8080/token",
        jwks_uri: "http://127.0.0.1:8080/jwks",
      }),
    );
    const client = createOidcClient({
      config: testConfig({ issuer: "http://127.0.0.1:8080/issuer" }),
      fetch,
      now: () => NOW,
    });

    await expect(
      client.buildAuthorizationUrl({
        state: "state",
        nonce: "nonce",
        codeChallenge: "challenge",
        redirectUri: "https://app.test/api/auth/callback",
      }),
    ).rejects.toBeInstanceOf(OidcClientError);
  });

  it("interrompe resposta OIDC acima do limite antes do parse", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response("x".repeat(1_048_577), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    const client = createOidcClient({
      config: testConfig(),
      fetch,
      now: () => NOW,
    });

    await expect(
      client.buildAuthorizationUrl({
        state: "state",
        nonce: "nonce",
        codeChallenge: "challenge",
        redirectUri: "https://app.test/api/auth/callback",
      }),
    ).rejects.toBeInstanceOf(OidcClientError);
  });
});
