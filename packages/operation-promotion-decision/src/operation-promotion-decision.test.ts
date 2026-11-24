import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OperationPromotionDecisionConfigurationError,
  OperationPromotionDecisionInvalidError,
  OperationPromotionDecisionVerifier,
  encodeOperationPromotionDecisionClaims,
  parseOperationPromotionKeyring,
  type OperationPromotionDecisionClaims,
} from "./operation-promotion-decision.js";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const DECISION_ID = "30000000-0000-4000-8000-000000000003";
const LOGICAL_DATABASE_ID = "00000000-0000-4000-8000-000000000074";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyringJson = JSON.stringify({
    algorithm: "Ed25519",
    audience: "seu-renave/operation-promotion-decision/v1",
    keys: [
      { keyId: "ops-hml-2026-01", publicKeySpki: spki.toString("base64url") },
    ],
    schemaVersion: 1,
  });
  spki.fill(0);
  const claims: OperationPromotionDecisionClaims = {
    action: "promote-held-local-operation",
    algorithm: "Ed25519",
    audience: "seu-renave/operation-promotion-decision/v1",
    binding: {
      credentialLinkVersion: "7",
      establishmentProfileId: "40000000-0000-4000-8000-000000000004",
      establishmentProfileVersion: "11",
      jurisdictionGeneration: "13",
      jurisdictionUf: "PA",
      operatorProfileId: "50000000-0000-4000-8000-000000000005",
      operatorProfileVersion: "17",
      scopeGeneration: "19",
      serviceNature: "establishment",
    },
    changedByDigest: Buffer.alloc(32, 0x21).toString("base64url"),
    decisionId: DECISION_ID,
    effect: "allow",
    environment: "homologation",
    evidence: {
      digest: Buffer.alloc(32, 0x22).toString("base64url"),
      type: "dual-control-review/v1",
    },
    expiresAt: "2026-11-24T18:05:00.000Z",
    executorWorkloadDigest: Buffer.alloc(32, 0x25).toString("base64url"),
    issuedAt: "2026-11-24T17:59:00.000Z",
    issuerKeyId: "ops-hml-2026-01",
    logicalDatabaseId: LOGICAL_DATABASE_ID,
    nonce: Buffer.alloc(32, 0x23).toString("base64url"),
    notBefore: "2026-11-24T17:59:30.000Z",
    operationId: OPERATION_ID,
    policy: {
      digest: Buffer.alloc(32, 0x24).toString("base64url"),
      id: "held-local-release",
      version: "2026-11-01",
    },
    schemaVersion: 1,
    tenantId: TENANT_ID,
  };
  const payload = encodeOperationPromotionDecisionClaims(claims);
  const signature = sign(null, payload, privateKey);
  payload.fill(0);
  const artifact = JSON.stringify({
    claims,
    signature: signature.toString("base64url"),
  });
  signature.fill(0);
  return { artifact, claims, keyringJson };
}

function verifier(keyringJson: string) {
  return new OperationPromotionDecisionVerifier({
    clock: () => NOW,
    environment: "homologation",
    keyring: parseOperationPromotionKeyring(keyringJson),
    logicalDatabaseId: LOGICAL_DATABASE_ID,
    maxFutureSkewMs: 30_000,
    maxTtlMs: 10 * 60 * 1_000,
  });
}

describe("OperationPromotionDecisionVerifier", () => {
  it("verifica Ed25519 e produz somente os digests derivados do artefato", () => {
    const input = fixture();
    const checked = verifier(input.keyringJson).verify(input.artifact);
    const promotion = checked.promotionInput();

    expect(checked.tenantId).toBe(TENANT_ID);
    expect(checked.operationId).toBe(OPERATION_ID);
    expect(checked.binding).toEqual(input.claims.binding);
    expect(promotion.operationId).toBe(OPERATION_ID);
    expect(promotion.changedByDigest).toEqual(Buffer.alloc(32, 0x21));
    expect(promotion.artifactDigest).toHaveLength(32);
    expect(promotion.authorizationBindingDigest).toHaveLength(32);
    expect(promotion.evidenceManifestDigest).toEqual(Buffer.alloc(32, 0x22));
    expect(promotion.executorWorkloadDigest).toEqual(Buffer.alloc(32, 0x25));

    promotion.changedByDigest.fill(0);
    promotion.artifactDigest.fill(0);
    promotion.authorizationBindingDigest.fill(0);
    promotion.evidenceManifestDigest.fill(0);
    promotion.executorWorkloadDigest.fill(0);
    checked.destroy();
    expect(() => checked.promotionInput()).toThrow(
      OperationPromotionDecisionInvalidError,
    );
  });

  it("deriva digests estáveis do artefato e do binding completo", () => {
    const first = fixture();
    const firstDecision = verifier(first.keyringJson).verify(first.artifact);
    const firstInput = firstDecision.promotionInput();

    const replayDecision = verifier(first.keyringJson).verify(first.artifact);
    const replayInput = replayDecision.promotionInput();
    expect(replayInput.authorizationBindingDigest).toEqual(
      firstInput.authorizationBindingDigest,
    );
    expect(replayInput.artifactDigest).toEqual(firstInput.artifactDigest);

    for (const value of [firstInput, replayInput]) {
      value.changedByDigest.fill(0);
      value.artifactDigest.fill(0);
      value.authorizationBindingDigest.fill(0);
      value.evidenceManifestDigest.fill(0);
      value.executorWorkloadDigest.fill(0);
    }
    firstDecision.destroy();
    replayDecision.destroy();
  });

  it.each([
    ["environment", "production"],
    ["logicalDatabaseId", "00000000-0000-4000-8000-000000000075"],
    ["effect", "deny"],
    ["action", "send-operation"],
  ])("rejeita claim divergente %s", (field, value) => {
    const input = fixture();
    const parsed = JSON.parse(input.artifact) as {
      claims: Record<string, unknown>;
      signature: string;
    };
    parsed.claims[field] = value;
    expect(() =>
      verifier(input.keyringJson).verify(JSON.stringify(parsed)),
    ).toThrow(OperationPromotionDecisionInvalidError);
  });

  it("rejeita artefato válido destinado a outro ambiente ou banco lógico", () => {
    const input = fixture();
    const keyring = parseOperationPromotionKeyring(input.keyringJson);
    for (const expected of [
      {
        environment: "production" as const,
        logicalDatabaseId: LOGICAL_DATABASE_ID,
      },
      {
        environment: "homologation" as const,
        logicalDatabaseId: "00000000-0000-4000-8000-000000000075",
      },
    ]) {
      const targetVerifier = new OperationPromotionDecisionVerifier({
        clock: () => NOW,
        ...expected,
        keyring,
        maxFutureSkewMs: 30_000,
        maxTtlMs: 10 * 60 * 1_000,
      });
      expect(() => targetVerifier.verify(input.artifact)).toThrow(
        OperationPromotionDecisionInvalidError,
      );
      targetVerifier.destroy();
    }
  });

  it("rejeita artefato não canônico, campos extras e assinatura alterada", () => {
    const input = fixture();
    expect(() =>
      verifier(input.keyringJson).verify(`${input.artifact}\n`),
    ).toThrow(OperationPromotionDecisionInvalidError);
    const extra = JSON.parse(input.artifact) as Record<string, unknown>;
    extra.extra = true;
    expect(() =>
      verifier(input.keyringJson).verify(JSON.stringify(extra)),
    ).toThrow(OperationPromotionDecisionInvalidError);
    const changed = JSON.parse(input.artifact) as {
      claims: OperationPromotionDecisionClaims;
      signature: string;
    };
    changed.signature = `${changed.signature[0] === "A" ? "B" : "A"}${changed.signature.slice(1)}`;
    expect(() =>
      verifier(input.keyringJson).verify(JSON.stringify(changed)),
    ).toThrow(OperationPromotionDecisionInvalidError);
  });

  it("rejeita validade futura, expirada e TTL acima do teto", () => {
    const input = fixture();
    const scenarios = [
      { issuedAt: "2026-11-24T18:01:00.000Z" },
      { expiresAt: "2026-11-24T18:00:00.000Z" },
      { expiresAt: "2026-11-24T19:00:00.000Z" },
    ];
    for (const patch of scenarios) {
      const claims = { ...input.claims, ...patch };
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const spki = publicKey.export({ format: "der", type: "spki" });
      const keyring = JSON.stringify({
        algorithm: "Ed25519",
        audience: "seu-renave/operation-promotion-decision/v1",
        keys: [
          {
            keyId: claims.issuerKeyId,
            publicKeySpki: spki.toString("base64url"),
          },
        ],
        schemaVersion: 1,
      });
      spki.fill(0);
      const payload = encodeOperationPromotionDecisionClaims(claims);
      const signature = sign(null, payload, privateKey);
      payload.fill(0);
      const artifact = JSON.stringify({
        claims,
        signature: signature.toString("base64url"),
      });
      signature.fill(0);
      expect(() => verifier(keyring).verify(artifact)).toThrow(
        OperationPromotionDecisionInvalidError,
      );
    }
  });

  it("aceita somente keyring canônico com chaves públicas Ed25519", () => {
    const input = fixture();
    expect(parseOperationPromotionKeyring(input.keyringJson).keys.size).toBe(1);
    expect(() =>
      parseOperationPromotionKeyring(` ${input.keyringJson}`),
    ).toThrow(OperationPromotionDecisionConfigurationError);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = publicKey.export({ format: "der", type: "spki" });
    const wrong = JSON.stringify({
      algorithm: "Ed25519",
      audience: "seu-renave/operation-promotion-decision/v1",
      keys: [{ keyId: "rsa", publicKeySpki: spki.toString("base64url") }],
      schemaVersion: 1,
    });
    spki.fill(0);
    expect(() => parseOperationPromotionKeyring(wrong)).toThrow(
      OperationPromotionDecisionConfigurationError,
    );

    const { publicKey: forgedKey } = generateKeyPairSync("ed25519");
    expect(
      () =>
        new OperationPromotionDecisionVerifier({
          clock: () => NOW,
          environment: "homologation",
          keyring: { keys: new Map([["forged", forgedKey]]) },
          logicalDatabaseId: LOGICAL_DATABASE_ID,
          maxTtlMs: 10 * 60 * 1_000,
        }),
    ).toThrow(OperationPromotionDecisionConfigurationError);
  });
});
