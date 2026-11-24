import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  prepareRenaveMutation,
  restorePreparedRenaveMutation,
  type PreparedRenaveMutation,
} from "@seu-renave/renave-connector";

import {
  OperationRequestCipher,
  OperationRequestDecryptionError,
  type EncryptedOperationRequest,
  type OperationRequestBinding,
} from "./operation-request-crypto.js";
import {
  decryptOperationReconciliationProjection,
  encryptOperationReconciliationProjection,
  OperationReconciliationProjectionCipher,
  OperationReconciliationProjectionConfigurationError,
  OperationReconciliationProjectionDecryptionError,
  OperationReconciliationProjectionInputError,
  PreparedOperationReconciliationProjection,
  isOperationReconciliationProjectionByteLengthAllowed,
  prepareOperationReconciliationProjection,
  restoreOperationReconciliationProjection,
  type EncryptedOperationReconciliationProjection,
  type OperationReconciliationProjectionBinding,
} from "./operation-reconciliation-projection.js";

const MASTER = Buffer.alloc(32, 0x47);
const SOURCE_HASH_SENTINEL = "a".repeat(64);
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const binding: OperationReconciliationProjectionBinding = {
  environment: "homologation",
  establishmentId: ESTABLISHMENT_ID,
  generation: 1,
  kind: "USED_STOCK_ENTRY",
  mutationFamily: "STOCK_ENTRY",
  operationId: OPERATION_ID,
  requestSchemaVersion: 1,
  sourceRequestSha256: SOURCE_HASH_SENTINEL,
  tenantId: TENANT_ID,
};

const requestBinding: OperationRequestBinding = {
  actorSubjectHash: Buffer.alloc(32, 1),
  correlationId: "44444444-4444-4444-8444-444444444444",
  environment: "homologation",
  establishmentId: ESTABLISHMENT_ID,
  idempotencyKeyDigest: Buffer.alloc(32, 2),
  kind: "USED_STOCK_ENTRY",
  mutationFamily: "STOCK_ENTRY",
  requestSchemaVersion: 1,
  tenantId: TENANT_ID,
  vehicleKeyDigest: Buffer.alloc(32, 3),
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    cpfOperadorResponsavel: "123.456.789-01",
    dataCompra: "2026-11-24",
    emailEstabelecimento: "estabelecimento@example.test",
    emailVendedor: "vendedor@example.test",
    valorCompra: 123_456.78,
    veiculo: {
      codigoSegurancaCrv: "12345678901",
      dataHoraMedicaoHodometro: "2026-11-24T09:00:00-03:00",
      documentoProprietarioAtual: "00000000000",
      numeroCrv: "123456789012",
      placa: "QTP4H82",
      quilometragemHodometro: 99_999,
      renavam: "10987654321",
      tipoCrv: "DIGITAL",
      tipoDocumentoProprietarioAtual: "CPF",
    },
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function preparedFromBytes(
  text: string,
): Promise<PreparedRenaveMutation> {
  const bytes = Buffer.from(text, "utf8");
  return restorePreparedRenaveMutation(
    "request-stock-entry",
    bytes,
    sha256(bytes),
  );
}

function cipher(
  activeKeyId = "projection-key-2026-11",
  masterKeys: ReadonlyMap<string, Uint8Array> = new Map([
    ["projection-key-2026-11", MASTER],
  ]),
  environment: "homologation" | "production" = "homologation",
): OperationReconciliationProjectionCipher {
  return new OperationReconciliationProjectionCipher({
    activeKeyId,
    environment,
    masterKeys,
  });
}

function cloneEnvelope(
  envelope: EncryptedOperationReconciliationProjection,
): EncryptedOperationReconciliationProjection {
  return {
    ...envelope,
    authTag: Buffer.from(envelope.authTag),
    ciphertext: Buffer.from(envelope.ciphertext),
    nonce: Buffer.from(envelope.nonce),
  };
}

async function preparedProjection() {
  const source = await prepareRenaveMutation("request-stock-entry", request());
  const localBinding = {
    ...binding,
    sourceRequestSha256: source.requestSha256,
  };
  return {
    localBinding,
    prepared: prepareOperationReconciliationProjection(source),
    source,
  };
}

describe("codec fechado da projeção de reconciliação", () => {
  it("deriva somente os campos mínimos em bytes canônicos determinísticos", async () => {
    const source = await prepareRenaveMutation(
      "request-stock-entry",
      request(),
    );
    const projection = prepareOperationReconciliationProjection(source);
    const expected =
      '{"schemaVersion":1,"cpfOperadorResponsavel":"12345678901","veiculo":{"codigoSegurancaCrv":"12345678901","placa":"QTP4H82","tipoCrv":"DIGITAL","renavam":"10987654321","numeroCrv":"123456789012"}}';

    expect(new TextDecoder().decode(projection.copyBodyBytes())).toBe(expected);
    expect(projection.byteLength).toBe(Buffer.byteLength(expected));
    expect(projection.projectionKind).toBe("STOCK_ENTRY_RECONCILIATION");
    expect(projection.schemaVersion).toBe(1);
    expect(expected).not.toMatch(
      /email|valorCompra|dataCompra|hodometro|documentoProprietario/u,
    );

    const copy = projection.copyBodyBytes();
    copy.fill(0);
    expect(new TextDecoder().decode(projection.copyBodyBytes())).toBe(expected);
  });

  it("produz os mesmos bytes para duas ordens de input e aceita limites oficiais", async () => {
    const first = request({
      dataCompra: "2024-02-29",
      valorCompra: 99_999_999.99,
    });
    const originalVehicle = first.veiculo as Record<string, unknown>;
    first.veiculo = {
      tipoDocumentoProprietarioAtual: "CNPJ",
      tipoCrv: originalVehicle["tipoCrv"],
      renavam: originalVehicle["renavam"],
      quilometragemHodometro: 2_147_483_647,
      placa: originalVehicle["placa"],
      numeroCrv: originalVehicle["numeroCrv"],
      documentoProprietarioAtual: "12ABC34501DE35",
      dataHoraMedicaoHodometro: "2026-11-24T12:00:00Z",
      codigoSegurancaCrv: originalVehicle["codigoSegurancaCrv"],
    } as typeof first.veiculo;
    const secondVehicle = first.veiculo as Record<string, unknown>;
    const second = {
      veiculo: {
        codigoSegurancaCrv: secondVehicle["codigoSegurancaCrv"],
        dataHoraMedicaoHodometro: secondVehicle["dataHoraMedicaoHodometro"],
        documentoProprietarioAtual: secondVehicle["documentoProprietarioAtual"],
        numeroCrv: secondVehicle["numeroCrv"],
        placa: secondVehicle["placa"],
        quilometragemHodometro: secondVehicle["quilometragemHodometro"],
        renavam: secondVehicle["renavam"],
        tipoCrv: secondVehicle["tipoCrv"],
        tipoDocumentoProprietarioAtual:
          secondVehicle["tipoDocumentoProprietarioAtual"],
      },
      valorCompra: first.valorCompra,
      emailVendedor: first.emailVendedor,
      emailEstabelecimento: first.emailEstabelecimento,
      dataCompra: first.dataCompra,
      cpfOperadorResponsavel: first.cpfOperadorResponsavel,
    };
    const firstPrepared = prepareOperationReconciliationProjection(
      await prepareRenaveMutation("request-stock-entry", first),
    );
    const secondPrepared = prepareOperationReconciliationProjection(
      await prepareRenaveMutation("request-stock-entry", second),
    );
    expect(Buffer.from(firstPrepared.copyBodyBytes())).toEqual(
      Buffer.from(secondPrepared.copyBodyBytes()),
    );
  });

  it("omite opcionais ausentes e rejeita opcionais vazios", async () => {
    const vehicle = { ...(request().veiculo as Record<string, unknown>) };
    delete vehicle["renavam"];
    delete vehicle["numeroCrv"];
    const projection = prepareOperationReconciliationProjection(
      await prepareRenaveMutation(
        "request-stock-entry",
        request({ veiculo: vehicle }),
      ),
    );
    expect(new TextDecoder().decode(projection.copyBodyBytes())).not.toMatch(
      /renavam|numeroCrv/u,
    );

    for (const field of ["renavam", "numeroCrv"] as const) {
      const invalidVehicle = {
        ...(request().veiculo as Record<string, unknown>),
        [field]: "   ",
      };
      delete invalidVehicle[field === "renavam" ? "numeroCrv" : "renavam"];
      const source = await prepareRenaveMutation(
        "request-stock-entry",
        request({ veiculo: invalidVehicle }),
      );
      expect(() => prepareOperationReconciliationProjection(source)).toThrow(
        OperationReconciliationProjectionInputError,
      );
    }
  });

  it.each([
    ["top-level desconhecida", { ...request(), extra: true }],
    [
      "alias vehicle em vez de veiculo",
      (() => {
        const value = request() as Record<string, unknown>;
        value["vehicle"] = value["veiculo"];
        delete value["veiculo"];
        return value;
      })(),
    ],
    [
      "top-level ausente",
      (() => {
        const value = request();
        delete (value as Record<string, unknown>)["dataCompra"];
        return value;
      })(),
    ],
    ["top-level null", { ...request(), dataCompra: null }],
    ["CPF inválido", { ...request(), cpfOperadorResponsavel: "123" }],
    [
      "CPF com máscara não canônica",
      { ...request(), cpfOperadorResponsavel: "123 456 789 01" },
    ],
    ["número inválido", { ...request(), valorCompra: "123" }],
    ["valor negativo", { ...request(), valorCompra: -0.01 }],
    ["valor acima do máximo", { ...request(), valorCompra: 100_000_000 }],
    ["data impossível", { ...request(), dataCompra: "2025-02-29" }],
    ["data fora do formato", { ...request(), dataCompra: "24/11/2026" }],
    [
      "email de estabelecimento inválido",
      { ...request(), emailEstabelecimento: "x+tag@example.test" },
    ],
    [
      "email de vendedor inválido",
      { ...request(), emailVendedor: "x@example" },
    ],
    ["veículo null", { ...request(), veiculo: null }],
    [
      "placa inválida",
      { ...request(), veiculo: { ...request().veiculo, placa: "ABC" } },
    ],
    [
      "placa lowercase",
      { ...request(), veiculo: { ...request().veiculo, placa: "qtp4h82" } },
    ],
    [
      "placa com whitespace periférico",
      { ...request(), veiculo: { ...request().veiculo, placa: " QTP4H82 " } },
    ],
    [
      "tipo CRV inválido",
      { ...request(), veiculo: { ...request().veiculo, tipoCrv: "ROSA" } },
    ],
    [
      "tipo proprietário inválido",
      {
        ...request(),
        veiculo: { ...request().veiculo, tipoDocumentoProprietarioAtual: "RG" },
      },
    ],
    [
      "código de segurança inválido",
      {
        ...request(),
        veiculo: { ...request().veiculo, codigoSegurancaCrv: "123" },
      },
    ],
    [
      "número CRV inválido",
      { ...request(), veiculo: { ...request().veiculo, numeroCrv: "1" } },
    ],
    [
      "número CRV null",
      { ...request(), veiculo: { ...request().veiculo, numeroCrv: null } },
    ],
    [
      "RENAVAM inválido",
      { ...request(), veiculo: { ...request().veiculo, renavam: "ABC" } },
    ],
    [
      "hodômetro fracionário",
      {
        ...request(),
        veiculo: { ...request().veiculo, quilometragemHodometro: 1.5 },
      },
    ],
    [
      "hodômetro negativo",
      {
        ...request(),
        veiculo: { ...request().veiculo, quilometragemHodometro: -1 },
      },
    ],
    [
      "hodômetro acima de int32",
      {
        ...request(),
        veiculo: {
          ...request().veiculo,
          quilometragemHodometro: 2_147_483_648,
        },
      },
    ],
    [
      "data-hora sem offset",
      {
        ...request(),
        veiculo: {
          ...request().veiculo,
          dataHoraMedicaoHodometro: "2026-11-24T09:00:00",
        },
      },
    ],
    [
      "data-hora impossível",
      {
        ...request(),
        veiculo: {
          ...request().veiculo,
          dataHoraMedicaoHodometro: "2026-02-29T09:00:00-03:00",
        },
      },
    ],
    [
      "documento CPF incompatível",
      {
        ...request(),
        veiculo: {
          ...request().veiculo,
          documentoProprietarioAtual: "ABCDEFGHIJKL12",
        },
      },
    ],
    [
      "documento CNPJ incompatível",
      {
        ...request(),
        veiculo: {
          ...request().veiculo,
          documentoProprietarioAtual: "12345678901",
          tipoDocumentoProprietarioAtual: "CNPJ",
        },
      },
    ],
    [
      "campo de veículo desconhecido",
      {
        ...request(),
        veiculo: { ...request().veiculo, prototype: "pollution" },
      },
    ],
  ])("recusa %s", async (_label, payload) => {
    const source = await prepareRenaveMutation("request-stock-entry", payload);
    expect(() => prepareOperationReconciliationProjection(source)).toThrow(
      OperationReconciliationProjectionInputError,
    );
  });

  it.each([
    [
      "chave top-level duplicada",
      JSON.stringify(request()).replace(
        "{",
        '{"cpfOperadorResponsavel":"00000000000",',
      ),
    ],
    [
      "chave de veículo duplicada",
      JSON.stringify(request()).replace(
        '"veiculo":{',
        '"veiculo":{"placa":"AAAAAAA",',
      ),
    ],
    [
      "prototype key",
      JSON.stringify(request()).replace("{", '{"__proto__":{"x":1},'),
    ],
  ])("recusa JSON com %s", async (_label, json) => {
    const source = await preparedFromBytes(json);
    expect(() => prepareOperationReconciliationProjection(source)).toThrow(
      OperationReconciliationProjectionInputError,
    );
  });

  it("mantém todo schema válido abaixo do teto e congela a fronteira 4096/4097", async () => {
    const source = await prepareRenaveMutation(
      "request-stock-entry",
      request(),
    );
    expect(
      prepareOperationReconciliationProjection(source).byteLength,
    ).toBeLessThan(4_096);
    expect(isOperationReconciliationProjectionByteLengthAllowed(4_096)).toBe(
      true,
    );
    expect(isOperationReconciliationProjectionByteLengthAllowed(4_097)).toBe(
      false,
    );
    for (const size of [4_096, 4_097]) {
      expect(() =>
        restoreOperationReconciliationProjection(
          Buffer.alloc(size, 0x20),
          SOURCE_HASH_SENTINEL,
        ),
      ).toThrow(OperationReconciliationProjectionInputError);
    }
  });

  it("restaura somente bytes exatamente canônicos e schema conhecido", () => {
    const canonical = Buffer.from(
      '{"schemaVersion":1,"cpfOperadorResponsavel":"12345678901","veiculo":{"codigoSegurancaCrv":"12345678901","placa":"QTP4H82","tipoCrv":"DIGITAL"}}',
    );
    expect(
      restoreOperationReconciliationProjection(canonical, SOURCE_HASH_SENTINEL)
        .byteLength,
    ).toBe(canonical.byteLength);

    const invalid = [
      Buffer.from(` ${canonical.toString("utf8")}`),
      Buffer.from(
        '{"cpfOperadorResponsavel":"12345678901","schemaVersion":1,"veiculo":{"codigoSegurancaCrv":"CODE","placa":"QTP4H82","tipoCrv":"DIGITAL"}}',
      ),
      Buffer.from(
        canonical.toString("utf8").replace("12345678901", "\\u00312345678901"),
      ),
      Buffer.from(
        canonical
          .toString("utf8")
          .replace('"schemaVersion":1', '"schemaVersion":2'),
      ),
      Buffer.from(
        canonical
          .toString("utf8")
          .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
      Buffer.from(
        canonical
          .toString("utf8")
          .replace('"schemaVersion":1', '"schemaVersion":1,"extra":true'),
      ),
      Buffer.from(
        canonical
          .toString("utf8")
          .replace(
            '"schemaVersion":1',
            '"schemaVersion":1,"__proto__":{"polluted":true}',
          ),
      ),
    ];
    for (const bytes of invalid) {
      expect(() =>
        restoreOperationReconciliationProjection(bytes, SOURCE_HASH_SENTINEL),
      ).toThrow(OperationReconciliationProjectionInputError);
    }
  });

  it("recusa instâncias preparadas forjadas e fontes estruturais", async () => {
    const forgedSource = {
      operation: "request-stock-entry",
      requestSha256: SOURCE_HASH_SENTINEL,
      copyBodyBytes: () => Buffer.from(JSON.stringify(request())),
    } as unknown as PreparedRenaveMutation;
    expect(() =>
      prepareOperationReconciliationProjection(forgedSource),
    ).toThrow(OperationReconciliationProjectionInputError);

    const forgedProjection = Object.create(
      PreparedOperationReconciliationProjection.prototype,
    ) as PreparedOperationReconciliationProjection;
    expect(() => forgedProjection.copyBodyBytes()).toThrow(
      OperationReconciliationProjectionInputError,
    );
    expect(() => forgedProjection.destroy()).toThrow(
      OperationReconciliationProjectionInputError,
    );

    const real = await prepareRenaveMutation("request-stock-entry", request());
    expect(() =>
      prepareOperationReconciliationProjection(
        new Proxy(real, {}) as PreparedRenaveMutation,
      ),
    ).toThrow(OperationReconciliationProjectionInputError);
  });

  it("consome ou destrói os bytes e invalida todos os getters", async () => {
    const source = await prepareRenaveMutation(
      "request-stock-entry",
      request(),
    );
    const consumed = prepareOperationReconciliationProjection(source);
    const bytes = consumed.consumeBodyBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);
    for (const access of [
      () => consumed.byteLength,
      () => consumed.projectionKind,
      () => consumed.schemaVersion,
      () => consumed.copyBodyBytes(),
      () => consumed.consumeBodyBytes(),
    ]) {
      expect(access).toThrow(OperationReconciliationProjectionInputError);
    }
    consumed.destroy();

    const destroyed = prepareOperationReconciliationProjection(source);
    destroyed.destroy();
    destroyed.destroy();
    expect(() => destroyed.copyBodyBytes()).toThrow(
      OperationReconciliationProjectionInputError,
    );
  });
});

describe("cifra da projeção de reconciliação", () => {
  it("helper nominal de leitura devolve somente DTO mínimo congelado", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = encryptOperationReconciliationProjection(
      projectionCipher,
      prepared,
      localBinding,
    );
    const originalEnvelope = cloneEnvelope(encrypted);
    const originalBinding = { ...localBinding };

    const dto = decryptOperationReconciliationProjection(
      projectionCipher,
      encrypted,
      localBinding,
    );

    expect(dto).toEqual({
      schemaVersion: 1,
      cpfOperadorResponsavel: "12345678901",
      veiculo: {
        codigoSegurancaCrv: "12345678901",
        placa: "QTP4H82",
        tipoCrv: "DIGITAL",
        renavam: "10987654321",
        numeroCrv: "123456789012",
      },
    });
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.veiculo)).toBe(true);
    expect(Object.keys(dto)).toEqual([
      "schemaVersion",
      "cpfOperadorResponsavel",
      "veiculo",
    ]);
    expect(encrypted).toEqual(originalEnvelope);
    expect(localBinding).toEqual(originalBinding);
  });

  it("helper nominal de leitura recusa fake, prototype, Proxy e subclass", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = encryptOperationReconciliationProjection(
      projectionCipher,
      prepared,
      localBinding,
    );
    let virtualDispatchCalled = false;
    const fake = {
      decrypt() {
        virtualDispatchCalled = true;
        return {};
      },
    } as unknown as OperationReconciliationProjectionCipher;
    const prototypeOnly = Object.create(
      OperationReconciliationProjectionCipher.prototype,
    ) as OperationReconciliationProjectionCipher;
    const proxied = new Proxy(projectionCipher, {});
    class Subclass extends OperationReconciliationProjectionCipher {}
    const subclassPrototypeOnly = Object.create(
      Subclass.prototype,
    ) as OperationReconciliationProjectionCipher;

    for (const candidate of [
      fake,
      prototypeOnly,
      proxied,
      subclassPrototypeOnly,
    ]) {
      expect(() =>
        decryptOperationReconciliationProjection(
          candidate,
          encrypted,
          localBinding,
        ),
      ).toThrow(OperationReconciliationProjectionConfigurationError);
    }
    expect(virtualDispatchCalled).toBe(false);
  });

  it("helper nominal de leitura sanitiza falha e não altera o envelope", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const tampered = cloneEnvelope(
      encryptOperationReconciliationProjection(
        projectionCipher,
        prepared,
        localBinding,
      ),
    );
    tampered.authTag[0] = tampered.authTag[0]! ^ 1;
    const original = cloneEnvelope(tampered);
    let error: unknown;
    try {
      decryptOperationReconciliationProjection(
        projectionCipher,
        tampered,
        localBinding,
      );
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(
      OperationReconciliationProjectionDecryptionError,
    );
    expect(tampered).toEqual(original);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
      /12345678901|QTP4H82|11111111|22222222|33333333|projection-key/iu,
    );
  });

  it("helper nominal cifra sem despachar para o método público", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = encryptOperationReconciliationProjection(
      projectionCipher,
      prepared,
      localBinding,
    );
    expect(
      projectionCipher.decrypt(encrypted, localBinding).copyBodyBytes(),
    ).toEqual(prepared.copyBodyBytes());
  });

  it("helper nominal recusa fake, prototype, Proxy e subclass forjada", async () => {
    const { prepared, localBinding } = await preparedProjection();
    let virtualDispatchCalled = false;
    const fake = {
      encrypt() {
        virtualDispatchCalled = true;
        return {};
      },
    } as unknown as OperationReconciliationProjectionCipher;
    const prototypeOnly = Object.create(
      OperationReconciliationProjectionCipher.prototype,
    ) as OperationReconciliationProjectionCipher;
    const proxied = new Proxy(cipher(), {});
    class Subclass extends OperationReconciliationProjectionCipher {}
    const subclassPrototypeOnly = Object.create(
      Subclass.prototype,
    ) as OperationReconciliationProjectionCipher;

    for (const candidate of [
      fake,
      prototypeOnly,
      proxied,
      subclassPrototypeOnly,
    ]) {
      expect(() =>
        encryptOperationReconciliationProjection(
          candidate,
          prepared,
          localBinding,
        ),
      ).toThrow(OperationReconciliationProjectionConfigurationError);
    }
    expect(virtualDispatchCalled).toBe(false);
  });

  it("cifra e autentica sem expor hash do plaintext", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = projectionCipher.encrypt(prepared, localBinding);
    const restored = projectionCipher.decrypt(encrypted, localBinding);

    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext).toHaveLength(prepared.byteLength);
    expect(Object.keys(encrypted)).not.toContain("projectionSha256");
    expect(Buffer.from(restored.copyBodyBytes())).toEqual(
      Buffer.from(prepared.copyBodyBytes()),
    );
  });

  it("usa nonce novo para o mesmo plaintext", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const first = projectionCipher.encrypt(prepared, localBinding);
    const second = projectionCipher.encrypt(prepared, localBinding);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("recusa mistura de componentes de dois envelopes válidos", async () => {
    const firstSource = await prepareRenaveMutation(
      "request-stock-entry",
      request(),
    );
    const secondSource = await prepareRenaveMutation(
      "request-stock-entry",
      request({
        veiculo: { ...request().veiculo, placa: "ABC1D23" },
      }),
    );
    const firstBinding = {
      ...binding,
      sourceRequestSha256: firstSource.requestSha256,
    };
    const secondBinding = {
      ...binding,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceRequestSha256: secondSource.requestSha256,
    };
    const projectionCipher = cipher();
    const first = projectionCipher.encrypt(
      prepareOperationReconciliationProjection(firstSource),
      firstBinding,
    );
    const second = projectionCipher.encrypt(
      prepareOperationReconciliationProjection(secondSource),
      secondBinding,
    );
    for (const mixed of [
      { ...cloneEnvelope(first), nonce: Buffer.from(second.nonce) },
      { ...cloneEnvelope(first), authTag: Buffer.from(second.authTag) },
      { ...cloneEnvelope(first), ciphertext: Buffer.from(second.ciphertext) },
    ]) {
      expect(() => projectionCipher.decrypt(mixed, firstBinding)).toThrow(
        OperationReconciliationProjectionDecryptionError,
      );
    }
    expect(() => projectionCipher.decrypt(first, secondBinding)).toThrow(
      OperationReconciliationProjectionDecryptionError,
    );
  });

  it.each(["nonce", "authTag", "ciphertext"] as const)(
    "recusa %s adulterado",
    async (field) => {
      const { prepared, localBinding } = await preparedProjection();
      const projectionCipher = cipher();
      const tampered = cloneEnvelope(
        projectionCipher.encrypt(prepared, localBinding),
      );
      tampered[field][0] = tampered[field][0]! ^ 1;
      expect(() => projectionCipher.decrypt(tampered, localBinding)).toThrow(
        OperationReconciliationProjectionDecryptionError,
      );
    },
  );

  it.each([
    ["keyId", { keyId: "unknown" }],
    ["kind", { projectionKind: "UNKNOWN" }],
    ["schema", { projectionSchemaVersion: 2 }],
    ["generation", { generation: 2 }],
    ["size", { projectionByteLength: 1 }],
    ["nonce size", { nonce: Buffer.alloc(11) }],
    ["tag size", { authTag: Buffer.alloc(15) }],
  ])("recusa metadado de envelope adulterado: %s", async (_label, change) => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const tampered = {
      ...cloneEnvelope(projectionCipher.encrypt(prepared, localBinding)),
      ...change,
    } as unknown as EncryptedOperationReconciliationProjection;
    expect(() => projectionCipher.decrypt(tampered, localBinding)).toThrow(
      OperationReconciliationProjectionDecryptionError,
    );
  });

  it.each([
    ["environment", { environment: "production" }],
    ["tenant", { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["operation", { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    [
      "establishment",
      { establishmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ],
    ["generation", { generation: 2 }],
    ["request schema", { requestSchemaVersion: 2 }],
    ["request hash", { sourceRequestSha256: "b".repeat(64) }],
  ])("autentica AAD: %s", async (_label, change) => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = projectionCipher.encrypt(prepared, localBinding);
    expect(() =>
      projectionCipher.decrypt(encrypted, {
        ...localBinding,
        ...change,
      } as OperationReconciliationProjectionBinding),
    ).toThrow(OperationReconciliationProjectionDecryptionError);
  });

  it("recusa kind/family fora do contrato fechado", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher();
    const encrypted = projectionCipher.encrypt(prepared, localBinding);
    for (const changed of [
      { ...localBinding, kind: "UNKNOWN" },
      { ...localBinding, mutationFamily: "UNKNOWN" },
    ]) {
      expect(() =>
        projectionCipher.decrypt(
          encrypted,
          changed as OperationReconciliationProjectionBinding,
        ),
      ).toThrow(OperationReconciliationProjectionDecryptionError);
    }
  });

  it("mantém leitura de chave antiga e cifra nova durante rotação", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const oldMaster = Buffer.alloc(32, 4);
    const newMaster = Buffer.alloc(32, 5);
    const oldCipher = cipher("old", new Map([["old", oldMaster]]));
    const oldEnvelope = oldCipher.encrypt(prepared, localBinding);
    const rotating = cipher(
      "new",
      new Map([
        ["old", oldMaster],
        ["new", newMaster],
      ]),
    );
    expect(rotating.decrypt(oldEnvelope, localBinding).byteLength).toBe(
      prepared.byteLength,
    );
    expect(rotating.encrypt(prepared, localBinding).keyId).toBe("new");
    expect(() =>
      cipher("new", new Map([["new", newMaster]])).decrypt(
        oldEnvelope,
        localBinding,
      ),
    ).toThrow(OperationReconciliationProjectionDecryptionError);
  });

  it("recusa o mesmo keyId configurado com material diferente", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const encrypted = cipher(
      "stable-id",
      new Map([["stable-id", Buffer.alloc(32, 4)]]),
    ).encrypt(prepared, localBinding);
    expect(() =>
      cipher(
        "stable-id",
        new Map([["stable-id", Buffer.alloc(32, 5)]]),
      ).decrypt(encrypted, localBinding),
    ).toThrow(OperationReconciliationProjectionDecryptionError);
  });

  it("separa criptograficamente request e projection com o mesmo master", async () => {
    const { prepared, source, localBinding } = await preparedProjection();
    const projectionEnvelope = cipher().encrypt(prepared, localBinding);
    const requestCipher = new OperationRequestCipher({
      activeKeyId: projectionEnvelope.keyId,
      environment: "homologation",
      keys: new Map([[projectionEnvelope.keyId, MASTER]]),
    });
    const crossPurpose: EncryptedOperationRequest = {
      authTag: Buffer.from(projectionEnvelope.authTag),
      ciphertext: Buffer.from(projectionEnvelope.ciphertext),
      keyId: projectionEnvelope.keyId,
      nonce: Buffer.from(projectionEnvelope.nonce),
      operation: "request-stock-entry",
      requestByteLength: projectionEnvelope.projectionByteLength,
      requestSha256: source.requestSha256,
    };
    await expect(
      requestCipher.decrypt(crossPurpose, requestBinding),
    ).rejects.toBeInstanceOf(OperationRequestDecryptionError);
  });

  it("copia masters e envelopes defensivamente", async () => {
    const master = Buffer.from(MASTER);
    const projectionCipher = cipher("key", new Map([["key", master]]));
    master.fill(0);
    const { prepared, localBinding } = await preparedProjection();
    const envelope = projectionCipher.encrypt(prepared, localBinding);
    const saved = cloneEnvelope(envelope);
    const original = cloneEnvelope(envelope);
    projectionCipher.decrypt(envelope, localBinding);
    expect(envelope).toEqual(original);
    envelope.nonce.fill(0);
    envelope.authTag.fill(0);
    envelope.ciphertext.fill(0);
    expect(projectionCipher.decrypt(saved, localBinding).byteLength).toBe(
      prepared.byteLength,
    );
  });

  it("captura config, binding e envelope uma única vez", async () => {
    const counts = new Map<string, number>();
    const once = <T>(name: string, value: T) => ({
      enumerable: true,
      get() {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return value;
      },
    });
    const config = Object.defineProperties(
      {},
      {
        activeKeyId: once("config.activeKeyId", "key"),
        environment: once("config.environment", "homologation"),
        masterKeys: once("config.masterKeys", new Map([["key", MASTER]])),
      },
    ) as {
      activeKeyId: string;
      environment: "homologation";
      masterKeys: ReadonlyMap<string, Uint8Array>;
    };
    const projectionCipher = new OperationReconciliationProjectionCipher(
      config,
    );
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    const { prepared, localBinding } = await preparedProjection();
    const encrypted = projectionCipher.encrypt(prepared, localBinding);
    counts.clear();
    const guardedBinding = Object.defineProperties(
      {},
      {
        environment: once("binding.environment", localBinding.environment),
        establishmentId: once(
          "binding.establishmentId",
          localBinding.establishmentId,
        ),
        generation: once("binding.generation", localBinding.generation),
        kind: once("binding.kind", localBinding.kind),
        mutationFamily: once(
          "binding.mutationFamily",
          localBinding.mutationFamily,
        ),
        operationId: once("binding.operationId", localBinding.operationId),
        requestSchemaVersion: once(
          "binding.requestSchemaVersion",
          localBinding.requestSchemaVersion,
        ),
        sourceRequestSha256: once(
          "binding.sourceRequestSha256",
          localBinding.sourceRequestSha256,
        ),
        tenantId: once("binding.tenantId", localBinding.tenantId),
      },
    ) as OperationReconciliationProjectionBinding;
    const guardedEnvelope = Object.defineProperties(
      {},
      {
        authTag: once("envelope.authTag", encrypted.authTag),
        ciphertext: once("envelope.ciphertext", encrypted.ciphertext),
        generation: once("envelope.generation", encrypted.generation),
        keyId: once("envelope.keyId", encrypted.keyId),
        nonce: once("envelope.nonce", encrypted.nonce),
        projectionByteLength: once(
          "envelope.projectionByteLength",
          encrypted.projectionByteLength,
        ),
        projectionKind: once(
          "envelope.projectionKind",
          encrypted.projectionKind,
        ),
        projectionSchemaVersion: once(
          "envelope.projectionSchemaVersion",
          encrypted.projectionSchemaVersion,
        ),
      },
    ) as EncryptedOperationReconciliationProjection;
    projectionCipher.decrypt(guardedEnvelope, guardedBinding);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
  });

  it("recusa subclass, instância forjada, master duplicado e uso após destroy", async () => {
    class Subclass extends OperationReconciliationProjectionCipher {}
    expect(
      () =>
        new Subclass({
          activeKeyId: "key",
          environment: "homologation",
          masterKeys: new Map([["key", MASTER]]),
        }),
    ).toThrow(OperationReconciliationProjectionConfigurationError);
    const forged = Object.create(
      OperationReconciliationProjectionCipher.prototype,
    ) as OperationReconciliationProjectionCipher;
    const { prepared, localBinding } = await preparedProjection();
    expect(() => forged.encrypt(prepared, localBinding)).toThrow(
      OperationReconciliationProjectionConfigurationError,
    );
    expect(() => forged.destroy()).toThrow(
      OperationReconciliationProjectionConfigurationError,
    );
    expect(() =>
      cipher(
        "a",
        new Map([
          ["a", MASTER],
          ["b", Buffer.from(MASTER)],
        ]),
      ),
    ).toThrow(OperationReconciliationProjectionConfigurationError);

    const destroyed = cipher();
    destroyed.destroy();
    expect(() => destroyed.encrypt(prepared, localBinding)).toThrow(
      OperationReconciliationProjectionConfigurationError,
    );
    expect(() => destroyed.decrypt({} as never, localBinding)).toThrow(
      OperationReconciliationProjectionConfigurationError,
    );
  });

  it("não inclui CPF, placa, IDs, key id ou master em erros", async () => {
    const { prepared, localBinding } = await preparedProjection();
    const projectionCipher = cipher(
      "secret-key-id",
      new Map([["secret-key-id", MASTER]]),
    );
    const tampered = cloneEnvelope(
      projectionCipher.encrypt(prepared, localBinding),
    );
    tampered.authTag[0] = tampered.authTag[0]! ^ 1;
    let error: unknown;
    try {
      projectionCipher.decrypt(tampered, localBinding);
    } catch (candidate) {
      error = candidate;
    }
    const serialized = `${String(error)} ${JSON.stringify(error)}`;
    expect(serialized).not.toMatch(
      /12345678901|QTP4H82|secret-key-id|11111111|22222222|33333333|47474747/u,
    );
  });
});
