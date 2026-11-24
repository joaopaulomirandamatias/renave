import type { IdentityService } from "@seu-renave/identity";
import type { TenantClient } from "@seu-renave/db";
import {
  hasOperationReconciliationProjectionKey,
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  type DecryptedRenavePrincipal,
  type ProtectedRenavePrincipal,
  type RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import { prepareRenaveMutation } from "@seu-renave/renave-connector";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { TenantActionRunner } from "../auth/request-access-guard.js";
import { loadConfig } from "../config.js";
import {
  parseStockEntryBusinessInput,
  PostgresHeldStockEntryOperation,
  stockEntryBusinessTime,
  StockEntryOperationError,
  type Clock,
  type StockEntryBusinessInput,
  type StockEntryMutationRateLimiter,
  type StockEntryOperationUseCase,
} from "./stock-entry-operations.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://app.test";
const SUBJECT = "oidc|operator-1";
const clock: Clock = {
  now: () => new Date("2026-11-24T18:00:00.000Z"),
};
const businessTime = stockEntryBusinessTime(clock.now());
const apps: ReturnType<typeof buildApp>[] = [];

const validBody: StockEntryBusinessInput = {
  dataCompra: "2026-11-24",
  emailVendedor: "vendedor@example.test",
  valorCompra: 125_000.5,
  veiculo: {
    codigoSegurancaCrv: "12345678901",
    dataHoraMedicaoHodometro: "2026-11-24T12:00:00-03:00",
    documentoProprietarioAtual: "12345678901",
    numeroCrv: "123456789012",
    placa: "QTP4H82",
    quilometragemHodometro: 42_000,
    renavam: "10987654321",
    tipoCrv: "DIGITAL",
    tipoDocumentoProprietarioAtual: "CPF",
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    authenticated?: boolean;
    authorizeError?: Error;
    businessTimeZone?: string;
    clock?: Clock;
    executeError?: Error;
    limiter?: StockEntryMutationRateLimiter;
    mfaVerified?: boolean;
    operationConfigured?: boolean;
    replayed?: boolean;
  } = {},
) {
  const getSession = vi.fn(async () =>
    options.authenticated === false
      ? undefined
      : {
          expiresAt: Date.now() + 60_000,
          mfaVerified: options.mfaVerified ?? true,
          roles: ["untrusted-idp-role"],
          subject: SUBJECT,
        },
  );
  const identity = {
    buildEndSessionUrl: vi.fn(),
    completeLogin: vi.fn(),
    config: { publicOrigin: ORIGIN },
    getSession,
    logout: vi.fn(),
    startLogin: vi.fn(),
  } as unknown as IdentityService;
  const authorize = vi.fn<StockEntryOperationUseCase["authorize"]>(async () => {
    if (options.authorizeError) throw options.authorizeError;
  });
  const execute = vi.fn<StockEntryOperationUseCase["execute"]>(async () => {
    if (options.executeError) throw options.executeError;
    return {
      createdAt: new Date("2026-11-24T18:01:02.003Z"),
      operationId: OPERATION_ID,
      replayed: options.replayed ?? false,
      status: "HELD_LOCAL",
    };
  });
  const destroy = vi.fn();
  const acquire = vi.fn<StockEntryMutationRateLimiter["acquire"]>(async () => ({
    allowed: true,
  }));
  const app = buildApp({
    config: loadConfig(),
    identity,
    logger: false,
    stockEntryClock: options.clock ?? clock,
    ...(options.businessTimeZone
      ? { stockEntryBusinessTimeZone: options.businessTimeZone }
      : {}),
    ...(options.operationConfigured === false
      ? {}
      : {
          stockEntryMutationRateLimiter: options.limiter ?? { acquire },
          stockEntryOperation: { authorize, destroy, execute },
        }),
  });
  apps.push(app);
  return { acquire, app, authorize, destroy, execute, getSession };
}

async function request(
  app: ReturnType<typeof buildApp>,
  body: object = validBody,
  headers: Record<string, string> = {},
) {
  return await app.inject({
    headers: {
      cookie: "renave_session=opaque-session",
      "idempotency-key": IDEMPOTENCY_KEY,
      origin: ORIGIN,
      ...headers,
    },
    method: "POST",
    payload: body,
    url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/stock-entry-operations`,
  });
}

describe("parseStockEntryBusinessInput", () => {
  it("aceita apenas o contrato comercial estrito", () => {
    expect(parseStockEntryBusinessInput(validBody, businessTime)).toEqual(
      validBody,
    );
    for (const forbidden of [
      "cpfOperadorResponsavel",
      "emailEstabelecimento",
      "subject",
    ]) {
      expect(
        parseStockEntryBusinessInput(
          { ...validBody, [forbidden]: "segredo@example.test" },
          businessTime,
        ),
      ).toBeUndefined();
    }
  });

  it("recusa valor inválido e datas futuras ou sem offset", () => {
    expect(
      parseStockEntryBusinessInput(
        { ...validBody, valorCompra: 0 },
        businessTime,
      ),
    ).toBeUndefined();
    expect(
      parseStockEntryBusinessInput(
        { ...validBody, dataCompra: "2026-11-25" },
        businessTime,
      ),
    ).toBeUndefined();
    expect(
      parseStockEntryBusinessInput(
        {
          ...validBody,
          veiculo: {
            ...validBody.veiculo,
            dataHoraMedicaoHodometro: "2026-11-24T12:00:00",
          },
        },
        businessTime,
      ),
    ).toBeUndefined();
    expect(
      parseStockEntryBusinessInput(
        {
          ...validBody,
          veiculo: {
            ...validBody.veiculo,
            dataHoraMedicaoHodometro: "2026-11-24T19:00:00Z",
          },
        },
        businessTime,
      ),
    ).toBeUndefined();
  });

  it("deriva a data civil da mesma captura de tempo na zona configurada", async () => {
    const instant = new Date("2026-11-25T01:30:00.000Z");
    expect(stockEntryBusinessTime(instant, "America/Sao_Paulo")).toEqual({
      businessDate: "2026-11-24",
      now: instant,
    });
    expect(stockEntryBusinessTime(instant, "UTC")).toEqual({
      businessDate: "2026-11-25",
      now: instant,
    });

    const now = vi.fn(() => instant);
    const saoPaulo = setup({
      businessTimeZone: "America/Sao_Paulo",
      clock: { now },
    });
    const rejected = await request(saoPaulo.app, {
      ...validBody,
      dataCompra: "2026-11-25",
    });
    expect(rejected.statusCode).toBe(400);
    expect(now).toHaveBeenCalledOnce();

    const utc = setup({
      businessTimeZone: "UTC",
      clock: { now: () => instant },
    });
    const accepted = await request(utc.app, {
      ...validBody,
      dataCompra: "2026-11-25",
    });
    expect(accepted.statusCode).toBe(202);
  });
});

describe("POST entrada usada retida localmente", () => {
  it("cria em 202 e usa somente o subject autenticado", async () => {
    const { app, authorize, execute } = setup();
    const response = await request(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      createdAt: "2026-11-24T18:01:02.003Z",
      operationId: OPERATION_ID,
      replayed: false,
      status: "HELD_LOCAL",
    });
    expect(response.headers.location).toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        establishmentId: ESTABLISHMENT_ID,
        session: expect.objectContaining({ subject: SUBJECT }),
        tenantId: TENANT_ID,
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        business: validBody,
        idempotencyKey: IDEMPOTENCY_KEY,
        session: expect.objectContaining({ subject: SUBJECT }),
      }),
    );
    expect(response.body).not.toMatch(
      /cpfOperador|emailEstabelecimento|subject/iu,
    );
  });

  it("devolve 200 sanitizado ao repetir a chave", async () => {
    const { app } = setup({ replayed: true });
    const response = await request(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers["idempotency-replayed"]).toBe("true");
    expect(response.json()).toMatchObject({
      replayed: true,
      status: "HELD_LOCAL",
    });
  });

  it("exige sessão com MFA antes da autorização", async () => {
    const missing = setup({ authenticated: false });
    const missingResponse = await request(missing.app);
    expect(missingResponse.statusCode).toBe(401);
    expect(missing.execute).not.toHaveBeenCalled();

    const withoutMfa = setup({ mfaVerified: false });
    const mfaResponse = await request(withoutMfa.app);
    expect(mfaResponse.statusCode).toBe(403);
    expect(mfaResponse.json()).toEqual({ code: "MFA_REQUIRED" });
    expect(withoutMfa.authorize).not.toHaveBeenCalled();
  });

  it("exige Origin e Idempotency-Key UUID", async () => {
    const origin = setup();
    const originResponse = await request(origin.app, validBody, {
      origin: "https://evil.example",
    });
    expect(originResponse.statusCode).toBe(403);
    expect(origin.execute).not.toHaveBeenCalled();

    const idempotency = setup();
    const keyResponse = await request(idempotency.app, validBody, {
      "idempotency-key": "not-a-uuid",
    });
    expect(keyResponse.statusCode).toBe(400);
    expect(keyResponse.json()).toEqual({ code: "INVALID_IDEMPOTENCY_KEY" });
    expect(idempotency.execute).not.toHaveBeenCalled();
  });

  it("recusa campos extras e principais fornecidos pelo cliente", async () => {
    for (const body of [
      { ...validBody, cpfOperadorResponsavel: "12345678901" },
      { ...validBody, emailEstabelecimento: "loja@example.test" },
      {
        ...validBody,
        veiculo: { ...validBody.veiculo, extra: "injetado" },
      },
    ]) {
      const { app, execute } = setup();
      const response = await request(app, body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_STOCK_ENTRY_INPUT" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("falha fechada sem composição ou limitador", async () => {
    const missing = setup({ operationConfigured: false });
    const missingResponse = await request(missing.app);
    expect(missingResponse.statusCode).toBe(503);
    expect(missingResponse.json()).toEqual({
      code: "STOCK_ENTRY_OPERATION_NOT_CONFIGURED",
    });

    const limiter = setup({
      limiter: {
        acquire: vi.fn(async () => {
          throw new Error("down");
        }),
      },
    });
    const limiterResponse = await request(limiter.app);
    expect(limiterResponse.statusCode).toBe(503);
    expect(limiterResponse.json()).toEqual({
      code: "STOCK_ENTRY_RATE_LIMIT_UNAVAILABLE",
    });
    expect(limiter.execute).not.toHaveBeenCalled();
  });

  it("aplica Retry-After válido e falha fechada para limite inválido", async () => {
    const limited = setup({
      limiter: {
        acquire: vi.fn(async () => ({
          allowed: false as const,
          retryAfterSeconds: 17,
        })),
      },
    });
    const limitedResponse = await request(limited.app);
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBe("17");
    expect(limitedResponse.json()).toEqual({
      code: "STOCK_ENTRY_RATE_LIMITED",
    });
    expect(limited.execute).not.toHaveBeenCalled();

    const invalid = setup({
      limiter: {
        acquire: vi.fn(async () => ({
          allowed: false as const,
          retryAfterSeconds: 0,
        })),
      },
    });
    const invalidResponse = await request(invalid.app);
    expect(invalidResponse.statusCode).toBe(503);
    expect(invalidResponse.json()).toEqual({
      code: "STOCK_ENTRY_RATE_LIMIT_UNAVAILABLE",
    });
    expect(invalid.execute).not.toHaveBeenCalled();
  });

  it("encerra o caso de uso no onClose sem assumir seus recursos emprestados", async () => {
    const { app, destroy } = setup();
    apps.splice(apps.indexOf(app), 1);
    await app.close();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("autoriza antes de consumir limite e converte RBAC em 404", async () => {
    const denied = setup({
      authorizeError: new StockEntryOperationError(
        "STOCK_ENTRY_RESOURCE_NOT_FOUND",
      ),
    });
    const response = await request(denied.app);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "STOCK_ENTRY_RESOURCE_NOT_FOUND" });
    expect(denied.acquire).not.toHaveBeenCalled();
    expect(denied.execute).not.toHaveBeenCalled();
  });

  it("normaliza conflito por nome sem expor mensagem interna", async () => {
    const conflict = new Error("placa ou ator sensível");
    conflict.name = "OperationActiveConflictError";
    const { app } = setup({ executeError: conflict });
    const response = await request(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "STOCK_ENTRY_OPERATION_CONFLICT" });
    expect(response.body).not.toContain("sensível");
  });
});

function envelope(seed: number): ProtectedRenavePrincipal {
  return {
    aadSha256: Buffer.alloc(32, seed),
    authTag: Buffer.alloc(16, seed),
    ciphertext: Buffer.alloc(24, seed),
    envelopeSchemaVersion: 1,
    hmac: { digest: Buffer.alloc(32, seed), hmacKeyId: `hmac-${seed}` },
    keyId: `enc-${seed}`,
    nonce: Buffer.alloc(12, seed),
  };
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

describe("PostgresHeldStockEntryOperation", () => {
  it("compõe a retenção numa transação, usa HMAC separado e zera segredos", async () => {
    const operatorEnvelope = envelope(1);
    const establishmentEnvelope = envelope(2);
    const copiedSecrets: Buffer[] = [];
    const destroyedSecrets: string[] = [];
    const resolverDigests: Buffer[] = [];
    const liveResolverDigests: Buffer[] = [];
    const decrypt = vi.fn(
      (_protected: ProtectedRenavePrincipal, binding: { purpose: string }) => {
        const value =
          binding.purpose === "operator-cpf"
            ? "12345678901"
            : "estabelecimento@example.test";
        return {
          copyUtf8Bytes() {
            const copy = Buffer.from(value, "utf8");
            copiedSecrets.push(copy);
            return copy;
          },
          destroy() {
            destroyedSecrets.push(binding.purpose);
          },
        } as unknown as DecryptedRenavePrincipal;
      },
    );
    const resolver = {
      resolve: vi.fn(async (_client, input) => {
        resolverDigests.push(Buffer.from(input.idempotencyKeyDigest));
        liveResolverDigests.push(input.idempotencyKeyDigest);
        return {
          establishment: {
            binding: {
              establishmentId: ESTABLISHMENT_ID,
              profileId: "66666666-6666-4666-8666-666666666666",
              purpose: "establishment-email" as const,
              tenantId: TENANT_ID,
            },
            envelope: establishmentEnvelope,
          },
          operator: {
            binding: {
              profileId: "55555555-5555-4555-8555-555555555555",
              purpose: "operator-cpf" as const,
              subject: input.subject,
              tenantId: TENANT_ID,
            },
            envelope: operatorEnvelope,
          },
        };
      }),
    };
    const runner: TenantActionRunner = {
      run: async (input, work) => ({
        allowed: true,
        value: await work({
          authorization: { allowed: true } as never,
          client: {} as TenantClient,
          session: input.session,
        }),
      }),
    };
    const storedInputs: Array<{
      actor: Buffer;
      correlationId: string;
      idempotency: Buffer;
      liveInput: { actorSubjectHash: Buffer; requestCiphertext: Buffer };
      vehicle: Buffer;
    }> = [];
    let conflictNext = false;
    const createOperation = vi.fn(async (_client, input) => {
      if (conflictNext) {
        const conflict = new Error("internal conflict detail");
        conflict.name = "OperationIdempotencyConflictError";
        throw conflict;
      }
      storedInputs.push({
        actor: Buffer.from(input.actorSubjectHash),
        correlationId: input.correlationId,
        idempotency: Buffer.from(input.idempotencyKeyDigest),
        liveInput: input,
        vehicle: Buffer.from(input.vehicleKeyDigest),
      });
      return {
        operation: {
          correlationId: input.correlationId,
          createdAt: new Date("2026-11-24T18:01:02.003Z"),
          establishmentId: ESTABLISHMENT_ID,
          id: OPERATION_ID,
          kind: "USED_STOCK_ENTRY" as const,
          mutationFamily: "STOCK_ENTRY" as const,
          status: "HELD_LOCAL" as const,
          updatedAt: new Date("2026-11-24T18:01:02.003Z"),
          version: "1",
        },
        replayed: storedInputs.length > 1,
      };
    });
    const borrowedPrincipalCryptoDestroy = vi.fn();
    const principalCrypto = {
      decrypt,
      destroy: borrowedPrincipalCryptoDestroy,
    } as unknown as RenavePrincipalCrypto;
    const projectionCipher = new OperationReconciliationProjectionCipher({
      activeKeyId: "projection-2026-11",
      environment: "homologation",
      masterKeys: new Map([["projection-2026-11", Buffer.alloc(32, 31)]]),
    });
    const requestCipher = new OperationRequestCipher({
      activeKeyId: "request-2026-11",
      environment: "homologation",
      keys: new Map([["request-2026-11", Buffer.alloc(32, 32)]]),
    });
    const useCase = new PostgresHeldStockEntryOperation({
      createOperation,
      digestKeys: {
        actor: Buffer.alloc(32, 21),
        idempotency: Buffer.alloc(32, 22),
        vehicle: Buffer.alloc(32, 23),
      },
      environment: "homologation",
      principalCrypto,
      projectionCipher,
      requestCipher,
      resolver,
      runner,
    });
    const session = {
      expiresAt: Date.now() + 60_000,
      mfaVerified: true,
      roles: [],
      subject: SUBJECT,
    };
    const input = {
      business: validBody,
      establishmentId: ESTABLISHMENT_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      session,
      tenantId: TENANT_ID,
      traceId: "request-17-is-not-a-uuid",
    };

    const [created, replayed] = await Promise.all([
      useCase.execute(input),
      useCase.execute(input),
    ]);

    expect([created.replayed, replayed.replayed].sort()).toEqual([false, true]);
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenCalledWith(expect.anything(), {
      establishmentId: ESTABLISHMENT_ID,
      idempotencyKeyDigest: expect.any(Buffer),
      subject: SUBJECT,
    });
    expect(storedInputs).toHaveLength(2);
    expect(storedInputs[0]!.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(storedInputs[0]!.correlationId).not.toBe(input.traceId);
    expect(storedInputs[0]!.actor).toEqual(storedInputs[1]!.actor);
    expect(storedInputs[0]!.idempotency).toEqual(storedInputs[1]!.idempotency);
    expect(resolverDigests).toEqual(
      storedInputs.map(({ idempotency }) => idempotency),
    );
    expect(liveResolverDigests.every(allZero)).toBe(true);
    expect(storedInputs[0]!.vehicle).toEqual(storedInputs[1]!.vehicle);
    expect(storedInputs[0]!.actor).not.toEqual(storedInputs[0]!.idempotency);
    expect(storedInputs[0]!.vehicle).not.toEqual(storedInputs[0]!.idempotency);
    expect(
      storedInputs.every(
        ({ liveInput }) =>
          allZero(liveInput.actorSubjectHash) &&
          allZero(liveInput.requestCiphertext),
      ),
    ).toBe(true);
    expect(copiedSecrets.every(allZero)).toBe(true);
    expect(destroyedSecrets).toHaveLength(4);
    for (const protectedValue of [operatorEnvelope, establishmentEnvelope]) {
      expect(allZero(protectedValue.aadSha256)).toBe(true);
      expect(allZero(protectedValue.authTag)).toBe(true);
      expect(allZero(protectedValue.ciphertext)).toBe(true);
      expect(allZero(protectedValue.hmac.digest)).toBe(true);
      expect(allZero(protectedValue.nonce)).toBe(true);
    }

    conflictNext = true;
    await expect(useCase.execute(input)).rejects.toMatchObject({
      code: "STOCK_ENTRY_OPERATION_CONFLICT",
      message: "A operação local de entrada de estoque não pôde ser criada.",
    });

    useCase.destroy();
    const internal = useCase as unknown as {
      digestKeys: { actor: Buffer; idempotency: Buffer; vehicle: Buffer };
    };
    expect(Object.values(internal.digestKeys).every(allZero)).toBe(true);
    expect(borrowedPrincipalCryptoDestroy).not.toHaveBeenCalled();
    expect(
      hasOperationReconciliationProjectionKey(
        projectionCipher,
        "projection-2026-11",
      ),
    ).toBe(true);
    const borrowedPrepared = await prepareRenaveMutation(
      "request-stock-entry",
      {
        ...validBody,
        cpfOperadorResponsavel: "12345678901",
        emailEstabelecimento: "estabelecimento@example.test",
      },
    );
    const borrowedEnvelope = requestCipher.encrypt(borrowedPrepared, {
      actorSubjectHash: Buffer.alloc(32, 61),
      correlationId: "77777777-7777-4777-8777-777777777777",
      environment: "homologation",
      establishmentId: ESTABLISHMENT_ID,
      idempotencyKeyDigest: Buffer.alloc(32, 62),
      kind: "USED_STOCK_ENTRY",
      mutationFamily: "STOCK_ENTRY",
      requestSchemaVersion: 1,
      tenantId: TENANT_ID,
      vehicleKeyDigest: Buffer.alloc(32, 63),
    });
    expect(borrowedEnvelope.ciphertext.byteLength).toBeGreaterThan(0);
    borrowedPrepared.destroy();
    borrowedEnvelope.authTag.fill(0);
    borrowedEnvelope.ciphertext.fill(0);
    borrowedEnvelope.nonce.fill(0);
    requestCipher.destroy();
    projectionCipher.destroy();
    borrowedPrincipalCryptoDestroy();
    await expect(useCase.execute(input)).rejects.toMatchObject({
      code: "STOCK_ENTRY_OPERATION_UNAVAILABLE",
    });
  });

  it("falha sanitizada quando perfis ou decriptação não estão disponíveis", async () => {
    const runner: TenantActionRunner = {
      run: async (input, work) => ({
        allowed: true,
        value: await work({
          authorization: { allowed: true } as never,
          client: {} as TenantClient,
          session: input.session,
        }),
      }),
    };
    const base = {
      digestKeys: {
        actor: Buffer.alloc(32, 41),
        idempotency: Buffer.alloc(32, 42),
        vehicle: Buffer.alloc(32, 43),
      },
      environment: "homologation" as const,
      projectionCipher: new OperationReconciliationProjectionCipher({
        activeKeyId: "projection-failure",
        environment: "homologation",
        masterKeys: new Map([["projection-failure", Buffer.alloc(32, 44)]]),
      }),
      requestCipher: new OperationRequestCipher({
        activeKeyId: "request-failure",
        environment: "homologation",
        keys: new Map([["request-failure", Buffer.alloc(32, 45)]]),
      }),
      runner,
    };
    const session = {
      expiresAt: Date.now() + 60_000,
      mfaVerified: true,
      roles: [],
      subject: SUBJECT,
    };
    const input = {
      business: validBody,
      establishmentId: ESTABLISHMENT_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      session,
      tenantId: TENANT_ID,
      traceId: "trace",
    };
    const missing = new PostgresHeldStockEntryOperation({
      ...base,
      principalCrypto: {} as RenavePrincipalCrypto,
      resolver: {
        resolve: vi.fn(async () => {
          const error = new Error("missing profile");
          error.name = "RenavePrincipalResolutionUnavailableError";
          throw error;
        }),
      },
    });
    await expect(missing.execute(input)).rejects.toMatchObject({
      code: "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE",
      message: "A operação local de entrada de estoque não pôde ser criada.",
    });

    const operatorEnvelope = envelope(7);
    const establishmentEnvelope = envelope(8);
    const cryptoFailure = new PostgresHeldStockEntryOperation({
      ...base,
      digestKeys: {
        actor: Buffer.alloc(32, 51),
        idempotency: Buffer.alloc(32, 52),
        vehicle: Buffer.alloc(32, 53),
      },
      principalCrypto: {
        decrypt: vi.fn(() => {
          const error = new Error("ciphertext detail");
          error.name = "RenavePrincipalDecryptionError";
          throw error;
        }),
      } as unknown as RenavePrincipalCrypto,
      resolver: {
        resolve: vi.fn(async () => ({
          establishment: {
            binding: {
              establishmentId: ESTABLISHMENT_ID,
              profileId: "66666666-6666-4666-8666-666666666666",
              purpose: "establishment-email" as const,
              tenantId: TENANT_ID,
            },
            envelope: establishmentEnvelope,
          },
          operator: {
            binding: {
              profileId: "55555555-5555-4555-8555-555555555555",
              purpose: "operator-cpf" as const,
              subject: SUBJECT,
              tenantId: TENANT_ID,
            },
            envelope: operatorEnvelope,
          },
        })),
      },
    });
    await expect(cryptoFailure.execute(input)).rejects.toMatchObject({
      code: "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE",
    });
    expect(allZero(operatorEnvelope.ciphertext)).toBe(true);
    expect(allZero(establishmentEnvelope.ciphertext)).toBe(true);
  });
});
