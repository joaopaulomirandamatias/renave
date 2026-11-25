import { createHash, createHmac } from "node:crypto";

import type { TenantClient } from "@seu-renave/db";
import type {
  DecryptedRenavePrincipal,
  ProtectedRenavePrincipal,
  RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import { readPreparedRenaveMutation } from "@seu-renave/renave-connector";
import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";
import {
  parseStockExitBusinessInput,
  PostgresHeldStockExitOperation,
  registerStockExitOperationRoute,
  StockExitOperationError,
  type Clock,
  type StockExitBusinessInput,
  type StockExitMutationRateLimiter,
  type StockExitOperationUseCase,
} from "./stock-exit-operations.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const SUBJECT = "oidc|operator-1";
const ORIGIN = "https://app.test";
const NOW = new Date("2026-11-24T18:00:00.000Z");
const clock: Clock = { now: () => NOW };

const validBody: StockExitBusinessInput = {
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
  dataVenda: "2026-11-24",
  stockId: 71,
  valorVenda: 98_500.25,
  veiculo: {
    codigoSegurancaCrv: "12345678901",
    numeroCrv: "123456789012",
    placa: "ABC1D23",
    renavam: "10987654321",
  },
};

const apps: ReturnType<typeof fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function session() {
  return {
    expiresAt: Date.now() + 60_000,
    issuer: "https://idp.test",
    mfaVerified: true,
    roles: [],
    subject: SUBJECT,
  };
}

function setup(
  options: {
    authenticated?: boolean;
    authorizeError?: Error;
    executeError?: Error;
    limiter?: StockExitMutationRateLimiter;
    operationConfigured?: boolean;
    replayed?: boolean;
  } = {},
) {
  const authenticate = vi.fn(async (_request, reply, requirements) => {
    if (options.authenticated === false) {
      reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return { ok: false as const };
    }
    expect(requirements).toEqual({ mfa: "required", mfaMaxAgeSeconds: 300 });
    return { ok: true as const, session: session() };
  });
  const authorize = vi.fn<StockExitOperationUseCase["authorize"]>(async () => {
    if (options.authorizeError) throw options.authorizeError;
  });
  const execute = vi.fn<StockExitOperationUseCase["execute"]>(async () => {
    if (options.executeError) throw options.executeError;
    return {
      createdAt: new Date("2026-11-24T18:01:02.003Z"),
      operationId: OPERATION_ID,
      replayed: options.replayed ?? false,
      status: "HELD_LOCAL",
    };
  });
  const acquire = vi.fn<StockExitMutationRateLimiter["acquire"]>(async () => ({
    allowed: true,
  }));
  const app = fastify({ logger: false });
  registerStockExitOperationRoute(app, {
    accessGuard: { authenticate } as unknown as RequestAccessGuard,
    clock,
    mfaMaxAgeSeconds: 300,
    ...(options.operationConfigured === false
      ? {}
      : {
          mutationRateLimiter: options.limiter ?? { acquire },
          operation: { authorize, execute },
        }),
    publicOrigin: ORIGIN,
  });
  apps.push(app);
  return { acquire, app, authenticate, authorize, execute };
}

async function request(
  app: ReturnType<typeof fastify>,
  body: object = validBody,
  headers: Record<string, string> = {},
) {
  return await app.inject({
    headers: {
      "idempotency-key": IDEMPOTENCY_KEY,
      origin: ORIGIN,
      ...headers,
    },
    method: "POST",
    payload: body,
    url: `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/stock-exit-operations`,
  });
}

describe("parseStockExitBusinessInput", () => {
  it("aceita somente o contrato comercial sem identidade do operador", () => {
    expect(parseStockExitBusinessInput(validBody, "2026-11-24")).toEqual(
      validBody,
    );
    for (const protectedField of [
      "cpfOperadorResponsavel",
      "emailEstabelecimento",
      "subject",
      "operatorProfileId",
    ]) {
      expect(
        parseStockExitBusinessInput(
          { ...validBody, [protectedField]: "não permitido" },
          "2026-11-24",
        ),
      ).toBeUndefined();
    }
  });

  it("recusa data futura, centavos inválidos e contrato incompleto", () => {
    expect(
      parseStockExitBusinessInput(
        { ...validBody, dataVenda: "2026-11-25" },
        "2026-11-24",
      ),
    ).toBeUndefined();
    for (const stockId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        parseStockExitBusinessInput({ ...validBody, stockId }, "2026-11-24"),
      ).toBeUndefined();
    }
    for (const placa of ["1BC2D34", "ABCD123", "ABC-1234", "abc1d23"]) {
      expect(
        parseStockExitBusinessInput(
          { ...validBody, veiculo: { ...validBody.veiculo, placa } },
          "2026-11-24",
        ),
      ).toBeUndefined();
    }
    expect(
      parseStockExitBusinessInput(
        {
          ...validBody,
          comprador: {
            ...validBody.comprador,
            numeroDocumento: "52998224724",
          },
        },
        "2026-11-24",
      ),
    ).toBeUndefined();
    expect(
      parseStockExitBusinessInput(
        { ...validBody, valorVenda: 10.001 },
        "2026-11-24",
      ),
    ).toBeUndefined();
    expect(
      parseStockExitBusinessInput(
        { ...validBody, valorVenda: 0.000_000_000_1 },
        "2026-11-24",
      ),
    ).toBeUndefined();
    expect(
      parseStockExitBusinessInput(
        { ...validBody, valorVenda: 10_000_000.03 },
        "2026-11-24",
      )?.valorVenda,
    ).toBe(10_000_000.03);
    expect(
      parseStockExitBusinessInput(
        { ...validBody, valorVenda: 99_999_999.99 },
        "2026-11-24",
      )?.valorVenda,
    ).toBe(99_999_999.99);
    expect(
      parseStockExitBusinessInput(
        {
          ...validBody,
          comprador: {
            ...validBody.comprador,
            endereco: {
              bairro: "Centro",
              cep: "66000000",
              codigoMunicipio: 1501402,
              logradouro: "Avenida Brasil",
              numero: "100",
            },
          },
          veiculo: { ...validBody.veiculo, numeroCrv: "123" },
        },
        "2026-11-24",
      ),
    ).toBeUndefined();
  });
});

describe("registerStockExitOperationRoute", () => {
  it("cria somente HELD_LOCAL e preserva a semântica de replay", async () => {
    const first = setup();
    const response = await request(first.app);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      createdAt: "2026-11-24T18:01:02.003Z",
      operationId: OPERATION_ID,
      replayed: false,
      status: "HELD_LOCAL",
    });
    expect(first.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      first.acquire.mock.invocationCallOrder[0]!,
    );
    expect(first.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      first.execute.mock.invocationCallOrder[0]!,
    );
    expect(first.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorIp: "127.0.0.1",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        tenantId: TENANT_ID,
      }),
    );

    const replay = setup({ replayed: true });
    const replayed = await request(replay.app);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers["idempotency-replayed"]).toBe("true");
  });

  it("fecha CSRF, sessão e configuração antes de qualquer execução", async () => {
    const csrf = setup();
    const deniedOrigin = await request(csrf.app, validBody, {
      origin: "https://evil.test",
    });
    expect(deniedOrigin.statusCode).toBe(403);
    expect(csrf.authenticate).not.toHaveBeenCalled();

    const anonymous = setup({ authenticated: false });
    expect((await request(anonymous.app)).statusCode).toBe(401);
    expect(anonymous.authorize).not.toHaveBeenCalled();

    const unavailable = setup({ operationConfigured: false });
    const response = await request(unavailable.app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "STOCK_EXIT_OPERATION_NOT_CONFIGURED",
    });
  });

  it("nega BOLA antes do limitador e não revela a causa", async () => {
    const error = new StockExitOperationError("STOCK_EXIT_RESOURCE_NOT_FOUND");
    const { acquire, app, execute } = setup({ authorizeError: error });
    const response = await request(app);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "STOCK_EXIT_RESOURCE_NOT_FOUND" });
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("recusa input e idempotência inválidos antes das portas", async () => {
    const { app, authorize } = setup();
    const invalid = await request(app, {
      ...validBody,
      cpfOperadorResponsavel: "52998224725",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: "INVALID_STOCK_EXIT_INPUT" });
    const invalidStockId = await request(app, { ...validBody, stockId: 0 });
    expect(invalidStockId.statusCode).toBe(400);
    expect(invalidStockId.json()).toEqual({
      code: "INVALID_STOCK_EXIT_INPUT",
    });
    const key = await request(app, validBody, {
      "idempotency-key": "chave-livre",
    });
    expect(key.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("aplica rate limit após autorização e sanitiza falha", async () => {
    const limited = setup({
      limiter: {
        acquire: vi.fn(async () => ({
          allowed: false as const,
          retryAfterSeconds: 9,
        })),
      },
    });
    const limitedResponse = await request(limited.app);
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBe("9");
    expect(limited.execute).not.toHaveBeenCalled();

    const secret = new Error("CPF 52998224725 e CRV 123456789012");
    const failed = setup({ executeError: secret });
    const response = await request(failed.app);
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(response.body).not.toContain("52998224725");
    expect(response.body).not.toContain("123456789012");
  });

  it("distingue rejeição, limite e indisponibilidade do preflight", async () => {
    const idempotencyConflict = setup({
      executeError: new StockExitOperationError(
        "STOCK_EXIT_IDEMPOTENCY_CONFLICT",
      ),
    });
    const idempotencyResponse = await request(idempotencyConflict.app);
    expect(idempotencyResponse.statusCode).toBe(422);
    expect(idempotencyResponse.json()).toEqual({
      code: "STOCK_EXIT_IDEMPOTENCY_CONFLICT",
    });

    const activeConflict = setup({
      executeError: new StockExitOperationError(
        "STOCK_EXIT_OPERATION_CONFLICT",
      ),
    });
    const activeResponse = await request(activeConflict.app);
    expect(activeResponse.statusCode).toBe(409);
    expect(activeResponse.json()).toEqual({
      code: "STOCK_EXIT_OPERATION_CONFLICT",
    });

    const rejected = setup({
      executeError: new StockExitOperationError(
        "STOCK_EXIT_PREFLIGHT_REJECTED",
      ),
    });
    const rejectedResponse = await request(rejected.app);
    expect(rejectedResponse.statusCode).toBe(409);
    expect(rejectedResponse.json()).toEqual({
      code: "STOCK_EXIT_PREFLIGHT_REJECTED",
    });

    const limited = setup({
      executeError: new StockExitOperationError(
        "STOCK_EXIT_PREFLIGHT_LIMITED",
        13,
      ),
    });
    const limitedResponse = await request(limited.app);
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBe("13");
    expect(limitedResponse.json()).toEqual({
      code: "STOCK_EXIT_PREFLIGHT_LIMITED",
    });

    const unavailable = setup({
      executeError: new StockExitOperationError(
        "STOCK_EXIT_PREFLIGHT_UNAVAILABLE",
      ),
    });
    const unavailableResponse = await request(unavailable.app);
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({
      code: "STOCK_EXIT_PREFLIGHT_UNAVAILABLE",
    });
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

describe("PostgresHeldStockExitOperation", () => {
  it("deriva identidade no servidor, cifra via builder e nunca despacha", async () => {
    const operatorEnvelope = envelope(1);
    const establishmentEnvelope = envelope(2);
    const secrets: Buffer[] = [];
    const decrypt = vi.fn(
      (_protected: ProtectedRenavePrincipal, binding: { purpose: string }) => {
        const value =
          binding.purpose === "operator-cpf"
            ? "52998224725"
            : "estabelecimento@example.test";
        return {
          copyUtf8Bytes: () => {
            const copy = Buffer.from(value);
            secrets.push(copy);
            return copy;
          },
          destroy: vi.fn(),
        } as unknown as DecryptedRenavePrincipal;
      },
    );
    const resolver = {
      resolve: vi.fn(async (_client, input) => ({
        establishment: {
          binding: {
            establishmentId: ESTABLISHMENT_ID,
            profileId: "66666666-6666-4666-8666-666666666666",
            profileVersion: "11",
            purpose: "establishment-email" as const,
            tenantId: TENANT_ID,
          },
          envelope: establishmentEnvelope,
        },
        operator: {
          binding: {
            profileId: "55555555-5555-4555-8555-555555555555",
            profileVersion: "7",
            purpose: "operator-cpf" as const,
            subject: input.subject,
            tenantId: TENANT_ID,
          },
          envelope: operatorEnvelope,
        },
      })),
    };
    const runnerInputs: unknown[] = [];
    const executionOrder: string[] = [];
    const runner: TenantActionRunner = {
      async run(input, work) {
        executionOrder.push("runner");
        runnerInputs.push(input);
        return {
          allowed: true,
          value: await work({
            authorization: { allowed: true } as never,
            client: {} as TenantClient,
            session: input.session,
          }),
        };
      },
    };
    let protectedRequest: Record<string, unknown> | undefined;
    let persistedIdempotencyDigest: Buffer | undefined;
    const buildOperation = vi.fn((_requestCipher, _projectionCipher, input) => {
      const trusted = readPreparedRenaveMutation(input.prepared);
      protectedRequest = JSON.parse(
        new TextDecoder().decode(trusted.body),
      ) as Record<string, unknown>;
      trusted.body.fill(0);
      input.prepared.destroy();
      return {
        actorSubjectHash: Buffer.from(input.actorSubjectHash),
        correlationId: input.correlationId,
        establishmentId: input.establishmentId,
        establishmentProfileId: input.establishmentProfileId,
        establishmentProfileVersion: input.establishmentProfileVersion,
        idempotencyKeyDigest: Buffer.from(input.idempotencyKeyDigest),
        kind: "USED_STOCK_EXIT" as const,
        mutationFamily: "STOCK_EXIT" as const,
        operationId: OPERATION_ID,
        operatorProfileId: input.operatorProfileId,
        operatorProfileVersion: input.operatorProfileVersion,
        reconciliationProjectionAuthTag: Buffer.alloc(16, 1),
        reconciliationProjectionByteLength: 16,
        reconciliationProjectionCiphertext: Buffer.alloc(16, 1),
        reconciliationProjectionGeneration: 1,
        reconciliationProjectionKeyId: "projection-v1",
        reconciliationProjectionKind: "STOCK_EXIT_RECONCILIATION" as const,
        reconciliationProjectionNonce: Buffer.alloc(12, 1),
        reconciliationProjectionSchemaVersion: 1 as const,
        requestAuthTag: Buffer.alloc(16, 1),
        requestCiphertext: Buffer.alloc(32, 1),
        requestKeyId: "request-v1",
        requestNonce: Buffer.alloc(12, 1),
        requestSchemaVersion: 1,
        requestSha256: Buffer.alloc(32, 1),
        subject: input.subject,
        vehicleKeyDigest: Buffer.from(input.vehicleKeyDigest),
      };
    });
    const createOperation = vi.fn(async (_client, input) => {
      executionOrder.push("persist");
      persistedIdempotencyDigest = Buffer.from(input.idempotencyKeyDigest);
      return {
        operation: {
          correlationId: input.correlationId,
          createdAt: new Date("2026-11-24T18:01:02.003Z"),
          establishmentId: input.establishmentId,
          id: input.operationId,
          kind: "USED_STOCK_EXIT" as const,
          mutationFamily: "STOCK_EXIT" as const,
          status: "HELD_LOCAL" as const,
          updatedAt: new Date("2026-11-24T18:01:02.003Z"),
          version: "1",
        },
        replayed: false,
      };
    });
    const principalCrypto = {
      decrypt,
    } as unknown as RenavePrincipalCrypto;
    const municipalityCatalog = {
      contains: vi.fn(async () => true),
    };
    const appendAudit = vi.fn(async (_client, _input) => {
      executionOrder.push("audit");
      return {} as never;
    });
    const preflight = {
      verify: vi.fn(async () => {
        executionOrder.push("preflight");
        return { remoteStockId: validBody.stockId };
      }),
    };
    const probeReplay = vi.fn(
      async (): Promise<
        | { state: "missing" }
        | {
            createdAt: Date;
            operationId: string;
            requestSha256: Buffer;
            state: "match";
          }
      > => ({ state: "missing" }),
    );
    const recordReplay = vi.fn(async () => undefined);
    const temporalGuard = {
      assert: vi.fn(() => executionOrder.push("temporal")),
    };
    const keyGenerationChecker = {
      assert: vi.fn(async () => undefined),
    };
    const useCase = new PostgresHeldStockExitOperation({
      appendAudit,
      buildOperation,
      createOperation,
      digestKeys: {
        actor: Buffer.alloc(32, 21),
        idempotency: Buffer.alloc(32, 22),
        vehicle: Buffer.alloc(32, 23),
      },
      environment: "homologation",
      keyGeneration: {
        fingerprint: Buffer.alloc(32, 71),
        generationId: "held-local-v1",
      },
      keyGenerationChecker,
      municipalityCatalog,
      preflight,
      probeReplay,
      principalCrypto,
      projectionCipher: {} as never,
      requestCipher: {} as never,
      resolver,
      recordReplay,
      runner,
      temporalGuard,
    });

    const result = await useCase.execute({
      actorIp: "198.51.100.10",
      business: validBody,
      establishmentId: ESTABLISHMENT_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      now: NOW,
      session: session(),
      tenantId: TENANT_ID,
      traceId: "trace-1",
    });

    expect(result).toMatchObject({ status: "HELD_LOCAL", replayed: false });
    expect(protectedRequest).toMatchObject({
      cpfOperadorResponsavel: "52998224725",
      emailEstabelecimento: "estabelecimento@example.test",
    });
    expect(protectedRequest).not.toHaveProperty("subject");
    expect(protectedRequest).not.toHaveProperty("stockId");
    expect(executionOrder).toEqual([
      "runner",
      "runner",
      "temporal",
      "preflight",
      "temporal",
      "runner",
      "persist",
      "audit",
    ]);
    expect(preflight.verify).toHaveBeenCalledWith({
      actorIp: "198.51.100.10",
      establishmentId: ESTABLISHMENT_ID,
      stockId: validBody.stockId,
      subject: SUBJECT,
      tenantId: TENANT_ID,
      traceId: "trace-1",
      vehicle: validBody.veiculo,
    });
    expect(createOperation).toHaveBeenCalledOnce();
    expect(createOperation.mock.calls[0]?.[1]).toMatchObject({
      remoteStockId: validBody.stockId,
    });
    expect(persistedIdempotencyDigest).toEqual(
      createHmac("sha256", Buffer.alloc(32, 22))
        .update(
          JSON.stringify([
            "seu-renave-stock-exit-idempotency-v1",
            TENANT_ID,
            IDEMPOTENCY_KEY,
          ]),
        )
        .digest(),
    );
    expect(appendAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "stock-exit.held-local.created",
        actorIp: "198.51.100.10",
        actorSubject: SUBJECT,
        establishmentId: ESTABLISHMENT_ID,
        outcome: "succeeded",
        payloadReference: OPERATION_ID,
        requestSha256: "01".repeat(32),
        responseSha256: createHash("sha256")
          .update(
            JSON.stringify({
              createdAt: "2026-11-24T18:01:02.003Z",
              operationId: OPERATION_ID,
              replayed: false,
              status: "HELD_LOCAL",
            }),
          )
          .digest("hex"),
        traceId: "trace-1",
      }),
    );
    expect(buildOperation).toHaveBeenCalledOnce();
    expect(runnerInputs).toEqual([
      expect.objectContaining({
        action: "renave.stock-exit.request",
        establishmentId: ESTABLISHMENT_ID,
        mfa: "required",
        tenantId: TENANT_ID,
      }),
      expect.objectContaining({
        action: "renave.stock-exit.request",
        establishmentId: ESTABLISHMENT_ID,
        mfa: "required",
        tenantId: TENANT_ID,
      }),
      expect.objectContaining({
        action: "renave.stock-exit.request",
        establishmentId: ESTABLISHMENT_ID,
        mfa: "required",
        tenantId: TENANT_ID,
      }),
    ]);
    expect(municipalityCatalog.contains).toHaveBeenCalledWith(
      expect.anything(),
      1501402,
    );
    expect(secrets.every((secret) => secret.every((byte) => byte === 0))).toBe(
      true,
    );
    expect(operatorEnvelope.ciphertext.every((byte) => byte === 0)).toBe(true);
    expect(establishmentEnvelope.ciphertext.every((byte) => byte === 0)).toBe(
      true,
    );

    const preflightCalls = preflight.verify.mock.calls.length;
    probeReplay.mockResolvedValueOnce({
      createdAt: new Date("2026-11-24T18:01:02.003Z"),
      operationId: OPERATION_ID,
      requestSha256: Buffer.alloc(32, 1),
      state: "match" as const,
    });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-replay",
      }),
    ).resolves.toMatchObject({ replayed: true, operationId: OPERATION_ID });
    expect(preflight.verify).toHaveBeenCalledTimes(preflightCalls);
    expect(keyGenerationChecker.assert).toHaveBeenCalledTimes(3);

    keyGenerationChecker.assert.mockRejectedValueOnce(
      new Error("pin divergente"),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-replay-pin-drift",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_OPERATION_UNAVAILABLE" });
    expect(preflight.verify).toHaveBeenCalledTimes(preflightCalls);

    temporalGuard.assert.mockImplementationOnce(() => {
      throw new StockExitOperationError("STOCK_EXIT_CERTIFICATE_UNAVAILABLE");
    });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-certificate-invalid-before-get",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_CERTIFICATE_UNAVAILABLE" });
    expect(preflight.verify).toHaveBeenCalledTimes(preflightCalls);

    temporalGuard.assert.mockImplementationOnce(() => {
      throw new StockExitOperationError("MFA_RECENT_REQUIRED");
    });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-mfa-expired-before-get",
      }),
    ).rejects.toMatchObject({ code: "MFA_RECENT_REQUIRED" });
    expect(preflight.verify).toHaveBeenCalledTimes(preflightCalls);

    const runnerCount = runnerInputs.length;
    preflight.verify.mockResolvedValueOnce({
      remoteStockId: validBody.stockId + 1,
    });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-divergent",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_PREFLIGHT_UNAVAILABLE" });
    expect(runnerInputs).toHaveLength(runnerCount + 2);
    expect(createOperation).toHaveBeenCalledOnce();

    preflight.verify.mockResolvedValueOnce({
      remoteStockId: validBody.stockId,
    });
    temporalGuard.assert
      .mockImplementationOnce(() => executionOrder.push("temporal"))
      .mockImplementationOnce(() => {
        throw new StockExitOperationError("STOCK_EXIT_CERTIFICATE_UNAVAILABLE");
      });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-expired-certificate",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_CERTIFICATE_UNAVAILABLE" });
    expect(createOperation).toHaveBeenCalledOnce();

    preflight.verify.mockResolvedValueOnce({
      remoteStockId: validBody.stockId,
    });
    temporalGuard.assert
      .mockImplementationOnce(() => executionOrder.push("temporal"))
      .mockImplementationOnce(() => {
        throw new StockExitOperationError("MFA_RECENT_REQUIRED");
      });
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-expired-mfa",
      }),
    ).rejects.toMatchObject({ code: "MFA_RECENT_REQUIRED" });
    expect(createOperation).toHaveBeenCalledOnce();

    preflight.verify.mockRejectedValueOnce(
      Object.assign(new Error("resposta incompatível"), {
        auditContext: {
          certificateThumbprintSha256: "a".repeat(64),
          cnpjSent: "11222333000181",
          payloadReference: "evidence-preflight-1",
          requestSha256: "b".repeat(64),
        },
        code: "STOCK_EXIT_PREFLIGHT_REJECTED",
      }),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-rejected",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_PREFLIGHT_REJECTED" });
    expect(runnerInputs).toHaveLength(runnerCount + 9);
    expect(appendAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renave.stock-exit.request",
        certificateThumbprintSha256: "a".repeat(64),
        cnpjSent: "11222333000181",
        outcome: "rejected",
        payloadReference: "evidence-preflight-1",
        requestSha256: "b".repeat(64),
        responseSha256: createHash("sha256")
          .update(JSON.stringify({ code: "STOCK_EXIT_PREFLIGHT_REJECTED" }))
          .digest("hex"),
        traceId: "trace-rejected",
      }),
    );

    preflight.verify.mockRejectedValueOnce(
      Object.assign(new Error("rejeição sem evidência"), {
        code: "STOCK_EXIT_PREFLIGHT_REJECTED",
      }),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-rejected-without-evidence",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_PREFLIGHT_UNAVAILABLE" });
    expect(runnerInputs).toHaveLength(runnerCount + 11);

    appendAudit.mockRejectedValueOnce(new Error("auditoria indisponível"));
    preflight.verify.mockRejectedValueOnce(
      Object.assign(new Error("rejeição auditável"), {
        auditContext: {
          certificateThumbprintSha256: "a".repeat(64),
          cnpjSent: "11222333000181",
          payloadReference: "evidence-preflight-2",
          requestSha256: "c".repeat(64),
        },
        code: "STOCK_EXIT_PREFLIGHT_REJECTED",
      }),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-rejected-audit-failure",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_OPERATION_UNAVAILABLE" });
    expect(runnerInputs).toHaveLength(runnerCount + 14);
    expect(createOperation).toHaveBeenCalledOnce();

    preflight.verify.mockRejectedValueOnce(
      Object.assign(new Error("limitado"), {
        code: "STOCK_EXIT_PREFLIGHT_LIMITED",
        retryAfterSeconds: 11,
      }),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-limited",
      }),
    ).rejects.toMatchObject({
      code: "STOCK_EXIT_PREFLIGHT_LIMITED",
      retryAfterSeconds: 11,
    });
    expect(runnerInputs).toHaveLength(runnerCount + 16);

    preflight.verify.mockRejectedValueOnce(new Error("remote payload"));
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-unavailable",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_PREFLIGHT_UNAVAILABLE" });
    expect(runnerInputs).toHaveLength(runnerCount + 18);
    expect(createOperation).toHaveBeenCalledOnce();

    municipalityCatalog.contains.mockResolvedValueOnce(false);
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STOCK_EXIT_MUNICIPALITY" });
    expect(createOperation).toHaveBeenCalledOnce();
    expect(resolver.resolve).toHaveBeenCalledOnce();

    createOperation.mockRejectedValueOnce(
      Object.assign(new Error("conflito interno"), {
        name: "OperationIdempotencyConflictError",
      }),
    );
    await expect(
      useCase.execute({
        actorIp: "198.51.100.10",
        business: validBody,
        establishmentId: ESTABLISHMENT_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        now: NOW,
        session: session(),
        tenantId: TENANT_ID,
        traceId: "trace-idempotency-conflict",
      }),
    ).rejects.toMatchObject({ code: "STOCK_EXIT_IDEMPOTENCY_CONFLICT" });
    expect(createOperation).toHaveBeenCalledTimes(2);
  });
});
