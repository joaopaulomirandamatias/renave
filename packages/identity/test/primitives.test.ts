import { describe, expect, it } from "vitest";

import { loadOidcConfig } from "../src/config.js";
import {
  clearCookie,
  cookieNames,
  readCookie,
  serializeCookie,
} from "../src/cookies.js";
import { InMemorySessionStore } from "../src/memory-store.js";
import { codeChallengeS256 } from "../src/pkce.js";
import { sanitizeReturnTo } from "../src/return-to.js";

describe("primitivas OIDC", () => {
  it("calcula o vetor S256 da RFC 7636", () => {
    expect(
      codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it.each([
    ["/painel?pagina=2#topo", "/painel?pagina=2#topo"],
    ["//evil.test", "/"],
    ["/\\evil.test", "/"],
    ["https://evil.test/", "/"],
    ["javascript:alert(1)", "/"],
    ["/ok\r\nSet-Cookie:x=1", "/"],
    ["/api/auth/login", "/"],
  ])("higieniza returnTo %s", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it("usa cookies host-only, HttpOnly e SameSite=Lax", () => {
    const name = cookieNames(true).session;
    expect(
      serializeCookie(name, "opaque", { maxAgeSeconds: 60, secure: true }),
    ).toBe(
      "__Host-renave_session=opaque; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
    );
    expect(clearCookie(name, true)).toContain("Max-Age=0");
    expect(readCookie(`${name}=a; ${name}=b`, name)).toBeUndefined();
  });

  it("recusa configuração insegura e memória em produção", () => {
    expect(() =>
      loadOidcConfig(
        {
          OIDC_ISSUER: "http://idp.example",
          OIDC_CLIENT_ID: "client",
          OIDC_REDIRECT_URI: "https://app.test/callback",
        },
        "production",
      ),
    ).toThrow(/https/);
    expect(
      () => new InMemorySessionStore({ environment: "production" }),
    ).toThrow(/proibido em produção/);
  });

  it("normaliza a allowlist acr e recusa política ambígua", () => {
    const base = {
      OIDC_ISSUER: "https://idp.test",
      OIDC_CLIENT_ID: "client",
      OIDC_REDIRECT_URI: "https://app.test/callback",
    };
    expect(
      loadOidcConfig(
        {
          ...base,
          OIDC_MFA_ACCEPTED_ACR_VALUES:
            "urn:example:loa:2 urn:example:loa:2 urn:example:loa:3",
        },
        "homologation",
      ).mfaAcceptedAcrValues,
    ).toEqual(["urn:example:loa:2", "urn:example:loa:3"]);

    expect(() =>
      loadOidcConfig(
        {
          ...base,
          OIDC_MFA_ACCEPTED_ACR_VALUES: Array.from(
            { length: 17 },
            (_, index) => `urn:example:loa:${index}`,
          ).join(" "),
        },
        "homologation",
      ),
    ).toThrow(/OIDC_MFA_ACCEPTED_ACR_VALUES/u);
    expect(() =>
      loadOidcConfig(
        {
          ...base,
          OIDC_MFA_ACCEPTED_ACR_VALUES: "urn:example:nível:2",
        },
        "homologation",
      ),
    ).toThrow(/OIDC_MFA_ACCEPTED_ACR_VALUES/u);
  });

  it("consome tentativa em memória uma única vez e descarta expirada", async () => {
    const store = new InMemorySessionStore({ environment: "test" });
    const attempt = {
      codeVerifier: "v",
      nonceHash: "n",
      bindingHash: "b",
      returnTo: "/",
      createdAt: 1,
      expiresAt: 10,
    };
    await store.saveLoginAttempt("one", attempt);
    expect(await store.consumeLoginAttempt("one", 2)).toEqual(attempt);
    expect(await store.consumeLoginAttempt("one", 2)).toBeUndefined();
    await store.saveLoginAttempt("expired", attempt);
    expect(await store.consumeLoginAttempt("expired", 10)).toBeUndefined();
  });
});
