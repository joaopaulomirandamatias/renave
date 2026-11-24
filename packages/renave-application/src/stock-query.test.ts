import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext } from "@seu-renave/access-control";
import type {
  MutationResult,
  StockQueryResult,
} from "@seu-renave/renave-connector";

import {
  StockQueryResultInvalidError,
  StockQueryService,
  type StockQueryAuditRecord,
  type StockQueryFinalizationPort,
  type StockQueryPorts,
} from "./stock-query.js";

const TENANT_ID = "5b13742c-4c89-4658-83f7-c247540f178c";
const OTHER_TENANT_ID = "18f6096f-463d-4afe-a0c7-e56900adf494";
const ESTABLISHMENT_ID = "7e7577ea-131b-48cb-8437-ce779f609417";
const SUBJECT = "oidc|operador-1";
const ESTABLISHMENT_CNPJ = "11222333000181";
const INTEGRATOR_CNPJ = "12ABC34501DE35";
const CERTIFICATE_SHA256 = "c".repeat(64);
const PAYLOAD_REFERENCE = "pev1_11111111-1111-4111-8111-111111111111";

const operatorContext: AuthorizationContext = {
  grants: [{ establishmentIds: [ESTABLISHMENT_ID], role: "renave_operator" }],
  subject: SUBJECT,
  tenantId: TENANT_ID,
};

const richEvidence = [
  {
    cancelamentoEstoque: { motivo: "somente na evidência" },
    codigoSegurancaCrv: "12345678901",
    entradaEstoque: { cpfOperadorResponsavel: "12345678901" },
    estado: "CONFIRMADO" as const,
    id: 7,
    numeroCrv: "123456789012",
    placa: "ABC1D23",
    renavam: "00607701676",
    tipoCrv: "DIGITAL" as const,
  },
];

const successfulResult: MutationResult<StockQueryResult> = {
  result: {
    evidence: richEvidence,
    publicResult: [
      {
        estado: "CONFIRMADO",
        id: 7,
        placa: "ABC1D23",
      },
    ],
  },
  verifiedIdentity: {
    confirmedEstablishmentCnpj: ESTABLISHMENT_CNPJ,
    confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
    environment: "homologation",
    establishmentId: ESTABLISHMENT_ID,
    tenantId: TENANT_ID,
  },
};

function createHarness(options?: {
  authorizationContext?: AuthorizationContext | null;
  connectorError?: Error;
  connectorResult?: unknown;
  establishmentStatus?: "active" | "inactive";
  failError?: Error;
  succeedError?: Error;
}) {
  const attempted: StockQueryAuditRecord[] = [];
  const begin = vi.fn(async () => ({ payloadReference: PAYLOAD_REFERENCE }));
  const connector = vi.fn(async () => {
    if (options?.connectorError) throw options.connectorError;
    return (options?.connectorResult ??
      successfulResult) as MutationResult<StockQueryResult>;
  });
  const fail = vi.fn(
    async (_input: Parameters<StockQueryFinalizationPort["fail"]>[0]) => {
      if (options?.failError) throw options.failError;
    },
  );
  const succeed = vi.fn(
    async (_input: Parameters<StockQueryFinalizationPort["succeed"]>[0]) => {
      if (options?.succeedError) throw options.succeedError;
    },
  );
  const ports: StockQueryPorts = {
    audit: {
      append: vi.fn(async (record) => {
        attempted.push(record);
      }),
    },
    authorizationContexts: {
      load: vi.fn(async () =>
        options && "authorizationContext" in options
          ? (options.authorizationContext ?? null)
          : operatorContext,
      ),
    },
    connector: { getStocksByPlate: connector },
    establishments: {
      load: vi.fn(async () => ({
        cnpj: ESTABLISHMENT_CNPJ,
        id: ESTABLISHMENT_ID,
        status: options?.establishmentStatus ?? "active",
        tenantId: TENANT_ID,
      })),
    },
    finalization: { fail, succeed },
    protectedEvidence: { begin },
  };
  const service = new StockQueryService(ports, {
    certificateThumbprintSha256: CERTIFICATE_SHA256,
    integratorCnpj: INTEGRATOR_CNPJ,
  });
  return { attempted, begin, connector, fail, ports, service, succeed };
}

const input = {
  actorIp: "198.51.100.10",
  establishmentId: ESTABLISHMENT_ID,
  plate: " abc1d23 ",
  subject: SUBJECT,
  tenantId: TENANT_ID,
  traceId: "trace-stock-1",
};

describe("StockQueryService", () => {
  it("cifra a resposta rica e retorna somente a projeção reconstruída", async () => {
    const connectorResult = structuredClone(
      successfulResult,
    ) as MutationResult<StockQueryResult>;
    (
      connectorResult.result.publicResult[0] as unknown as Record<
        string,
        unknown
      >
    )["cpfOperadorResponsavel"] = "não pode vazar";
    const harness = createHarness({ connectorResult });

    const result = await harness.service.execute(input);

    expect(result).toEqual([{ estado: "CONFIRMADO", id: 7, placa: "ABC1D23" }]);
    expect(JSON.stringify(result)).not.toMatch(
      /cpf|renavam|numeroCrv|codigoSegurancaCrv|cancelamento/i,
    );
    expect(harness.connector).toHaveBeenCalledWith(
      {
        environment: "homologation",
        establishmentCnpj: ESTABLISHMENT_CNPJ,
        establishmentId: ESTABLISHMENT_ID,
        integratorCnpj: INTEGRATOR_CNPJ,
        tenantId: TENANT_ID,
      },
      "ABC1D23",
    );
    expect(harness.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "renave.stock.read",
        request: { placa: "ABC1D23" },
      }),
    );
    expect(harness.attempted).toEqual([
      expect.objectContaining({
        outcome: "attempted",
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(harness.succeed).toHaveBeenCalledWith({
      audit: expect.objectContaining({
        cnpjConfirmed: ESTABLISHMENT_CNPJ,
        integratorCnpjConfirmed: INTEGRATOR_CNPJ,
        outcome: "succeeded",
        responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      evidenceResponse: connectorResult.result.evidence,
      payloadReference: PAYLOAD_REFERENCE,
    });
  });

  it.each(["", "ABC123", "ABC-1234", undefined])(
    "recusa placa inválida %s antes de qualquer porta",
    async (plate) => {
      const harness = createHarness();
      await expect(
        harness.service.execute({ ...input, plate: plate as never }),
      ).rejects.toMatchObject({
        code: "INVALID_STOCK_QUERY_APPLICATION_INPUT",
        field: "plate",
      });
      expect(harness.ports.authorizationContexts.load).not.toHaveBeenCalled();
      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.connector).not.toHaveBeenCalled();
    },
  );

  it("bloqueia troca de tenant antes de criar evidência", async () => {
    const harness = createHarness({
      authorizationContext: { ...operatorContext, tenantId: OTHER_TENANT_ID },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      reason: "TENANT_MISMATCH",
    });
    expect(harness.begin).not.toHaveBeenCalled();
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("bloqueia operador vinculado a outro estabelecimento", async () => {
    const harness = createHarness({
      authorizationContext: {
        ...operatorContext,
        grants: [
          {
            establishmentIds: ["2b16db30-d934-46bc-9ad2-270ea4bb43cc"],
            role: "renave_operator",
          },
        ],
      },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      reason: "ESTABLISHMENT_SCOPE_DENIED",
    });
    expect(harness.begin).not.toHaveBeenCalled();
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("bloqueia estabelecimento inativo antes de criar evidência", async () => {
    const harness = createHarness({ establishmentStatus: "inactive" });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      code: "ESTABLISHMENT_UNAVAILABLE",
      reason: "INACTIVE",
    });
    expect(harness.begin).not.toHaveBeenCalled();
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("finaliza falha e preserva o erro original do conector", async () => {
    const connectorError = Object.assign(new Error("timeout"), {
      code: "RENAVE_HTTP_ERROR",
    });
    const harness = createHarness({
      connectorError,
      failError: new Error("falha local secundária"),
    });

    await expect(harness.service.execute(input)).rejects.toBe(connectorError);
    expect(harness.fail).toHaveBeenCalledWith({
      audit: expect.objectContaining({ outcome: "rejected" }),
      errorCode: "RENAVE_HTTP_ERROR",
      payloadReference: PAYLOAD_REFERENCE,
    });
    expect(harness.succeed).not.toHaveBeenCalled();
  });

  it("rejeita identidade verificada de outro tenant", async () => {
    const connectorResult = structuredClone(successfulResult);
    connectorResult.verifiedIdentity.tenantId = OTHER_TENANT_ID;
    const harness = createHarness({ connectorResult });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      code: "STOCK_QUERY_VERIFIED_IDENTITY_MISMATCH",
    });
    expect(harness.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "STOCK_QUERY_VERIFIED_IDENTITY_MISMATCH",
      }),
    );
  });

  it.each([
    {
      label: "id duplicado",
      result: {
        evidence: [richEvidence[0], richEvidence[0]],
        publicResult: [
          successfulResult.result.publicResult[0],
          successfulResult.result.publicResult[0],
        ],
      },
    },
    {
      label: "placa divergente",
      result: {
        evidence: richEvidence,
        publicResult: [{ estado: "CONFIRMADO", id: 7, placa: "OUT1A23" }],
      },
    },
    {
      label: "evidência desalinhada",
      result: {
        evidence: richEvidence,
        publicResult: [],
      },
    },
  ])("falha fechado para $label", async ({ result }) => {
    const harness = createHarness({
      connectorResult: { ...successfulResult, result },
    });

    await expect(harness.service.execute(input)).rejects.toBeInstanceOf(
      StockQueryResultInvalidError,
    );
    expect(harness.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "RENAVE_STOCK_QUERY_RESULT_INVALID",
      }),
    );
  });

  it("não devolve resultado quando a finalização transacional falha", async () => {
    const failure = new Error("rollback local");
    const harness = createHarness({ succeedError: failure });

    await expect(harness.service.execute(input)).rejects.toBe(failure);
  });

  it("aceita estoque vazio como resultado legítimo", async () => {
    const harness = createHarness({
      connectorResult: {
        ...successfulResult,
        result: { evidence: [], publicResult: [] },
      },
    });

    await expect(harness.service.execute(input)).resolves.toEqual([]);
    expect(harness.succeed).toHaveBeenCalledOnce();
  });

  it("calcula o hash de resposta sobre a evidência rica", async () => {
    const first = createHarness();
    const changedEvidence = structuredClone(successfulResult);
    changedEvidence.result.evidence[0]!.codigoSegurancaCrv = "99999999999";
    const second = createHarness({ connectorResult: changedEvidence });

    await first.service.execute(input);
    await second.service.execute(input);

    const firstHash = first.succeed.mock.calls[0]?.[0].audit.responseSha256;
    const secondHash = second.succeed.mock.calls[0]?.[0].audit.responseSha256;
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondHash).not.toBe(firstHash);
  });
});
