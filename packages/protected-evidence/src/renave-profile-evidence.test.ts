import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  encodeRenaveProfileEvidenceClaims,
  readVerifiedProfileEvidence,
  RENAVE_PROFILE_EVIDENCE_AUDIENCE,
  RenaveProfileEvidenceConfigurationError,
  RenaveProfileEvidenceInvalidError,
  RenaveProfileEvidenceVerifier,
  VerifiedProfileEvidence,
  type RenaveProfileEvidenceBinding,
  type RenaveProfileEvidenceClaims,
} from "./renave-profile-evidence.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const PROFILE_A = "33333333-3333-4333-8333-333333333333";
const PROFILE_B = "44444444-4444-4444-8444-444444444444";
const ESTABLISHMENT_A = "55555555-5555-4555-8555-555555555555";
const ESTABLISHMENT_B = "66666666-6666-4666-8666-666666666666";
const OPERATOR_A = "oidc|operator-case-sensitive";
const VALUE_HMAC = Buffer.alloc(32, 0x31);
const OTHER_HMAC = Buffer.alloc(32, 0x72);
const NONCE = Buffer.alloc(24, 0x44).toString("base64url");

interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function signingKey(): SigningKey {
  return generateKeyPairSync("ed25519");
}

function operatorClaims(
  overrides: Partial<RenaveProfileEvidenceClaims> = {},
): RenaveProfileEvidenceClaims {
  return {
    algorithm: "Ed25519",
    audience: RENAVE_PROFILE_EVIDENCE_AUDIENCE,
    environment: "homologation",
    expectedProfileVersion: 7,
    expiresAt: "2026-11-24T12:05:00.000Z",
    issuedAt: "2026-11-24T11:59:00.000Z",
    issuerKeyId: "issuer-2026-11",
    methodVersion: "oidc-email-v1",
    nonce: NONCE,
    profileId: PROFILE_A,
    provider: "oidc_verified_claim",
    schemaVersion: 1,
    targetId: OPERATOR_A,
    targetType: "operator",
    tenantId: TENANT_A,
    valueHmac: VALUE_HMAC.toString("base64url"),
    valueHmacKeyId: "profile-hmac-v2",
    ...overrides,
  };
}

function establishmentClaims(
  overrides: Partial<RenaveProfileEvidenceClaims> = {},
): RenaveProfileEvidenceClaims {
  return operatorClaims({
    methodVersion: "serpro-establishment-v1",
    provider: "serpro_registry",
    targetId: ESTABLISHMENT_A,
    targetType: "establishment",
    ...overrides,
  });
}

function bindingFor(
  claims: RenaveProfileEvidenceClaims,
): RenaveProfileEvidenceBinding {
  return {
    environment: claims.environment,
    expectedProfileVersion: claims.expectedProfileVersion,
    methodVersion: claims.methodVersion,
    profileId: claims.profileId,
    provider: claims.provider,
    targetId: claims.targetId,
    targetType: claims.targetType,
    tenantId: claims.tenantId,
    valueHmac: Buffer.from(claims.valueHmac, "base64url"),
    valueHmacKeyId: claims.valueHmacKeyId,
  };
}

function tokenFor(
  claims: RenaveProfileEvidenceClaims,
  privateKey: KeyObject,
): string {
  const payload = encodeRenaveProfileEvidenceClaims(claims);
  try {
    return JSON.stringify({
      claims,
      signature: sign(null, payload, privateKey).toString("base64url"),
    });
  } finally {
    payload.fill(0);
  }
}

function verifier(
  publicKey: KeyObject,
  overrides: Partial<
    ConstructorParameters<typeof RenaveProfileEvidenceVerifier>[0]
  > = {},
): RenaveProfileEvidenceVerifier {
  return new RenaveProfileEvidenceVerifier({
    clock: () => new Date(NOW),
    environment: "homologation",
    keyring: { keys: new Map([["issuer-2026-11", publicKey]]) },
    maxFutureSkewMs: 60_000,
    maxTtlMs: 10 * 60_000,
    ...overrides,
  });
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError(RenaveProfileEvidenceInvalidError);
}

describe("RenaveProfileEvidenceVerifier", () => {
  it("verifica evidência de operador e devolve apenas uma capacidade nominal defensiva", () => {
    const key = signingKey();
    const claims = operatorClaims();
    const evidence = verifier(key.publicKey).verify(
      tokenFor(claims, key.privateKey),
      bindingFor(claims),
    );
    const snapshot = readVerifiedProfileEvidence(evidence);

    expect(evidence).toBeInstanceOf(VerifiedProfileEvidence);
    expect(snapshot).toMatchObject({
      environment: "homologation",
      expectedProfileVersion: 7,
      issuerKeyId: "issuer-2026-11",
      methodVersion: "oidc-email-v1",
      profileId: PROFILE_A,
      provider: "oidc_verified_claim",
      targetId: OPERATOR_A,
      targetType: "operator",
      tenantId: TENANT_A,
      valueHmacKeyId: "profile-hmac-v2",
    });
    expect(snapshot.evidenceDigest).toHaveLength(32);
    expect(snapshot.nonce).toEqual(Buffer.from(NONCE, "base64url"));
    expect(snapshot.valueHmac).toEqual(VALUE_HMAC);

    snapshot.evidenceDigest.fill(0);
    snapshot.nonce.fill(0);
    snapshot.valueHmac.fill(0);
    const publicDigestCopy = evidence.evidenceDigest;
    publicDigestCopy.fill(0);
    expect(readVerifiedProfileEvidence(evidence).evidenceDigest).not.toEqual(
      snapshot.evidenceDigest,
    );
    expect(evidence.evidenceDigest).not.toEqual(publicDigestCopy);
  });

  it.each([
    ["mailbox_challenge", "mailbox-domain-v1"],
    ["serpro_registry", "serpro-establishment-v1"],
  ] as const)(
    "aceita provider de estabelecimento %s",
    (provider, methodVersion) => {
      const key = signingKey();
      const claims = establishmentClaims({ provider, methodVersion });
      const result = verifier(key.publicKey).verify(
        tokenFor(claims, key.privateKey),
        bindingFor(claims),
      );

      expect(result.provider).toBe(provider);
      expect(result.targetType).toBe("establishment");
    },
  );

  it("é independente da ordem do JSON e usa canonicalização binária determinística", () => {
    const key = signingKey();
    const claims = operatorClaims();
    const reordered = Object.fromEntries(Object.entries(claims).reverse());
    const canonical = encodeRenaveProfileEvidenceClaims(claims);
    const reorderedCanonical = encodeRenaveProfileEvidenceClaims(reordered);
    const signature = sign(null, canonical, key.privateKey).toString(
      "base64url",
    );
    const first = JSON.stringify({ claims, signature });
    const second = JSON.stringify({ signature, claims: reordered });
    try {
      expect(reorderedCanonical).toEqual(canonical);
      expect(canonical.readUInt32BE(0)).toBe(Buffer.byteLength("domain"));
      expect(createHash("sha256").update(canonical).digest("hex")).toBe(
        "9845a27b7b937f1e3923d5c692adff2c3083302df3d956a3eb6d6b72cb7d4f23",
      );
      const service = verifier(key.publicKey);
      expect(service.verify(first, bindingFor(claims)).evidenceDigest).toEqual(
        service.verify(second, bindingFor(claims)).evidenceDigest,
      );
    } finally {
      canonical.fill(0);
      reorderedCanonical.fill(0);
    }
  });

  it("vincula o nonce ao digest do envelope assinado", () => {
    const key = signingKey();
    const firstClaims = operatorClaims();
    const secondClaims = operatorClaims({
      nonce: Buffer.alloc(24, 0x45).toString("base64url"),
    });
    const service = verifier(key.publicKey);
    const first = service.verify(
      tokenFor(firstClaims, key.privateKey),
      bindingFor(firstClaims),
    );
    const second = service.verify(
      tokenFor(secondClaims, key.privateKey),
      bindingFor(secondClaims),
    );

    expect(first.evidenceDigest).not.toEqual(second.evidenceDigest);
    expect(readVerifiedProfileEvidence(first).nonce).not.toEqual(
      readVerifiedProfileEvidence(second).nonce,
    );
  });

  it.each([
    ["environment", "production"],
    ["tenantId", TENANT_B],
    ["targetId", "oidc|another-operator"],
    ["profileId", PROFILE_B],
    ["expectedProfileVersion", 8],
    ["valueHmacKeyId", "profile-hmac-v3"],
    ["methodVersion", "oidc-email-v2"],
  ] as const)("rejeita divergência de binding em %s", (field, changed) => {
    const key = signingKey();
    const claims = operatorClaims();
    const binding = { ...bindingFor(claims), [field]: changed };
    expectInvalid(() =>
      verifier(key.publicKey).verify(
        tokenFor(claims, key.privateKey),
        binding as RenaveProfileEvidenceBinding,
      ),
    );
  });

  it("rejeita provider, alvo, HMAC e key id cruzados", () => {
    const key = signingKey();
    const claims = establishmentClaims();
    const service = verifier(key.publicKey);
    const validToken = tokenFor(claims, key.privateKey);

    const cases: RenaveProfileEvidenceBinding[] = [
      { ...bindingFor(claims), targetId: ESTABLISHMENT_B },
      { ...bindingFor(claims), provider: "mailbox_challenge" },
      { ...bindingFor(claims), valueHmac: OTHER_HMAC },
      { ...bindingFor(claims), valueHmacKeyId: "other-hmac-key" },
      {
        ...bindingFor(claims),
        provider: "oidc_verified_claim",
        targetId: OPERATOR_A,
        targetType: "operator",
      },
    ];
    for (const candidate of cases) {
      expectInvalid(() => service.verify(validToken, candidate));
    }
  });

  it.each([
    "algorithm",
    "audience",
    "environment",
    "provider",
    "issuerKeyId",
    "tenantId",
    "targetType",
    "targetId",
    "profileId",
    "expectedProfileVersion",
    "valueHmacKeyId",
    "valueHmac",
    "issuedAt",
    "expiresAt",
    "nonce",
    "methodVersion",
  ] as const)("detecta adulteração assinada do campo %s", (field) => {
    const key = signingKey();
    const claims = operatorClaims();
    const parsed = JSON.parse(tokenFor(claims, key.privateKey)) as {
      claims: Record<string, unknown>;
      signature: string;
    };
    parsed.claims[field] = field === "expectedProfileVersion" ? 9 : "tampered";
    expectInvalid(() =>
      verifier(key.publicKey).verify(
        JSON.stringify(parsed),
        bindingFor(claims),
      ),
    );
  });

  it("rejeita algoritmo, schema, extras, assinatura, kid e envelope não exatos", () => {
    const key = signingKey();
    const claims = operatorClaims();
    const valid = JSON.parse(tokenFor(claims, key.privateKey)) as Record<
      string,
      unknown
    >;
    const service = verifier(key.publicKey);
    const variants: unknown[] = [
      { ...valid, extra: true },
      { claims: { ...claims, extra: true }, signature: valid.signature },
      { claims: { ...claims, algorithm: "ES256" }, signature: valid.signature },
      { claims: { ...claims, schemaVersion: 2 }, signature: valid.signature },
      {
        claims: { ...claims, issuerKeyId: "unknown-kid" },
        signature: valid.signature,
      },
      { claims, signature: Buffer.alloc(64, 0x19).toString("base64url") },
      { claims },
      [],
    ];
    for (const variant of variants) {
      expectInvalid(() =>
        service.verify(JSON.stringify(variant), bindingFor(claims)),
      );
    }
  });

  it("aceita rotação por kid e recusa chave retirada", () => {
    const oldKey = signingKey();
    const nextKey = signingKey();
    const oldClaims = operatorClaims({ issuerKeyId: "issuer-old" });
    const nextClaims = operatorClaims({ issuerKeyId: "issuer-next" });
    const rotating = verifier(nextKey.publicKey, {
      keyring: {
        keys: new Map([
          ["issuer-old", oldKey.publicKey],
          ["issuer-next", nextKey.publicKey],
        ]),
      },
    });

    expect(
      rotating.verify(
        tokenFor(oldClaims, oldKey.privateKey),
        bindingFor(oldClaims),
      ),
    ).toBeInstanceOf(VerifiedProfileEvidence);
    expect(
      rotating.verify(
        tokenFor(nextClaims, nextKey.privateKey),
        bindingFor(nextClaims),
      ),
    ).toBeInstanceOf(VerifiedProfileEvidence);
    expectInvalid(() =>
      verifier(nextKey.publicKey, {
        keyring: { keys: new Map([["issuer-next", nextKey.publicKey]]) },
      }).verify(tokenFor(oldClaims, oldKey.privateKey), bindingFor(oldClaims)),
    );
  });

  it("valida expiração, futuro, TTL e bordas de relógio", () => {
    const key = signingKey();
    const service = verifier(key.publicKey);
    const accepted = [
      operatorClaims({
        issuedAt: "2026-11-24T12:01:00.000Z",
        expiresAt: "2026-11-24T12:10:00.000Z",
      }),
      operatorClaims({
        issuedAt: "2026-11-24T11:50:00.001Z",
        expiresAt: "2026-11-24T12:00:00.001Z",
      }),
      operatorClaims({
        issuedAt: "2026-11-24T08:59:00-03:00",
        expiresAt: "2026-11-24T09:05:00-03:00",
      }),
    ];
    for (const claims of accepted) {
      expect(
        service.verify(tokenFor(claims, key.privateKey), bindingFor(claims)),
      ).toBeInstanceOf(VerifiedProfileEvidence);
    }

    const rejected = [
      operatorClaims({ expiresAt: "2026-11-24T12:00:00.000Z" }),
      operatorClaims({ issuedAt: "2026-11-24T12:01:00.001Z" }),
      operatorClaims({
        issuedAt: "2026-11-24T11:49:59.999Z",
        expiresAt: "2026-11-24T12:00:00.001Z",
      }),
      operatorClaims({
        issuedAt: "2026-11-24T12:05:00.000Z",
        expiresAt: "2026-11-24T12:04:00.000Z",
      }),
    ];
    for (const claims of rejected) {
      expectInvalid(() =>
        service.verify(tokenFor(claims, key.privateKey), bindingFor(claims)),
      );
    }
  });

  it.each([
    ["2026-11-24T12:00:00", "2026-11-24T12:05:00.000Z"],
    ["2026-02-30T12:00:00.000Z", "2026-11-24T12:05:00.000Z"],
    ["2026-11-24T12:00:60.000Z", "2026-11-24T12:05:00.000Z"],
    ["2026-11-24T12:00:00.000+24:00", "2026-11-24T12:05:00.000Z"],
    ["2026-11-24T12:00:00.000Z", "2026-11-24T12:05:00"],
  ])("rejeita timestamp não absoluto ou inválido %s", (issuedAt, expiresAt) => {
    expectInvalid(() =>
      encodeRenaveProfileEvidenceClaims(
        operatorClaims({ issuedAt, expiresAt }),
      ),
    );
  });

  it("rejeita nonce curto, digest incorreto, IDs inválidos e provider incompatível", () => {
    const invalidClaims: unknown[] = [
      operatorClaims({ nonce: randomBytes(15).toString("base64url") }),
      operatorClaims({ nonce: `${NONCE}=` }),
      operatorClaims({ valueHmac: randomBytes(31).toString("base64url") }),
      operatorClaims({ tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
      operatorClaims({ tenantId: "00000000-0000-0000-0000-000000000000" }),
      operatorClaims({ targetId: " " }),
      operatorClaims({ targetId: "oidc|\ud800" }),
      operatorClaims({ provider: "serpro_registry" }),
      establishmentClaims({ targetId: OPERATOR_A }),
      operatorClaims({ expectedProfileVersion: 0 }),
    ];
    for (const claims of invalidClaims) {
      expectInvalid(() => encodeRenaveProfileEvidenceClaims(claims));
    }
  });

  it("mantém toJSON sanitizado, destrói bytes internos e falha fechado em forjery/proxy", () => {
    const key = signingKey();
    const claims = operatorClaims();
    const evidence = verifier(key.publicKey).verify(
      tokenFor(claims, key.privateKey),
      bindingFor(claims),
    );
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(TENANT_A);
    expect(serialized).not.toContain(PROFILE_A);
    expect(serialized).not.toContain(OPERATOR_A);
    expect(serialized).not.toContain(claims.valueHmac);
    expect(serialized).not.toContain(claims.nonce);

    const reflectedIssue = VerifiedProfileEvidence.create as unknown as (
      token: symbol,
      state: unknown,
    ) => VerifiedProfileEvidence;
    expectInvalid(() => reflectedIssue(Symbol("forged"), {}));
    const forged = Object.create(
      VerifiedProfileEvidence.prototype,
    ) as VerifiedProfileEvidence;
    expectInvalid(() => readVerifiedProfileEvidence(forged));
    expectInvalid(() => forged.destroy());
    const proxied = new Proxy(evidence, {});
    expectInvalid(() => readVerifiedProfileEvidence(proxied));
    expectInvalid(() => proxied.destroy());
    class ForgedSubclass extends (VerifiedProfileEvidence as unknown as new (
      ...args: unknown[]
    ) => VerifiedProfileEvidence) {}
    expectInvalid(() =>
      Reflect.construct(
        VerifiedProfileEvidence,
        [Symbol(), {}],
        ForgedSubclass,
      ),
    );

    evidence.destroy();
    evidence.destroy();
    expectInvalid(() => readVerifiedProfileEvidence(evidence));
    expectInvalid(() => evidence.toJSON());
  });

  it("mantém erros fechados e não ecoa token, HMAC, tenant ou alvo", () => {
    const key = signingKey();
    const claims = operatorClaims();
    const token = tokenFor(claims, key.privateKey);
    const tampered = token.replace(claims.targetId, "oidc|secret-target");
    let caught: unknown;
    try {
      verifier(key.publicKey).verify(tampered, bindingFor(claims));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RenaveProfileEvidenceInvalidError);
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(claims.valueHmac);
    expect(rendered).not.toContain(TENANT_A);
    expect(rendered).not.toContain(OPERATOR_A);
    expect(rendered).not.toContain("secret-target");
  });

  it("recusa token maior que 16 KiB antes do parse", () => {
    const key = signingKey();
    expectInvalid(() =>
      verifier(key.publicKey).verify("{".padEnd(16 * 1_024 + 1, "x"), {
        ...bindingFor(operatorClaims()),
      }),
    );
  });

  it("valida configuração, tipo de chave e destruição do verificador", () => {
    const ed = signingKey();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = ed.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const invalidConfigs = [
      { keyring: { keys: new Map() }, maxTtlMs: 1 },
      { keyring: { keys: new Map([["issuer", rsa.publicKey]]) }, maxTtlMs: 1 },
      { keyring: { keys: new Map([["issuer", ed.privateKey]]) }, maxTtlMs: 1 },
      { keyring: { keys: new Map([["issuer", privatePem]]) }, maxTtlMs: 1 },
      { keyring: { keys: new Map([["issuer", ed.publicKey]]) }, maxTtlMs: 0 },
      {
        keyring: { keys: new Map([["issuer", ed.publicKey]]) },
        maxFutureSkewMs: 300_001,
        maxTtlMs: 1,
      },
      {
        keyring: { keys: new Map([["issuer", ed.publicKey]]) },
        maxTtlMs: 86_400_001,
      },
    ];
    for (const config of invalidConfigs) {
      expect(
        () =>
          new RenaveProfileEvidenceVerifier({
            environment: "homologation",
            ...config,
          }),
      ).toThrowError(RenaveProfileEvidenceConfigurationError);
    }

    const der = ed.publicKey.export({ format: "der", type: "spki" });
    const service = verifier(ed.publicKey, {
      keyring: { keys: new Map([["issuer-2026-11", der]]) },
    });
    const claims = operatorClaims();
    expect(
      service.verify(tokenFor(claims, ed.privateKey), bindingFor(claims)),
    ).toBeInstanceOf(VerifiedProfileEvidence);
    service.destroy();
    service.destroy();
    expect(() =>
      service.verify(tokenFor(claims, ed.privateKey), bindingFor(claims)),
    ).toThrowError(RenaveProfileEvidenceConfigurationError);
    const forged = Object.create(
      RenaveProfileEvidenceVerifier.prototype,
    ) as RenaveProfileEvidenceVerifier;
    expect(() => forged.destroy()).toThrowError(
      RenaveProfileEvidenceConfigurationError,
    );
  });
});
