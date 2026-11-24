import { describe, expect, it } from "vitest";

import {
  decodeEvidenceKeyBase64,
  EvidenceCipher,
} from "@seu-renave/protected-evidence";

import { loadAppConfig, loadConfig } from "./config.js";
import type { ApiSecretFiles } from "./secret-files.js";

const oidc = {
  AUTH_MODE: "oidc",
  OIDC_CLIENT_ID: "client",
  OIDC_ISSUER: "https://idp.test",
  OIDC_REDIRECT_URI: "https://app.test/api/auth/callback",
  PROXY_MODE: "direct",
};

const stockEntryLocal = {
  ...oidc,
  APP_ENVIRONMENT: "homologation",
  DATABASE_URL: "postgres://app@127.0.0.1:54317/renave",
  IDENTITY_DATABASE_URL: "postgres://identity@127.0.0.1:54317/renave_identity",
  LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
  RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "true",
  SESSION_STORE: "postgres",
  TENANT_ADMIN_HMAC_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
};

const platformConsole = {
  ...oidc,
  APP_ENVIRONMENT: "homologation",
  DATABASE_PLATFORM_READER_URL:
    "postgres://renave_platform_reader@127.0.0.1:54317/renave",
  IDENTITY_DATABASE_URL:
    "postgres://renave_identity_app@127.0.0.1:54317/renave",
  LOGIN_RATE_LIMIT_HMAC_KEY_BASE64: Buffer.alloc(32, 6).toString("base64"),
  OIDC_MAX_AUTHENTICATION_AGE_SECONDS: "300",
  OIDC_MFA_ACCEPTED_ACR_VALUES: "urn:example:assurance:mfa",
  PLATFORM_CONSOLE_ENABLED: "true",
  PLATFORM_OPERATOR_HMAC_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  PLATFORM_OPERATOR_MFA_MAX_AGE_SECONDS: "300",
  SESSION_STORE: "postgres",
};

describe("configuração da API", () => {
  it("mantém a entrada de estoque local desligada por padrão", () => {
    expect(loadConfig().stockEntryLocalEnabled).toBe(false);
    expect(
      loadConfig({ RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "false" })
        .stockEntryLocalEnabled,
    ).toBe(false);
    expect(() =>
      loadConfig({ RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "yes" }),
    ).toThrow("RENAVE_STOCK_ENTRY_LOCAL_ENABLED");
  });

  it("habilita HELD_LOCAL somente com homologação, OIDC e bancos persistentes", () => {
    const config = loadConfig(stockEntryLocal);
    expect(config.stockEntryLocalEnabled).toBe(true);
    expect(config.renave).toBeUndefined();

    expect(() =>
      loadConfig({
        ...stockEntryLocal,
        APP_ENVIRONMENT: "production",
        DATABASE_TLS_CA_FILE: "/run/secrets/database-ca.pem",
        IDENTITY_DATABASE_TLS_CA_FILE: "/run/secrets/identity-ca.pem",
      }),
    ).toThrow("restrito à homologação");
    expect(() =>
      loadConfig({
        APP_ENVIRONMENT: "homologation",
        PROXY_MODE: "direct",
        RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "true",
      }),
    ).toThrow("AUTH_MODE=oidc");
    expect(() =>
      loadConfig({
        ...stockEntryLocal,
        SESSION_STORE: "memory",
      }),
    ).toThrow("SESSION_STORE=postgres");
    expect(() =>
      loadConfig({
        ...stockEntryLocal,
        DATABASE_URL: undefined,
        TENANT_ADMIN_HMAC_KEY_BASE64: undefined,
      }),
    ).toThrow("DATABASE_URL");
  });

  it("habilita o console global somente com reader, HMAC e MFA recente real", () => {
    expect(loadConfig(platformConsole).platformConsole).toMatchObject({
      databaseUrl: platformConsole.DATABASE_PLATFORM_READER_URL,
      hmacKeyBase64: platformConsole.PLATFORM_OPERATOR_HMAC_KEY_BASE64,
      mfaMaxAgeSeconds: 300,
    });
    expect(() =>
      loadConfig({
        ...platformConsole,
        OIDC_MAX_AUTHENTICATION_AGE_SECONDS: undefined,
      }),
    ).toThrow("OIDC_MAX_AUTHENTICATION_AGE_SECONDS");
    expect(() =>
      loadConfig({
        ...platformConsole,
        OIDC_MAX_AUTHENTICATION_AGE_SECONDS: "600",
      }),
    ).toThrow("compatível");
    expect(() =>
      loadConfig({
        ...platformConsole,
        DATABASE_PLATFORM_READER_URL: undefined,
      }),
    ).toThrow("DATABASE_PLATFORM_READER_URL");
  });

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
      RENAVE_EVIDENCE_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"),
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
      evidenceKeyring: { activeKeyId: "key-2026-11" },
      integratorCnpj: "11222333000181",
      mtls: {
        certificateFile: "/run/secrets/cert.pem",
        kind: "files",
      },
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

const secureOidc = {
  ...oidc,
  APP_ENVIRONMENT: "homologation",
  OIDC_CLIENT_ID: "confidential-client",
  RENAVE_INTEGRATION_ENABLED: "true",
  RENAVE_INTEGRATOR_CNPJ: "11222333000181",
  SESSION_STORE: "postgres",
};

function secureSecrets(
  evidenceKeyring: unknown = {
    activeKeyId: "evidence-v2",
    keys: [
      {
        keyBase64: Buffer.alloc(32, 2).toString("base64"),
        keyId: "evidence-v2",
      },
      {
        keyBase64: Buffer.alloc(32, 1).toString("base64"),
        keyId: "evidence-v1",
      },
    ],
    version: 1,
  },
): ApiSecretFiles {
  return {
    databaseCa: undefined,
    databaseUrl: "postgres://app@127.0.0.1:54317/renave",
    platformReaderDatabaseCa: undefined,
    platformReaderDatabaseUrl: undefined,
    evidenceKeyringJson: JSON.stringify(evidenceKeyring),
    identityDatabaseCa: undefined,
    identityDatabaseUrl: "postgres://identity@127.0.0.1:54317/renave_identity",
    loginRateLimitHmacKeyBase64: Buffer.alloc(32, 3).toString("base64"),
    mtlsCa: "CA",
    mtlsCertificate: "CERT",
    mtlsKey: "KEY",
    mtlsKeyPassphrase: "passphrase",
    oidcClientSecret: "oidc-secret",
    platformOperatorHmacKeyBase64: undefined,
    serproQueryLimitHmacKeyBase64: Buffer.alloc(32, 4).toString("base64"),
    tenantAdminHmacKeyBase64: Buffer.alloc(32, 5).toString("base64"),
  };
}

function cipher(config: Awaited<ReturnType<typeof loadAppConfig>>) {
  const keyring = config.renave!.evidenceKeyring;
  const keys = new Map(
    keyring.keys.map(({ keyBase64, keyId }) => [
      keyId,
      decodeEvidenceKeyBase64(keyBase64),
    ]),
  );
  try {
    return new EvidenceCipher({ activeKeyId: keyring.activeKeyId, keys });
  } finally {
    for (const key of keys.values()) key.fill(0);
  }
}

describe("configuração operacional da API por arquivos", () => {
  it("rejeita segredo concorrente no ambiente antes de ler o mount", async () => {
    let reads = 0;
    await expect(
      loadAppConfig(
        { ...secureOidc, DATABASE_URL: "postgres://must-not-be-used/db" },
        async () => {
          reads += 1;
          return secureSecrets();
        },
      ),
    ).rejects.toThrow("Configuração secreta da API inválida");
    expect(reads).toBe(0);

    await expect(
      loadAppConfig({ APP_ENVIRONMENT: "homologation", DATABASE_URL: "x" }),
    ).rejects.toThrow("Configuração secreta da API inválida");
  });

  it("carrega DSNs, HMACs, OIDC, mTLS e keyring somente do bundle", async () => {
    const config = await loadAppConfig(secureOidc, async () => secureSecrets());
    expect(config.databaseUrl).toContain("127.0.0.1");
    expect(config.oidc?.clientSecret).toBe("oidc-secret");
    expect(config.renave).toMatchObject({
      evidenceKeyring: { activeKeyId: "evidence-v2" },
      keyPassphrase: "passphrase",
      mtls: { kind: "material" },
    });
    expect(
      config.renave?.evidenceKeyring.keys.map(({ keyId }) => keyId),
    ).toEqual(["evidence-v2", "evidence-v1"]);
  });

  it("preserva leitura histórica após rotação e rollback da chave ativa", async () => {
    const oldConfig = await loadAppConfig(secureOidc, async () =>
      secureSecrets({
        activeKeyId: "evidence-v1",
        keys: [
          {
            keyBase64: Buffer.alloc(32, 1).toString("base64"),
            keyId: "evidence-v1",
          },
        ],
        version: 1,
      }),
    );
    const rotatedConfig = await loadAppConfig(secureOidc, async () =>
      secureSecrets(),
    );
    const rollbackConfig = await loadAppConfig(secureOidc, async () =>
      secureSecrets({
        activeKeyId: "evidence-v1",
        keys: [
          {
            keyBase64: Buffer.alloc(32, 1).toString("base64"),
            keyId: "evidence-v1",
          },
          {
            keyBase64: Buffer.alloc(32, 2).toString("base64"),
            keyId: "evidence-v2",
          },
        ],
        version: 1,
      }),
    );
    const binding = {
      action: "renave.vehicle.read",
      establishmentId: "22222222-2222-4222-8222-222222222222",
      evidenceId: "evidence-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
    };
    const encrypted = cipher(oldConfig).encrypt(
      { plate: "ABC1D23" },
      binding,
      "request",
    );
    expect(
      cipher(rotatedConfig).decrypt(encrypted, binding, "request"),
    ).toEqual({ plate: "ABC1D23" });
    const encryptedAfterRotation = cipher(rotatedConfig).encrypt(
      { plate: "DEF4G56" },
      binding,
      "response",
    );
    expect(
      cipher(rollbackConfig).decrypt(
        encryptedAfterRotation,
        binding,
        "response",
      ),
    ).toEqual({ plate: "DEF4G56" });
  });

  it.each([
    {
      activeKeyId: "missing",
      keys: [
        {
          keyBase64: Buffer.alloc(32, 1).toString("base64"),
          keyId: "one",
        },
      ],
      version: 1,
    },
    {
      activeKeyId: "one",
      keys: [
        {
          keyBase64: Buffer.alloc(32, 1).toString("base64"),
          keyId: "one",
        },
        {
          keyBase64: Buffer.alloc(32, 2).toString("base64"),
          keyId: "one",
        },
      ],
      version: 1,
    },
    {
      activeKeyId: "one",
      keys: [
        {
          keyBase64: Buffer.alloc(32, 1).toString("base64"),
          keyId: "one",
        },
        {
          keyBase64: Buffer.alloc(32, 1).toString("base64"),
          keyId: "two",
        },
      ],
      version: 1,
    },
    { activeKeyId: "one", keys: [], version: 2 },
  ])(
    "recusa keyring sem active, com reuso ou schema divergente",
    async (value) => {
      await expect(
        loadAppConfig(secureOidc, async () => secureSecrets(value)),
      ).rejects.toThrow("Configuração secreta da API inválida");
    },
  );
});
