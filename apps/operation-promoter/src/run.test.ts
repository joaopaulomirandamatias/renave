import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { rootCertificates } from "node:tls";

import { describe, expect, it, vi } from "vitest";

import { encodeOperationPromotionDecisionClaims } from "@seu-renave/operation-promotion-decision";

import { OperationPromoterError } from "./errors.js";
import type {
  OperationPromotionPort,
  OperationPromotionReceipt,
} from "./port.js";
import { runOperationPromoter } from "./run.js";
import type { OperationPromoterFiles } from "./secret-files.js";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const DATABASE_ID = "00000000-0000-4000-8000-000000000074";

function fixture(workloadByte = 0x25): {
  files: OperationPromoterFiles;
  buffers: Buffer[];
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyring = JSON.stringify({
    algorithm: "Ed25519",
    audience: "seu-renave/operation-promotion-decision/v1",
    keys: [
      { keyId: "ops-hml-2026-01", publicKeySpki: spki.toString("base64url") },
    ],
    schemaVersion: 1,
  });
  spki.fill(0);
  const claims = {
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
    decisionId: "30000000-0000-4000-8000-000000000003",
    effect: "allow",
    environment: "homologation",
    evidence: {
      digest: Buffer.alloc(32, 0x22).toString("base64url"),
      type: "dual-control-review/v1",
    },
    expiresAt: "2026-11-24T18:05:00.000Z",
    executorWorkloadDigest: Buffer.alloc(32, workloadByte).toString(
      "base64url",
    ),
    issuedAt: "2026-11-24T17:59:00.000Z",
    issuerKeyId: "ops-hml-2026-01",
    logicalDatabaseId: DATABASE_ID,
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
  } as const;
  const payload = encodeOperationPromotionDecisionClaims(claims);
  const signature = sign(null, payload, privateKey);
  payload.fill(0);
  const decision = JSON.stringify({
    claims,
    signature: signature.toString("base64url"),
  });
  signature.fill(0);
  const buffers = [
    Buffer.from(rootCertificates[0]!),
    Buffer.from(
      "postgresql://renave_operation_promoter:secret@db.internal:5432/renave",
    ),
    Buffer.from(decision),
    Buffer.from(keyring),
    Buffer.from(
      JSON.stringify({
        database: { host: "db.internal", name: "renave", port: 5432 },
        decisionKeyringDigest: createHash("sha256")
          .update(keyring)
          .digest("base64url"),
        environment: "homologation",
        executorWorkloadDigest: Buffer.alloc(32, 0x25).toString("base64url"),
        logicalDatabaseId: DATABASE_ID,
        schemaVersion: 1,
      }),
    ),
  ];
  let destroyed = false;
  return {
    buffers,
    files: Object.freeze({
      ca: buffers[0]!,
      databaseUrl: buffers[1]!,
      decision: buffers[2]!,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const buffer of buffers) buffer.fill(0);
      },
      keyring: buffers[3]!,
      target: buffers[4]!,
    }),
  };
}

function fakePort(receipt?: Partial<OperationPromotionReceipt>): {
  port: OperationPromotionPort;
  attest: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
} {
  const attest = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const promote = vi.fn(async () => ({
    operationId: OPERATION_ID,
    promotedAt: NOW,
    replayed: false,
    ...receipt,
  }));
  return { port: { attest, close, promote }, attest, close, promote };
}

describe("runOperationPromoter", () => {
  it("atesta o role, promove uma vez e devolve recibo sem identificadores", async () => {
    const input = fixture();
    const database = fakePort();
    let evidenceManifestDigest: Buffer | undefined;
    let executorWorkloadDigest: Buffer | undefined;
    database.promote.mockImplementationOnce(async (_tenantId, promoted) => {
      evidenceManifestDigest = Buffer.from(promoted.evidenceManifestDigest);
      executorWorkloadDigest = Buffer.from(promoted.executorWorkloadDigest);
      return { operationId: OPERATION_ID, promotedAt: NOW, replayed: false };
    });
    const result = await runOperationPromoter({
      clock: () => NOW,
      createPort: () => database.port,
      readFiles: async () => input.files,
    });

    expect(database.attest).toHaveBeenCalledOnce();
    expect(database.promote).toHaveBeenCalledOnce();
    expect(database.promote.mock.calls[0]?.[0]).toBe(TENANT_ID);
    const promoted = database.promote.mock.calls[0]?.[1];
    expect(promoted.operationId).toBe(OPERATION_ID);
    expect(promoted.logicalDatabaseId).toBe(DATABASE_ID);
    expect(promoted.authorizationBindingDigest).toHaveLength(32);
    expect(promoted.artifactDigest).toHaveLength(32);
    expect(evidenceManifestDigest).toEqual(Buffer.alloc(32, 0x22));
    expect(executorWorkloadDigest).toEqual(Buffer.alloc(32, 0x25));
    expect(result).toEqual({
      outcome: "promoted",
      promotedAt: NOW.toISOString(),
    });
    expect(result).not.toHaveProperty("operationId");
    expect(database.close).toHaveBeenCalledOnce();
    expect(
      input.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    evidenceManifestDigest?.fill(0);
    executorWorkloadDigest?.fill(0);
  });

  it("não chama a porta quando o digest do workload diverge", async () => {
    const input = fixture(0x26);
    const database = fakePort();
    await expect(
      runOperationPromoter({
        clock: () => NOW,
        createPort: () => database.port,
        readFiles: async () => input.files,
      }),
    ).rejects.toMatchObject({
      code: "OPERATION_PROMOTER_DECISION_INVALID",
    });
    expect(database.attest).toHaveBeenCalledOnce();
    expect(database.promote).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
    expect(
      input.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it("rejeita keyring diferente do pin do target antes da promoção", async () => {
    const input = fixture();
    input.files.keyring[0] = input.files.keyring[0]! ^ 1;
    const database = fakePort();
    await expect(
      runOperationPromoter({
        clock: () => NOW,
        createPort: () => database.port,
        readFiles: async () => input.files,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_PROMOTER_CONFIG_INVALID" });
    expect(database.attest).toHaveBeenCalledOnce();
    expect(database.promote).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("não repete automaticamente uma promoção negada e sempre fecha recursos", async () => {
    const input = fixture();
    const database = fakePort();
    database.promote.mockRejectedValueOnce(
      new OperationPromoterError("OPERATION_PROMOTER_DENIED", 2),
    );
    await expect(
      runOperationPromoter({
        clock: () => NOW,
        createPort: () => database.port,
        readFiles: async () => input.files,
      }),
    ).rejects.toMatchObject({
      code: "OPERATION_PROMOTER_DENIED",
      exitCode: 2,
    });
    expect(database.promote).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    expect(
      input.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it("falha fechado se a porta devolver outra operação", async () => {
    const input = fixture();
    const database = fakePort({
      operationId: "60000000-0000-4000-8000-000000000006",
    });
    await expect(
      runOperationPromoter({
        clock: () => NOW,
        createPort: () => database.port,
        readFiles: async () => input.files,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_PROMOTER_FAILED" });
    expect(database.promote).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });
});
