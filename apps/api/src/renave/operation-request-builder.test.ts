import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OperationRequestCipher,
  OperationRequestDecryptionError,
  OperationReconciliationProjectionCipher,
  type EncryptedOperationRequest,
  type OperationRequestBinding,
} from "@seu-renave/protected-evidence";
import {
  restorePreparedRenaveMutation,
  type PreparedRenaveMutation,
} from "@seu-renave/renave-connector";

import {
  buildCreateOperationInput,
  OperationRequestBuilderError,
  type BuildCreateOperationInput,
} from "./operation-request-builder.js";

const metadata = {
  actorSubjectHash: Buffer.alloc(32, 1),
  correlationId: "33333333-3333-4333-8333-333333333333",
  environment: "homologation" as const,
  establishmentId: "22222222-2222-4222-8222-222222222222",
  idempotencyKeyDigest: Buffer.alloc(32, 2),
  tenantId: "11111111-1111-4111-8111-111111111111",
  vehicleKeyDigest: Buffer.alloc(32, 3),
};

function cipher(): OperationRequestCipher {
  return new OperationRequestCipher({
    activeKeyId: "operation-key-2026-11",
    environment: "homologation",
    keys: new Map([["operation-key-2026-11", Buffer.alloc(32, 7)]]),
  });
}

function projectionCipher(): OperationReconciliationProjectionCipher {
  return new OperationReconciliationProjectionCipher({
    activeKeyId: "projection-key-2026-11",
    environment: "homologation",
    masterKeys: new Map([["projection-key-2026-11", Buffer.alloc(32, 8)]]),
  });
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

async function preparedExact(): Promise<PreparedRenaveMutation> {
  const exact = Buffer.from(
    JSON.stringify({
      cpfOperadorResponsavel: "123.456.789-01",
      dataCompra: "2026-11-24",
      emailEstabelecimento: "loja@example.test",
      emailVendedor: "vendedor@example.test",
      valorCompra: 100,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        dataHoraMedicaoHodometro: "2026-11-24T12:00:00-03:00",
        documentoProprietarioAtual: "12345678901",
        numeroCrv: "123456789012",
        placa: "QTP4H82",
        quilometragemHodometro: 10,
        renavam: "10987654321",
        tipoCrv: "DIGITAL",
        tipoDocumentoProprietarioAtual: "CPF",
      },
    }),
    "utf8",
  );
  return restorePreparedRenaveMutation(
    "request-stock-entry",
    exact,
    sha256(exact).toString("hex"),
  );
}

function binding(input: BuildCreateOperationInput): OperationRequestBinding {
  return {
    actorSubjectHash: input.actorSubjectHash,
    correlationId: input.correlationId,
    environment: input.environment,
    establishmentId: input.establishmentId,
    idempotencyKeyDigest: input.idempotencyKeyDigest,
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestSchemaVersion: 1,
    tenantId: input.tenantId,
    vehicleKeyDigest: input.vehicleKeyDigest,
  };
}

function envelope(
  operation: ReturnType<typeof buildCreateOperationInput>,
): EncryptedOperationRequest {
  return {
    authTag: Buffer.from(operation.requestAuthTag),
    ciphertext: Buffer.from(operation.requestCiphertext),
    keyId: operation.requestKeyId,
    nonce: Buffer.from(operation.requestNonce),
    operation: "request-stock-entry",
    requestByteLength: operation.requestCiphertext.byteLength,
    requestSha256: operation.requestSha256.toString("hex"),
  };
}

describe("buildCreateOperationInput", () => {
  it("produz input coerente a partir dos mesmos bytes preparados", async () => {
    const prepared = await preparedExact();
    const input = { ...metadata, prepared };
    const requestCipher = cipher();
    const reconciliationCipher = projectionCipher();

    const operation = buildCreateOperationInput(
      requestCipher,
      reconciliationCipher,
      input,
    );
    const restored = await requestCipher.decrypt(
      envelope(operation),
      binding(input),
    );
    const plaintext = restored.copyBodyBytes();
    const restoredProjection = reconciliationCipher.decrypt(
      {
        authTag: Buffer.from(operation.reconciliationProjectionAuthTag),
        ciphertext: Buffer.from(operation.reconciliationProjectionCiphertext),
        generation: operation.reconciliationProjectionGeneration,
        keyId: operation.reconciliationProjectionKeyId,
        nonce: Buffer.from(operation.reconciliationProjectionNonce),
        projectionByteLength: operation.reconciliationProjectionByteLength,
        projectionKind: operation.reconciliationProjectionKind,
        projectionSchemaVersion:
          operation.reconciliationProjectionSchemaVersion,
      },
      {
        environment: input.environment,
        establishmentId: input.establishmentId,
        generation: 1,
        kind: "USED_STOCK_ENTRY",
        mutationFamily: "STOCK_ENTRY",
        operationId: operation.operationId,
        requestSchemaVersion: 1,
        sourceRequestSha256: operation.requestSha256.toString("hex"),
        tenantId: input.tenantId,
      },
    );
    const projectionPlaintext = restoredProjection.copyBodyBytes();

    expect(operation).toMatchObject({
      correlationId: metadata.correlationId,
      establishmentId: metadata.establishmentId,
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      requestKeyId: "operation-key-2026-11",
      requestSchemaVersion: 1,
    });
    expect(operation.requestCiphertext).toHaveLength(prepared.byteLength);
    expect(operation.requestSha256).toEqual(sha256(plaintext));
    expect(operation.requestSha256.toString("hex")).toBe(
      prepared.requestSha256,
    );
    expect(sha256(operation.requestCiphertext)).not.toEqual(
      operation.requestSha256,
    );
    expect(Buffer.from(plaintext)).toEqual(
      Buffer.from(prepared.copyBodyBytes()),
    );
    expect(JSON.parse(new TextDecoder().decode(projectionPlaintext))).toEqual({
      cpfOperadorResponsavel: "12345678901",
      schemaVersion: 1,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        numeroCrv: "123456789012",
        placa: "QTP4H82",
        renavam: "10987654321",
        tipoCrv: "DIGITAL",
      },
    });
    restoredProjection.destroy();
  });

  it("devolve cópias defensivas dos metadados e do envelope", async () => {
    const prepared = await preparedExact();
    const input = {
      ...metadata,
      actorSubjectHash: Buffer.from(metadata.actorSubjectHash),
      idempotencyKeyDigest: Buffer.from(metadata.idempotencyKeyDigest),
      prepared,
      vehicleKeyDigest: Buffer.from(metadata.vehicleKeyDigest),
    };
    const operation = buildCreateOperationInput(
      cipher(),
      projectionCipher(),
      input,
    );
    input.actorSubjectHash.fill(0);
    input.idempotencyKeyDigest.fill(0);
    input.vehicleKeyDigest.fill(0);

    expect(operation.actorSubjectHash).toEqual(metadata.actorSubjectHash);
    expect(operation.idempotencyKeyDigest).toEqual(
      metadata.idempotencyKeyDigest,
    );
    expect(operation.vehicleKeyDigest).toEqual(metadata.vehicleKeyDigest);
  });

  it("duas montagens mantêm o hash e variam nonce/ciphertext", async () => {
    const prepared = await preparedExact();
    const input = { ...metadata, prepared };
    const requestCipher = cipher();
    const projection = projectionCipher();
    const first = buildCreateOperationInput(requestCipher, projection, input);
    const second = buildCreateOperationInput(requestCipher, projection, input);

    expect(first.requestSha256).toEqual(second.requestSha256);
    expect(first.requestNonce.equals(second.requestNonce)).toBe(false);
    expect(first.requestCiphertext.equals(second.requestCiphertext)).toBe(
      false,
    );

    first.requestNonce.fill(0);
    first.requestAuthTag.fill(0);
    first.requestCiphertext.fill(0);
    await expect(
      requestCipher.decrypt(envelope(second), binding(input)),
    ).resolves.toMatchObject({ requestSha256: prepared.requestSha256 });
  });

  it("recusa cifrador falso, sem brand ou com dispatch forjado", async () => {
    const prepared = await preparedExact();
    const input = { ...metadata, prepared };
    const fake = {
      encrypt: () => ({
        authTag: Buffer.alloc(16),
        ciphertext: prepared.copyBodyBytes(),
        keyId: "fake",
        nonce: Buffer.alloc(12),
        operation: prepared.operation,
        requestByteLength: prepared.byteLength,
        requestSha256: prepared.requestSha256,
      }),
    } as unknown as OperationRequestCipher;
    const prototypeOnly = Object.create(
      OperationRequestCipher.prototype,
    ) as OperationRequestCipher;

    expect(() =>
      buildCreateOperationInput(fake, projectionCipher(), input),
    ).toThrow();
    expect(() =>
      buildCreateOperationInput(prototypeOnly, projectionCipher(), input),
    ).toThrow();

    let projectionDispatchCalled = false;
    const fakeProjection = {
      encrypt: () => {
        projectionDispatchCalled = true;
        return {};
      },
    } as unknown as OperationReconciliationProjectionCipher;
    const projectionPrototypeOnly = Object.create(
      OperationReconciliationProjectionCipher.prototype,
    ) as OperationReconciliationProjectionCipher;
    const projectionProxy = new Proxy(projectionCipher(), {});
    class ProjectionSubclass extends OperationReconciliationProjectionCipher {}
    const projectionSubclassOnly = Object.create(
      ProjectionSubclass.prototype,
    ) as OperationReconciliationProjectionCipher;
    for (const forged of [
      fakeProjection,
      projectionPrototypeOnly,
      projectionProxy,
      projectionSubclassOnly,
    ]) {
      expect(() => buildCreateOperationInput(cipher(), forged, input)).toThrow(
        OperationRequestBuilderError,
      );
    }
    expect(projectionDispatchCalled).toBe(false);
  });

  it("trocar hash ou ciphertext entre operações impede restauração", async () => {
    const firstPrepared = await preparedExact();
    const secondJson = JSON.parse(
      new TextDecoder().decode(firstPrepared.copyBodyBytes()),
    ) as { veiculo: { placa: string } };
    secondJson.veiculo.placa = "ABC1D23";
    const secondBytes = Buffer.from(JSON.stringify(secondJson), "utf8");
    const secondPrepared = await restorePreparedRenaveMutation(
      "request-stock-entry",
      secondBytes,
      sha256(secondBytes).toString("hex"),
    );
    const requestCipher = cipher();
    const firstInput = { ...metadata, prepared: firstPrepared };
    const secondInput = {
      ...metadata,
      correlationId: "44444444-4444-4444-8444-444444444444",
      idempotencyKeyDigest: Buffer.alloc(32, 4),
      prepared: secondPrepared,
    };
    const projection = projectionCipher();
    const first = buildCreateOperationInput(
      requestCipher,
      projection,
      firstInput,
    );
    const second = buildCreateOperationInput(
      requestCipher,
      projection,
      secondInput,
    );
    const mixed = envelope(first);
    mixed.requestSha256 = second.requestSha256.toString("hex");

    await expect(
      requestCipher.decrypt(mixed, binding(firstInput)),
    ).rejects.toBeInstanceOf(OperationRequestDecryptionError);
    const otherCiphertext = envelope(first);
    otherCiphertext.ciphertext = Buffer.from(second.requestCiphertext);
    await expect(
      requestCipher.decrypt(otherCiphertext, binding(firstInput)),
    ).rejects.toBeInstanceOf(OperationRequestDecryptionError);
  });

  it.each([
    ["tenant", { tenantId: "inválido" }],
    ["estabelecimento", { establishmentId: "inválido" }],
    ["correlação", { correlationId: "inválido" }],
    ["ator", { actorSubjectHash: Buffer.alloc(31) }],
    ["idempotência", { idempotencyKeyDigest: Buffer.alloc(31) }],
    ["veículo", { vehicleKeyDigest: Buffer.alloc(31) }],
    ["ambiente", { environment: "staging" }],
  ])("recusa metadado inválido: %s", async (_label, change) => {
    const prepared = await preparedExact();
    expect(() =>
      buildCreateOperationInput(cipher(), projectionCipher(), {
        ...metadata,
        ...change,
        prepared,
      } as BuildCreateOperationInput),
    ).toThrow(OperationRequestBuilderError);
  });
});
