import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DecryptedRenavePrincipal,
  RenavePrincipalConfigurationError,
  RenavePrincipalCrypto,
  RenavePrincipalDecryptionError,
  RenavePrincipalInputError,
  type OperatorCpfBinding,
  type ProtectedRenavePrincipal,
  type RenavePrincipalCryptoConfig,
} from "./renave-principal-crypto.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operatorBinding: OperatorCpfBinding = {
  profileId: "22222222-2222-4222-8222-222222222222",
  purpose: "operator-cpf",
  subject: "oidc|Operator-Case-Sensitive",
  tenantId: tenantA,
};
const establishmentBinding = {
  establishmentId: "33333333-3333-4333-8333-333333333333",
  profileId: "44444444-4444-4444-8444-444444444444",
  purpose: "establishment-email" as const,
  tenantId: tenantA,
};

interface KeyMaterial {
  emailEncryption: Buffer;
  emailHmac: Buffer;
  operatorEncryption: Buffer;
  operatorHmac: Buffer;
}

function material(seed = 10): KeyMaterial {
  return {
    emailEncryption: Buffer.alloc(32, seed + 2),
    emailHmac: Buffer.alloc(32, seed + 3),
    operatorEncryption: Buffer.alloc(32, seed),
    operatorHmac: Buffer.alloc(32, seed + 1),
  };
}

function config(
  source = material(),
  environment: "homologation" | "production" = "homologation",
): RenavePrincipalCryptoConfig {
  return {
    environment,
    purposes: {
      "establishment-email": {
        encryption: {
          activeKeyId: "email-enc-v1",
          keys: new Map([["email-enc-v1", source.emailEncryption]]),
        },
        hmac: {
          activeKeyId: "email-hmac-v1",
          keys: new Map([["email-hmac-v1", source.emailHmac]]),
        },
      },
      "operator-cpf": {
        encryption: {
          activeKeyId: "cpf-enc-v1",
          keys: new Map([["cpf-enc-v1", source.operatorEncryption]]),
        },
        hmac: {
          activeKeyId: "cpf-hmac-v1",
          keys: new Map([["cpf-hmac-v1", source.operatorHmac]]),
        },
      },
    },
  };
}

function crypto(
  source = material(),
  environment: "homologation" | "production" = "homologation",
): RenavePrincipalCrypto {
  return new RenavePrincipalCrypto(config(source, environment));
}

function clone(source: ProtectedRenavePrincipal): ProtectedRenavePrincipal {
  return {
    ...source,
    aadSha256: Buffer.from(source.aadSha256),
    authTag: Buffer.from(source.authTag),
    ciphertext: Buffer.from(source.ciphertext),
    hmac: {
      digest: Buffer.from(source.hmac.digest),
      hmacKeyId: source.hmac.hmacKeyId,
    },
    nonce: Buffer.from(source.nonce),
  };
}

function text(secret: DecryptedRenavePrincipal): string {
  const bytes = secret.copyUtf8Bytes();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function rotatingCrypto(
  old: KeyMaterial,
  next: KeyMaterial,
  includeOld = true,
): RenavePrincipalCrypto {
  const ring = (
    activeKeyId: string,
    newKey: Buffer,
    oldKeyId: string,
    oldKey: Buffer,
  ) =>
    new Map<string, Uint8Array>([
      [activeKeyId, newKey],
      ...(includeOld ? ([[oldKeyId, oldKey]] as const) : []),
    ]);
  return new RenavePrincipalCrypto({
    environment: "homologation",
    purposes: {
      "establishment-email": {
        encryption: {
          activeKeyId: "email-enc-v2",
          keys: ring(
            "email-enc-v2",
            next.emailEncryption,
            "email-enc-v1",
            old.emailEncryption,
          ),
        },
        hmac: {
          activeKeyId: "email-hmac-v2",
          keys: ring(
            "email-hmac-v2",
            next.emailHmac,
            "email-hmac-v1",
            old.emailHmac,
          ),
        },
      },
      "operator-cpf": {
        encryption: {
          activeKeyId: "cpf-enc-v2",
          keys: ring(
            "cpf-enc-v2",
            next.operatorEncryption,
            "cpf-enc-v1",
            old.operatorEncryption,
          ),
        },
        hmac: {
          activeKeyId: "cpf-hmac-v2",
          keys: ring(
            "cpf-hmac-v2",
            next.operatorHmac,
            "cpf-hmac-v1",
            old.operatorHmac,
          ),
        },
      },
    },
  });
}

describe("RenavePrincipalCrypto", () => {
  it("normaliza CPF, usa bucket fixo e devolve segredo destruível", () => {
    const protector = crypto();
    const protectedValue = protector.protect("529.982.247-25", operatorBinding);
    const restored = protector.decrypt(protectedValue, operatorBinding);

    expect(protectedValue).toMatchObject({
      envelopeSchemaVersion: 1,
      keyId: "cpf-enc-v1",
      hmac: { hmacKeyId: "cpf-hmac-v1" },
    });
    expect(protectedValue.ciphertext).toHaveLength(128);
    expect(protectedValue.aadSha256).toHaveLength(32);
    expect(protectedValue.hmac.digest).toHaveLength(32);
    expect(restored.purpose).toBe("operator-cpf");
    expect(text(restored)).toBe("52998224725");

    const firstCopy = restored.copyUtf8Bytes();
    firstCopy.fill(0);
    expect(text(restored)).toBe("52998224725");
    const fill = vi.spyOn(Buffer.prototype, "fill");
    restored.destroy();
    restored.destroy();
    const zeroedSecrets = fill.mock.instances.filter(
      (instance) =>
        Buffer.isBuffer(instance) &&
        instance.byteLength === 11 &&
        instance.every((byte) => byte === 0),
    );
    expect(zeroedSecrets).toHaveLength(1);
    fill.mockRestore();
    expect(() => restored.copyUtf8Bytes()).toThrow(
      RenavePrincipalDecryptionError,
    );
  });

  it("preserva a parte local, canonicaliza o domínio e usa bucket 512", () => {
    const protector = crypto();
    const protectedValue = protector.protect(
      "User.Name+tag@Example.COM",
      establishmentBinding,
    );
    const restored = protector.decrypt(protectedValue, establishmentBinding);

    expect(protectedValue.ciphertext).toHaveLength(512);
    expect(text(restored)).toBe("User.Name+tag@example.com");
  });

  it("gera nonce, ciphertext e padding novos para o mesmo valor", () => {
    const protector = crypto();
    const first = protector.protect("52998224725", operatorBinding);
    const second = protector.protect("52998224725", operatorBinding);

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.hmac.digest.equals(second.hmac.digest)).toBe(true);
    expect(first.aadSha256.equals(second.aadSha256)).toBe(true);
  });

  it("vincula ambiente, tenant, entidade, perfil, propósito, HMAC e bucket", () => {
    const protector = crypto();
    const protectedValue = protector.protect("52998224725", operatorBinding);
    const changedBindings = [
      { ...operatorBinding, tenantId: tenantB },
      { ...operatorBinding, subject: "oidc|other" },
      {
        ...operatorBinding,
        profileId: "55555555-5555-4555-8555-555555555555",
      },
    ];
    for (const changed of changedBindings) {
      expect(() => protector.decrypt(protectedValue, changed)).toThrow(
        RenavePrincipalDecryptionError,
      );
    }
    expect(() =>
      crypto(material(), "production").decrypt(protectedValue, operatorBinding),
    ).toThrow(RenavePrincipalDecryptionError);
    expect(() =>
      protector.decrypt(protectedValue, {
        ...establishmentBinding,
        profileId: operatorBinding.profileId,
      }),
    ).toThrow(RenavePrincipalDecryptionError);

    const hmacChanged = clone(protectedValue);
    hmacChanged.hmac.digest[0] = hmacChanged.hmac.digest[0]! ^ 1;
    expect(() => protector.decrypt(hmacChanged, operatorBinding)).toThrow(
      RenavePrincipalDecryptionError,
    );

    const bucketChanged = clone(protectedValue);
    bucketChanged.ciphertext = Buffer.concat([
      bucketChanged.ciphertext,
      Buffer.alloc(128),
    ]);
    expect(() => protector.decrypt(bucketChanged, operatorBinding)).toThrow(
      RenavePrincipalDecryptionError,
    );
  });

  it.each(["nonce", "authTag", "ciphertext", "aadSha256"] as const)(
    "recusa %s adulterado com erro uniforme",
    (field) => {
      const protector = crypto();
      const tampered = clone(protector.protect("52998224725", operatorBinding));
      tampered[field][0] = tampered[field][0]! ^ 1;

      expect(() => protector.decrypt(tampered, operatorBinding)).toThrow(
        RenavePrincipalDecryptionError,
      );
    },
  );

  it("recusa metadados, chave desconhecida e combinações de envelopes", () => {
    const protector = crypto();
    const first = protector.protect("52998224725", operatorBinding);
    const second = protector.protect("11144477735", {
      ...operatorBinding,
      profileId: "55555555-5555-4555-8555-555555555555",
      subject: "oidc|second",
    });
    const candidates: ProtectedRenavePrincipal[] = [
      { ...clone(first), keyId: "unknown" },
      { ...clone(first), envelopeSchemaVersion: 2 as 1 },
      { ...clone(first), nonce: Buffer.alloc(11) },
      { ...clone(first), authTag: Buffer.alloc(15) },
      { ...clone(first), aadSha256: Buffer.alloc(31) },
      { ...clone(first), ciphertext: Buffer.alloc(127) },
      { ...clone(first), nonce: Buffer.from(second.nonce) },
      { ...clone(first), authTag: Buffer.from(second.authTag) },
      { ...clone(first), ciphertext: Buffer.from(second.ciphertext) },
    ];

    for (const candidate of candidates) {
      expect(() => protector.decrypt(candidate, operatorBinding)).toThrow(
        RenavePrincipalDecryptionError,
      );
    }
  });

  it("recusa payload autenticado com comprimento interno malformado", () => {
    const keys = material();
    const protector = crypto(keys);
    const baseline = protector.protect("52998224725", operatorBinding);
    const plaintext = randomBytes(128);
    plaintext.writeUInt32BE(200, 0);
    const nonce = randomBytes(12);
    const aad = Buffer.from(
      JSON.stringify([
        "seu-renave-principal-profile-v1",
        1,
        "homologation",
        "operator-cpf",
        baseline.keyId,
        baseline.hmac.hmacKeyId,
        baseline.hmac.digest.toString("hex"),
        operatorBinding.tenantId,
        "subject",
        operatorBinding.subject,
        operatorBinding.profileId,
        128,
      ]),
      "utf8",
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      keys.operatorEncryption,
      nonce,
      { authTagLength: 16 },
    );
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const malformed: ProtectedRenavePrincipal = {
      ...clone(baseline),
      aadSha256: createHash("sha256").update(aad).digest(),
      authTag: cipher.getAuthTag(),
      ciphertext,
      nonce,
    };

    expect(() => protector.decrypt(malformed, operatorBinding)).toThrow(
      RenavePrincipalDecryptionError,
    );
    plaintext.fill(0);
    aad.fill(0);
  });

  it("mantém leitura de cifra e HMAC antigos durante rotação", () => {
    const oldMaterial = material(20);
    const nextMaterial = material(40);
    const old = crypto(oldMaterial);
    const oldValue = old.protect("52998224725", operatorBinding);
    const rotating = rotatingCrypto(oldMaterial, nextMaterial);
    const nextValue = rotating.protect("52998224725", operatorBinding);

    expect(text(rotating.decrypt(oldValue, operatorBinding))).toBe(
      "52998224725",
    );
    expect(text(rotating.decrypt(nextValue, operatorBinding))).toBe(
      "52998224725",
    );
    expect(nextValue.keyId).toBe("cpf-enc-v2");
    expect(nextValue.hmac.hmacKeyId).toBe("cpf-hmac-v2");
    expect(
      rotating.verifyDigest("529.982.247-25", operatorBinding, oldValue.hmac),
    ).toBe(true);
    expect(() =>
      rotatingCrypto(oldMaterial, nextMaterial, false).decrypt(
        oldValue,
        operatorBinding,
      ),
    ).toThrow(RenavePrincipalDecryptionError);
  });

  it("separa HMAC por propósito, tenant e estabelecimento", () => {
    const protector = crypto();
    const cpfPlain = protector.digest("52998224725", operatorBinding);
    const cpfMasked = protector.digest("529.982.247-25", operatorBinding);
    const cpfOtherTenant = protector.digest("52998224725", {
      ...operatorBinding,
      tenantId: tenantB,
    });
    const email = protector.digest("User@Example.COM", establishmentBinding);
    const emailDomainCase = protector.digest(
      "User@example.com",
      establishmentBinding,
    );
    const emailOtherEstablishment = protector.digest("User@example.com", {
      ...establishmentBinding,
      establishmentId: "55555555-5555-4555-8555-555555555555",
    });

    expect(cpfPlain.digest.equals(cpfMasked.digest)).toBe(true);
    expect(cpfPlain.digest.equals(cpfOtherTenant.digest)).toBe(false);
    expect(email.digest.equals(emailDomainCase.digest)).toBe(true);
    expect(email.digest.equals(emailOtherEstablishment.digest)).toBe(false);
    expect(cpfPlain.digest.equals(email.digest)).toBe(false);
  });

  it("vincula o HMAC ao ambiente e ao identificador da chave", () => {
    const keys = material();
    const homologation = crypto(keys).digest("52998224725", operatorBinding);
    const production = crypto(keys, "production").digest(
      "52998224725",
      operatorBinding,
    );
    const renamed = config(keys);
    renamed.purposes["operator-cpf"].hmac.activeKeyId = "cpf-hmac-renamed";
    renamed.purposes["operator-cpf"].hmac.keys = new Map([
      ["cpf-hmac-renamed", keys.operatorHmac],
    ]);
    const renamedDigest = new RenavePrincipalCrypto(renamed).digest(
      "52998224725",
      operatorBinding,
    );

    expect(homologation.digest.equals(production.digest)).toBe(false);
    expect(homologation.digest.equals(renamedDigest.digest)).toBe(false);
  });

  it("não usa SHA-256 simples e canonicaliza UUIDs sem afetar o HMAC", () => {
    const protector = crypto();
    const value = "52998224725";
    const uppercaseBinding = {
      ...operatorBinding,
      profileId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    };
    const lowercaseBinding = {
      ...operatorBinding,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const canonical = protector.digest(value, uppercaseBinding);
    const lowercase = protector.digest(value, lowercaseBinding);
    const protectedValue = protector.protect(value, uppercaseBinding);

    expect(canonical.digest.equals(lowercase.digest)).toBe(true);
    expect(text(protector.decrypt(protectedValue, lowercaseBinding))).toBe(
      value,
    );
    expect(
      canonical.digest.equals(createHash("sha256").update(value).digest()),
    ).toBe(false);
  });

  it("trata chave HMAC desconhecida como digest divergente", () => {
    const protector = crypto();
    const valid = protector.digest("52998224725", operatorBinding);
    const unknown = { ...valid, hmacKeyId: "cpf-hmac-unknown" };
    const different = {
      digest: Buffer.alloc(32, 0xff),
      hmacKeyId: valid.hmacKeyId,
    };

    expect(
      protector.verifyDigest("52998224725", operatorBinding, unknown),
    ).toBe(false);
    expect(
      protector.verifyDigest("52998224725", operatorBinding, different),
    ).toBe(false);
  });

  it("uniformiza HMAC key ID desconhecido e adulterado na decriptação", () => {
    const protector = crypto();
    const original = protector.protect("52998224725", operatorBinding);
    const unknown = clone(original);
    unknown.hmac.hmacKeyId = "cpf-hmac-unknown";
    const tampered = clone(original);
    tampered.hmac.hmacKeyId = "email-hmac-v1";

    const messages = [unknown, tampered].map((candidate) => {
      try {
        protector.decrypt(candidate, operatorBinding);
        return "não falhou";
      } catch (error) {
        expect(error).toBeInstanceOf(RenavePrincipalDecryptionError);
        return (error as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("O perfil RENAVE não pôde ser autenticado.");
  });

  it.each([
    ["CPF curto", "123", operatorBinding],
    ["CPF repetido", "00000000000", operatorBinding],
    ["CPF com DV inválido", "52998224724", operatorBinding],
    ["e-mail com espaço", "User @example.com", establishmentBinding],
    ["e-mail Unicode", "usuário@example.com", establishmentBinding],
    ["e-mail sem domínio público", "user@localhost", establishmentBinding],
    ["e-mail com ponto duplo", "user..name@example.com", establishmentBinding],
  ] as const)(
    "recusa %s sem incluir o valor no erro",
    (_label, value, binding) => {
      const protector = crypto();
      let error: unknown;
      try {
        protector.protect(value, binding);
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toBeInstanceOf(RenavePrincipalInputError);
      expect(String(error)).not.toContain(value);
    },
  );

  it("recusa configuração incompleta, chave curta, ID e material repetidos", () => {
    const valid = config();
    expect(
      () =>
        new RenavePrincipalCrypto({
          ...valid,
          environment: "invalid" as "homologation",
        }),
    ).toThrow(RenavePrincipalConfigurationError);

    const missingActive = config();
    missingActive.purposes["operator-cpf"].encryption.activeKeyId = "missing";
    expect(() => new RenavePrincipalCrypto(missingActive)).toThrow(
      RenavePrincipalConfigurationError,
    );

    const short = config();
    short.purposes["operator-cpf"].hmac.keys = new Map([
      ["cpf-hmac-v1", randomBytes(31)],
    ]);
    expect(() => new RenavePrincipalCrypto(short)).toThrow(
      RenavePrincipalConfigurationError,
    );

    const duplicateId = config();
    duplicateId.purposes["establishment-email"].hmac.activeKeyId =
      "cpf-hmac-v1";
    duplicateId.purposes["establishment-email"].hmac.keys = new Map([
      ["cpf-hmac-v1", randomBytes(32)],
    ]);
    expect(() => new RenavePrincipalCrypto(duplicateId)).toThrow(
      RenavePrincipalConfigurationError,
    );

    const duplicateRaw = material();
    duplicateRaw.emailHmac = Buffer.from(duplicateRaw.operatorHmac);
    expect(() => crypto(duplicateRaw)).toThrow(
      RenavePrincipalConfigurationError,
    );
  });

  it("copia as chaves, destrói o keyring e bloqueia uso posterior", () => {
    const source = material();
    const protector = crypto(source);
    for (const key of Object.values(source)) key.fill(0);
    const protectedValue = protector.protect("52998224725", operatorBinding);
    expect(text(protector.decrypt(protectedValue, operatorBinding))).toBe(
      "52998224725",
    );

    const fill = vi.spyOn(Buffer.prototype, "fill");
    protector.destroy();
    protector.destroy();
    expect(fill).toHaveBeenCalledWith(0);
    const zeroedKeys = fill.mock.instances.filter(
      (instance) =>
        Buffer.isBuffer(instance) &&
        instance.byteLength === 32 &&
        instance.every((byte) => byte === 0),
    );
    expect(zeroedKeys.length).toBeGreaterThanOrEqual(4);
    fill.mockRestore();
    expect(() => protector.protect("52998224725", operatorBinding)).toThrow(
      RenavePrincipalConfigurationError,
    );
    expect(() => protector.decrypt(protectedValue, operatorBinding)).toThrow(
      RenavePrincipalConfigurationError,
    );
  });

  it("recusa subclass, instância forjada e segredo forjado", () => {
    class ForgedCrypto extends RenavePrincipalCrypto {}
    expect(() => new ForgedCrypto(config())).toThrow(
      RenavePrincipalConfigurationError,
    );
    const forged = Object.create(
      RenavePrincipalCrypto.prototype,
    ) as RenavePrincipalCrypto;
    expect(() => forged.protect("52998224725", operatorBinding)).toThrow(
      RenavePrincipalConfigurationError,
    );
    const forgedSecret = Object.create(
      DecryptedRenavePrincipal.prototype,
    ) as DecryptedRenavePrincipal;
    expect(() => forgedSecret.copyUtf8Bytes()).toThrow(
      RenavePrincipalDecryptionError,
    );
  });

  it("recusa serialização implícita do segredo", () => {
    const protector = crypto();
    const secret = protector.decrypt(
      protector.protect("52998224725", operatorBinding),
      operatorBinding,
    );

    expect(() => JSON.stringify(secret)).toThrow(
      RenavePrincipalDecryptionError,
    );
  });

  it("não inclui CPF, e-mail nem chaves em erros de autenticação", () => {
    const protector = crypto();
    const cpf = "52998224725";
    const email = "Sensitive@example.com";
    const cpfEnvelope = clone(protector.protect(cpf, operatorBinding));
    cpfEnvelope.authTag[0] = cpfEnvelope.authTag[0]! ^ 1;
    const emailEnvelope = clone(protector.protect(email, establishmentBinding));
    emailEnvelope.authTag[0] = emailEnvelope.authTag[0]! ^ 1;

    for (const [envelope, binding] of [
      [cpfEnvelope, operatorBinding],
      [emailEnvelope, establishmentBinding],
    ] as const) {
      let error: unknown;
      try {
        protector.decrypt(envelope, binding);
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toBeInstanceOf(RenavePrincipalDecryptionError);
      expect(JSON.stringify(error)).not.toMatch(
        /52998224725|Sensitive|cpf-enc-v1|email-enc-v1/u,
      );
    }
  });
});
