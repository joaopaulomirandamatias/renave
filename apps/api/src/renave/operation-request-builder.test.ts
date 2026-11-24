import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OperationRequestCipher,
  OperationRequestDecryptionError,
  OperationRequestInputError,
  OperationReconciliationProjectionCipher,
  OperationReconciliationProjectionDecryptionError,
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
  establishmentProfileId: "66666666-6666-4666-8666-666666666666",
  establishmentProfileVersion: "11",
  idempotencyKeyDigest: Buffer.alloc(32, 2),
  operatorProfileId: "55555555-5555-4555-8555-555555555555",
  operatorProfileVersion: "7",
  subject: "oidc|operation-builder",
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

async function preparedExitExact(): Promise<PreparedRenaveMutation> {
  const exact = Buffer.from(
    JSON.stringify({
      comprador: {
        email: "comprador@example.test",
        endereco: {
          bairro: "Centro",
          cep: "66000000",
          codigoMunicipio: 1501402,
          complemento: "Sala 2",
          logradouro: "Avenida Brasil",
          numero: "100",
        },
        nome: "Comprador Exemplo",
        numeroDocumento: "52998224725",
        tipoDocumento: "CPF",
      },
      cpfOperadorResponsavel: "52998224725",
      dataVenda: "2026-11-24",
      emailEstabelecimento: "loja@example.test",
      valorVenda: 98500.25,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        numeroCrv: "123456789012",
        placa: "ABC1D23",
        renavam: "10987654321",
      },
    }),
    "utf8",
  );
  return restorePreparedRenaveMutation(
    "request-stock-exit",
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

function exitBinding(
  input: BuildCreateOperationInput,
): OperationRequestBinding {
  return {
    actorSubjectHash: input.actorSubjectHash,
    correlationId: input.correlationId,
    environment: input.environment,
    establishmentId: input.establishmentId,
    idempotencyKeyDigest: input.idempotencyKeyDigest,
    kind: "USED_STOCK_EXIT",
    mutationFamily: "STOCK_EXIT",
    requestSchemaVersion: 1,
    tenantId: input.tenantId,
    vehicleKeyDigest: input.vehicleKeyDigest,
  };
}

function exitEnvelope(
  operation: ReturnType<typeof buildCreateOperationInput>,
): EncryptedOperationRequest {
  return {
    authTag: Buffer.from(operation.requestAuthTag),
    ciphertext: Buffer.from(operation.requestCiphertext),
    keyId: operation.requestKeyId,
    nonce: Buffer.from(operation.requestNonce),
    operation: "request-stock-exit",
    requestByteLength: operation.requestCiphertext.byteLength,
    requestSha256: operation.requestSha256.toString("hex"),
  };
}

function expectPreparedDestroyed(prepared: PreparedRenaveMutation): void {
  for (const read of [
    () => prepared.byteLength,
    () => prepared.operation,
    () => prepared.requestSha256,
    () => prepared.copyBodyBytes(),
    () => prepared.toJSON(),
    () => JSON.stringify(prepared),
  ]) {
    expect(read).toThrow(
      expect.objectContaining({
        code: "INVALID_PREPARED_RENAVE_MUTATION",
        reason: "DESTROYED",
      }),
    );
  }
}

describe("buildCreateOperationInput", () => {
  it("produz input coerente a partir dos mesmos bytes preparados", async () => {
    const prepared = await preparedExact();
    const expectedBody = prepared.copyBodyBytes();
    const expectedByteLength = prepared.byteLength;
    const expectedRequestSha256 = prepared.requestSha256;
    const input = { ...metadata, prepared };
    const requestCipher = cipher();
    const reconciliationCipher = projectionCipher();

    const operation = buildCreateOperationInput(
      requestCipher,
      reconciliationCipher,
      input,
    );
    expectPreparedDestroyed(prepared);
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
      establishmentProfileId: metadata.establishmentProfileId,
      establishmentProfileVersion: metadata.establishmentProfileVersion,
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      operatorProfileId: metadata.operatorProfileId,
      operatorProfileVersion: metadata.operatorProfileVersion,
      requestKeyId: "operation-key-2026-11",
      requestSchemaVersion: 1,
      subject: metadata.subject,
    });
    expect(operation.requestCiphertext).toHaveLength(expectedByteLength);
    expect(operation.requestSha256).toEqual(sha256(plaintext));
    expect(operation.requestSha256.toString("hex")).toBe(expectedRequestSha256);
    expect(sha256(operation.requestCiphertext)).not.toEqual(
      operation.requestSha256,
    );
    expect(Buffer.from(plaintext)).toEqual(Buffer.from(expectedBody));
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
    expectedBody.fill(0);
    restored.destroy();
    restoredProjection.destroy();
  });

  it("produz saída coerente com família e projeção próprias", async () => {
    const prepared = await preparedExitExact();
    const input = { ...metadata, prepared };
    const requestCipher = cipher();
    const reconciliationCipher = projectionCipher();

    const operation = buildCreateOperationInput(
      requestCipher,
      reconciliationCipher,
      input,
    );
    expectPreparedDestroyed(prepared);
    expect(operation).toMatchObject({
      kind: "USED_STOCK_EXIT",
      mutationFamily: "STOCK_EXIT",
      reconciliationProjectionKind: "STOCK_EXIT_RECONCILIATION",
      reconciliationProjectionSchemaVersion: 1,
      requestSchemaVersion: 1,
    });
    const restoredRequest = await requestCipher.decrypt(
      exitEnvelope(operation),
      exitBinding(input),
    );
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
        kind: "USED_STOCK_EXIT",
        mutationFamily: "STOCK_EXIT",
        operationId: operation.operationId,
        requestSchemaVersion: 1,
        sourceRequestSha256: operation.requestSha256.toString("hex"),
        tenantId: input.tenantId,
      },
    );
    expect(
      JSON.parse(new TextDecoder().decode(restoredProjection.copyBodyBytes())),
    ).toEqual({
      comprador: {
        numeroDocumento: "52998224725",
        tipoDocumento: "CPF",
      },
      cpfOperadorResponsavel: "52998224725",
      dataVenda: "2026-11-24",
      schemaVersion: 1,
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        numeroCrv: "123456789012",
        placa: "ABC1D23",
        renavam: "10987654321",
      },
    });
    restoredRequest.destroy();
    restoredProjection.destroy();
  });

  it("recusa restaurar saída sob identidade criptográfica de entrada", async () => {
    const prepared = await preparedExitExact();
    const input = { ...metadata, prepared };
    const requestCipher = cipher();
    const reconciliationCipher = projectionCipher();
    const operation = buildCreateOperationInput(
      requestCipher,
      reconciliationCipher,
      input,
    );
    expectPreparedDestroyed(prepared);

    await expect(
      requestCipher.decrypt(exitEnvelope(operation), binding(input)),
    ).rejects.toBeInstanceOf(OperationRequestInputError);
    expect(() =>
      reconciliationCipher.decrypt(
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
      ),
    ).toThrow(OperationReconciliationProjectionDecryptionError);
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
    expectPreparedDestroyed(prepared);
    input.actorSubjectHash.fill(0);
    input.idempotencyKeyDigest.fill(0);
    input.vehicleKeyDigest.fill(0);

    expect(operation.actorSubjectHash).toEqual(metadata.actorSubjectHash);
    expect(operation.idempotencyKeyDigest).toEqual(
      metadata.idempotencyKeyDigest,
    );
    expect(operation.vehicleKeyDigest).toEqual(metadata.vehicleKeyDigest);
  });

  it("duas montagens independentes mantêm o hash e variam nonce/ciphertext", async () => {
    const firstPrepared = await preparedExact();
    const secondPrepared = await preparedExact();
    const expectedRequestSha256 = firstPrepared.requestSha256;
    const firstInput = { ...metadata, prepared: firstPrepared };
    const secondInput = { ...metadata, prepared: secondPrepared };
    const requestCipher = cipher();
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
    expectPreparedDestroyed(firstPrepared);
    expectPreparedDestroyed(secondPrepared);

    expect(first.requestSha256).toEqual(second.requestSha256);
    expect(first.requestNonce.equals(second.requestNonce)).toBe(false);
    expect(first.requestCiphertext.equals(second.requestCiphertext)).toBe(
      false,
    );

    first.requestNonce.fill(0);
    first.requestAuthTag.fill(0);
    first.requestCiphertext.fill(0);
    await expect(
      requestCipher.decrypt(envelope(second), binding(secondInput)),
    ).resolves.toMatchObject({ requestSha256: expectedRequestSha256 });
  });

  it("recusa cifrador falso, sem brand ou com dispatch forjado", async () => {
    const fake = {
      encrypt: () => ({}),
    } as unknown as OperationRequestCipher;
    const prototypeOnly = Object.create(
      OperationRequestCipher.prototype,
    ) as OperationRequestCipher;

    for (const forged of [fake, prototypeOnly]) {
      const prepared = await preparedExact();
      expect(() =>
        buildCreateOperationInput(forged, projectionCipher(), {
          ...metadata,
          prepared,
        }),
      ).toThrow(OperationRequestBuilderError);
      expectPreparedDestroyed(prepared);
    }

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
      const prepared = await preparedExact();
      expect(() =>
        buildCreateOperationInput(cipher(), forged, {
          ...metadata,
          prepared,
        }),
      ).toThrow(OperationRequestBuilderError);
      expectPreparedDestroyed(prepared);
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
    expectPreparedDestroyed(firstPrepared);
    expectPreparedDestroyed(secondPrepared);
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
    ["perfil do operador", { operatorProfileId: "inválido" }],
    ["versão do operador", { operatorProfileVersion: "0" }],
    ["perfil do estabelecimento", { establishmentProfileId: "inválido" }],
    ["versão do estabelecimento", { establishmentProfileVersion: "0" }],
    ["sujeito", { subject: "" }],
  ])("recusa metadado inválido: %s", async (_label, change) => {
    const prepared = await preparedExact();
    expect(() =>
      buildCreateOperationInput(cipher(), projectionCipher(), {
        ...metadata,
        ...change,
        prepared,
      } as BuildCreateOperationInput),
    ).toThrow(OperationRequestBuilderError);
    expectPreparedDestroyed(prepared);
  });
});
