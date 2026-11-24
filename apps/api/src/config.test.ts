import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const oidc = {
  AUTH_MODE: "oidc",
  OIDC_CLIENT_ID: "client",
  OIDC_ISSUER: "https://idp.test",
  OIDC_REDIRECT_URI: "https://app.test/api/auth/callback",
  PROXY_MODE: "direct",
};

describe("configuração da API", () => {
  it("valida a concorrência dedicada das consultas de sessão", () => {
    expect(loadConfig().sessionLookupMaxConcurrency).toBe(4);
    expect(
      loadConfig({ SESSION_LOOKUP_MAX_CONCURRENCY: "6" })
        .sessionLookupMaxConcurrency,
    ).toBe(6);
    expect(() => loadConfig({ SESSION_LOOKUP_MAX_CONCURRENCY: "0" })).toThrow(
      "SESSION_LOOKUP_MAX_CONCURRENCY",
    );
    expect(() => loadConfig({ SESSION_LOOKUP_MAX_CONCURRENCY: "7" })).toThrow(
      "SESSION_LOOKUP_MAX_CONCURRENCY",
    );
  });

  it("exige banco de identidade quando o store é postgres", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "homologation",
        SESSION_STORE: "postgres",
      }),
    ).toThrow("IDENTITY_DATABASE_URL");
  });

  it("mantém a integração executável restrita à homologação", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "production",
        DATABASE_URL: "postgres://app.invalid/db",
        IDENTITY_DATABASE_URL: "postgres://identity.invalid/db",
        RENAVE_INTEGRATION_ENABLED: "true",
        SESSION_STORE: "postgres",
      }),
    ).toThrow("restrita ao ambiente de homologação");
  });

  it("falha fechado e lista somente nomes das variáveis ausentes", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "homologation",
        RENAVE_INTEGRATION_ENABLED: "true",
        SESSION_STORE: "memory",
      }),
    ).toThrow(/DATABASE_URL.*RENAVE_INTEGRATOR_CNPJ/u);
  });

  it("carrega seletores de arquivos e chave sem ler segredo durante o parse", () => {
    const config = loadConfig({
      ...oidc,
      APP_ENVIRONMENT: "homologation",
      DATABASE_URL: "postgres://app.invalid/db",
      DATABASE_TLS_CA_FILE: "/run/secrets/database-ca.pem",
      IDENTITY_DATABASE_URL:
        "postgres://renave_identity_app@127.0.0.1:54317/renave",
      LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      RENAVE_EVIDENCE_KEY_BASE64: "placeholder-validado-no-runtime",
      RENAVE_EVIDENCE_KEY_ID: "key-2026-11",
      RENAVE_INTEGRATION_ENABLED: "true",
      RENAVE_INTEGRATOR_CNPJ: "11222333000181",
      RENAVE_MTLS_CA_FILE: "/run/secrets/ca.pem",
      RENAVE_MTLS_CERT_FILE: "/run/secrets/cert.pem",
      RENAVE_MTLS_KEY_FILE: "/run/secrets/key.pem",
      SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      TENANT_ADMIN_HMAC_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      SESSION_STORE: "memory",
    });

    expect(config.renave).toMatchObject({
      certificateFile: "/run/secrets/cert.pem",
      evidenceKeyId: "key-2026-11",
      integratorCnpj: "11222333000181",
    });
    expect(config.serproQueryLimitHmacKeyBase64).toBe(
      Buffer.alloc(32).toString("base64"),
    );
    expect(config.tenantAdminHmacKeyBase64).toBe(
      Buffer.alloc(32, 1).toString("base64"),
    );
  });

  it("exige segredo HMAC do rate limit em produção OIDC", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "production",
        DATABASE_URL: "postgres://app.invalid/db",
        DATABASE_TLS_CA_FILE: "/run/secrets/database-ca.pem",
        IDENTITY_DATABASE_URL: "postgres://identity.invalid/db",
        IDENTITY_DATABASE_TLS_CA_FILE: "/run/secrets/identity-ca.pem",
        SESSION_STORE: "postgres",
      }),
    ).toThrow("LOGIN_RATE_LIMIT_HMAC_KEY_BASE64");
  });

  it("exige o banco SaaS em produção mesmo com o conector desligado", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "production",
        IDENTITY_DATABASE_URL: "postgres://identity.invalid/db",
        IDENTITY_DATABASE_TLS_CA_FILE: "/run/secrets/identity-ca.pem",
        LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
        SESSION_STORE: "postgres",
      }),
    ).toThrow("DATABASE_URL");
  });

  it("não aceita configurar rate limit sem banco de identidade", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "homologation",
        LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
        SESSION_STORE: "memory",
      }),
    ).toThrow("IDENTITY_DATABASE_URL");
  });

  it("exige segredo administrativo com banco SaaS fora de desenvolvimento", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "homologation",
        DATABASE_URL: "postgres://app@127.0.0.1:5432/db",
        IDENTITY_DATABASE_URL: "postgres://identity@127.0.0.1:5432/identity",
        LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
        SESSION_STORE: "postgres",
      }),
    ).toThrow("TENANT_ADMIN_HMAC_KEY_BASE64");

    expect(() =>
      loadConfig({
        TENANT_ADMIN_HMAC_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      }),
    ).toThrow("DATABASE_URL");
  });

  it("exige rate limit também em homologação OIDC", () => {
    expect(() =>
      loadConfig({
        ...oidc,
        APP_ENVIRONMENT: "homologation",
        IDENTITY_DATABASE_URL:
          "postgres://renave_identity_app@127.0.0.1:54317/renave",
        SESSION_STORE: "postgres",
      }),
    ).toThrow("OIDC fora de desenvolvimento exige");
  });

  it("exige CA para bancos remotos fora de desenvolvimento", () => {
    expect(() =>
      loadConfig({
        APP_ENVIRONMENT: "homologation",
        DATABASE_URL: "postgres://app.invalid/db",
      }),
    ).toThrow("DATABASE_URL remota exige arquivo de CA TLS");
    expect(() =>
      loadConfig({
        APP_ENVIRONMENT: "homologation",
        IDENTITY_DATABASE_URL: "postgres://identity.invalid/db",
      }),
    ).toThrow("IDENTITY_DATABASE_URL remota exige arquivo de CA TLS");
  });

  it("permite loopback sem CA e recusa TLS controlado pela URL", () => {
    expect(
      loadConfig({ DATABASE_URL: "postgres://app@127.0.0.1:5432/db" })
        .databaseUrl,
    ).toBe("postgres://app@127.0.0.1:5432/db");
    expect(() =>
      loadConfig({
        DATABASE_URL:
          "postgres://secret-user:secret-password@db.invalid/app?sslmode=disable",
      }),
    ).toThrow("DATABASE_URL não deve controlar TLS por query string");
    try {
      loadConfig({
        DATABASE_URL:
          "postgres://secret-user:secret-password@db.invalid/app?sslmode=disable",
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-password");
    }
  });

  it("exige topologia de proxy explícita e valida CIDRs confiáveis", () => {
    expect(() =>
      loadConfig({
        AUTH_MODE: "oidc",
        APP_ENVIRONMENT: "homologation",
        OIDC_CLIENT_ID: "client",
        OIDC_ISSUER: "https://idp.test",
        OIDC_REDIRECT_URI: "https://app.test/api/auth/callback",
      }),
    ).toThrow("PROXY_MODE");
    expect(() =>
      loadConfig({
        PROXY_MODE: "trusted-proxy",
        TRUSTED_PROXY_CIDRS: "not-a-cidr",
      }),
    ).toThrow("TRUSTED_PROXY_CIDRS");
    expect(
      loadConfig({
        PROXY_MODE: "trusted-proxy",
        TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32",
      }).proxyTrust,
    ).toEqual({
      cidrs: ["10.0.0.0/8", "2001:db8::/32"],
      mode: "trusted-proxy",
    });
  });
});
