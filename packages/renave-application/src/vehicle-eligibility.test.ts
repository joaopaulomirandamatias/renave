import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationDeniedError,
  type AuthorizationContext,
} from "@seu-renave/access-control";
import {
  RenaveIdentityMismatchError,
  type MutationResult,
  type VehicleEligibilityResponse,
} from "@seu-renave/renave-connector";

import {
  EstablishmentUnavailableError,
  VehicleEligibilityService,
  type EligibilityAuditRecord,
  type VehicleEligibilityPorts,
} from "./vehicle-eligibility.js";

const TENANT_ID = "5b13742c-4c89-4658-83f7-c247540f178c";
const OTHER_TENANT_ID = "18f6096f-463d-4afe-a0c7-e56900adf494";
const ESTABLISHMENT_ID = "7e7577ea-131b-48cb-8437-ce779f609417";
const OTHER_ESTABLISHMENT_ID = "2b16db30-d934-46bc-9ad2-270ea4bb43cc";
const SUBJECT = "oidc|operador-1";
const ESTABLISHMENT_CNPJ = "11222333000181";
const INTEGRATOR_CNPJ = "12ABC34501DE35";
const CERTIFICATE_SHA256 = "c".repeat(64);
const PAYLOAD_REFERENCE = "evidence://eligibility/attempt-1";

const operatorContext: AuthorizationContext = {
  grants: [
    {
      establishmentIds: [ESTABLISHMENT_ID],
      role: "renave_operator",
    },
  ],
  subject: SUBJECT,
  tenantId: TENANT_ID,
};

const successfulResult: MutationResult<VehicleEligibilityResponse> = {
  result: {
    diagnostico: {
      veiculoApto: true,
      veiculoComRecall: false,
    },
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
  auditError?: Error;
  authorizationContext?: AuthorizationContext | null;
  connectorError?: Error;
  connectorResult?: unknown;
  evidenceCompleteError?: Error;
  evidenceFailError?: Error;
  establishment?: {
    cnpj: string;
    id: string;
    status: "active" | "inactive";
    tenantId: string;
  } | null;
}) {
  const audits: EligibilityAuditRecord[] = [];
  const begin = vi.fn(async () => ({
    payloadReference: PAYLOAD_REFERENCE,
  }));
  const complete = vi.fn(async () => {
    if (options?.evidenceCompleteError) throw options.evidenceCompleteError;
  });
  const fail = vi.fn(async () => {
    if (options?.evidenceFailError) throw options.evidenceFailError;
  });
  const connector = vi.fn(async () => {
    if (options?.connectorError) throw options.connectorError;
    return (options?.connectorResult ??
      successfulResult) as MutationResult<VehicleEligibilityResponse>;
  });
  const ports: VehicleEligibilityPorts = {
    audit: {
      append: vi.fn(async (record) => {
        if (options?.auditError && record.outcome === "rejected") {
          throw options.auditError;
        }
        audits.push(record);
      }),
    },
    authorizationContexts: {
      load: vi.fn(async () =>
        options && "authorizationContext" in options
          ? (options.authorizationContext ?? null)
          : operatorContext,
      ),
    },
    connector: { getVehicleEligibility: connector },
    establishments: {
      load: vi.fn(async () =>
        options && "establishment" in options
          ? (options.establishment ?? null)
          : {
              cnpj: ESTABLISHMENT_CNPJ,
              id: ESTABLISHMENT_ID,
              status: "active" as const,
              tenantId: TENANT_ID,
            },
      ),
    },
    protectedEvidence: { begin, complete, fail },
  };
  const service = new VehicleEligibilityService(ports, {
    certificateThumbprintSha256: CERTIFICATE_SHA256,
    integratorCnpj: INTEGRATOR_CNPJ,
  });

  return { audits, begin, complete, connector, fail, ports, service };
}

const input = {
  actorIp: "198.51.100.10",
  crvType: "DIGITAL" as const,
  establishmentId: ESTABLISHMENT_ID,
  plate: "abc1d23",
  subject: SUBJECT,
  tenantId: TENANT_ID,
  traceId: "trace-123",
};

const impedimentCases = [
  ["veiculoBaixado", "VEHICLE_WRITTEN_OFF"],
  ["veiculoComAlarme", "VEHICLE_ALARM"],
  ["veiculoComLicenciamentoProvisorio", "PROVISIONAL_REGISTRATION"],
  ["veiculoComPendenciaDeEmissaoCrv", "CRV_ISSUANCE_PENDING"],
  ["veiculoComRecall", "RECALL_PENDING"],
  ["veiculoComRestricaoExtrajudicial", "EXTRAJUDICIAL_RESTRICTION"],
  ["veiculoComRestricaoImpeditivaNoDetran", "DETRAN_BLOCKING_RESTRICTION"],
  ["veiculoComRestricaoJudicial", "JUDICIAL_RESTRICTION"],
  ["veiculoComRestricaoNaReceitaFederal", "FEDERAL_REVENUE_RESTRICTION"],
  ["veiculoComRestricaoPgfn", "PGFN_RESTRICTION"],
  ["veiculoComRouboFurto", "THEFT_OR_ROBBERY"],
  ["veiculoSemAtpv", "ATPV_MISSING"],
  [
    "veiculoTemAutorizacaoTransferenciaParaEstabelecimentoDiferenteDoEstabelecimentoConsultante",
    "TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT",
  ],
  [
    "veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
    "SALE_NOTICE_FOR_DIFFERENT_BUYER",
  ],
  [
    "veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
    "SALE_INTENT_FOR_DIFFERENT_BUYER",
  ],
] as const;

describe("VehicleEligibilityService", () => {
  it("consulta em homologação usando apenas o CNPJ carregado no servidor", async () => {
    const harness = createHarness();

    await expect(harness.service.execute(input)).resolves.toEqual({
      detranUnavailable: false,
      impediments: [],
      status: "eligible",
    });

    expect(harness.connector).toHaveBeenCalledWith(
      {
        environment: "homologation",
        establishmentCnpj: ESTABLISHMENT_CNPJ,
        establishmentId: ESTABLISHMENT_ID,
        integratorCnpj: INTEGRATOR_CNPJ,
        tenantId: TENANT_ID,
      },
      { placa: "ABC1D23", tipoCrv: "DIGITAL" },
    );
    expect(harness.audits.map((event) => event.outcome)).toEqual([
      "attempted",
      "succeeded",
    ]);
    expect(harness.audits[1]).toMatchObject({
      certificateThumbprintSha256: CERTIFICATE_SHA256,
      cnpjConfirmed: ESTABLISHMENT_CNPJ,
      cnpjSent: ESTABLISHMENT_CNPJ,
      integratorCnpjConfirmed: INTEGRATOR_CNPJ,
      payloadReference: PAYLOAD_REFERENCE,
      requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(harness.audits)).not.toContain("ABC1D23");
    expect(harness.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { placa: "ABC1D23", tipoCrv: "DIGITAL" },
      }),
    );
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it("preserva a resposta integral na evidência e devolve somente códigos seguros", async () => {
    const rawResponse: VehicleEligibilityResponse = {
      autorizacaoTransferencia: {
        cpfOperadorResponsavelAutorizacao: "12345678901",
        dataHoraAutorizacao: "2026-11-23T10:00:00-03:00",
      },
      comunicacaoComDetranFalhou: false,
      diagnostico: {
        motivosParaNaoAptidao: ["texto livre externo"],
        veiculoApto: false,
        veiculoBaixado: true,
        veiculoComAlarme: true,
        veiculoComLicenciamentoProvisorio: true,
        veiculoComPendenciaDeEmissaoCrv: true,
        veiculoComRecall: true,
        veiculoComRestricaoExtrajudicial: true,
        veiculoComRestricaoImpeditivaNoDetran: true,
        veiculoComRestricaoJudicial: true,
        veiculoComRestricaoNaReceitaFederal: true,
        veiculoComRestricaoPgfn: true,
        veiculoComRouboFurto: true,
        veiculoSemAtpv: true,
        veiculoTemAutorizacaoTransferenciaParaEstabelecimentoDiferenteDoEstabelecimentoConsultante: true,
        veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante: true,
        veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante: true,
      },
      informacoesDebitos: {
        boletos: [{ codigo: "boleto-sensivel" }],
        existemDebitos: true,
        valorDebitoMultas: 123.45,
      },
      veiculo: {
        chassi: "9BWZZZ377VT004251",
        placa: "ABC1D23",
        renavam: "12345678901",
      },
    };
    const harness = createHarness({
      connectorResult: { ...successfulResult, result: rawResponse },
    });

    const summary = await harness.service.execute(input);

    expect(summary).toEqual({
      detranUnavailable: false,
      impediments: [
        "VEHICLE_WRITTEN_OFF",
        "VEHICLE_ALARM",
        "PROVISIONAL_REGISTRATION",
        "CRV_ISSUANCE_PENDING",
        "RECALL_PENDING",
        "EXTRAJUDICIAL_RESTRICTION",
        "DETRAN_BLOCKING_RESTRICTION",
        "JUDICIAL_RESTRICTION",
        "FEDERAL_REVENUE_RESTRICTION",
        "PGFN_RESTRICTION",
        "THEFT_OR_ROBBERY",
        "ATPV_MISSING",
        "TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT",
        "SALE_NOTICE_FOR_DIFFERENT_BUYER",
        "SALE_INTENT_FOR_DIFFERENT_BUYER",
      ],
      status: "ineligible",
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /12345678901|9BWZZZ377VT004251|ABC1D23|boleto|chassi|cpf|debito|motivo|placa|renavam|valor/iu,
    );
    expect(harness.complete).toHaveBeenCalledWith({
      payloadReference: PAYLOAD_REFERENCE,
      response: rawResponse,
    });
  });

  it.each(impedimentCases)(
    "falha fechado quando apto conflita com %s",
    async (field, code) => {
      const rawResponse: VehicleEligibilityResponse = {
        diagnostico: { [field]: true, veiculoApto: true },
      };
      const harness = createHarness({
        connectorResult: { ...successfulResult, result: rawResponse },
      });

      await expect(harness.service.execute(input)).resolves.toEqual({
        detranUnavailable: false,
        impediments: [code],
        status: "undetermined",
      });
      expect(harness.complete).toHaveBeenCalledWith({
        payloadReference: PAYLOAD_REFERENCE,
        response: rawResponse,
      });
    },
  );

  it("expõe código seguro quando a inaptidão não possui flag estruturado", async () => {
    const harness = createHarness({
      connectorResult: {
        ...successfulResult,
        result: {
          diagnostico: {
            motivosParaNaoAptidao: ["mensagem livre que não pode vazar"],
            veiculoApto: false,
          },
        },
      },
    });

    const summary = await harness.service.execute(input);

    expect(summary).toEqual({
      detranUnavailable: false,
      impediments: ["UNSPECIFIED_INELIGIBILITY"],
      status: "ineligible",
    });
    expect(JSON.stringify(summary)).not.toContain("mensagem livre");
  });

  it.each([
    [
      "falha de comunicação com o DETRAN",
      { comunicacaoComDetranFalhou: true, diagnostico: { veiculoApto: true } },
      true,
    ],
    ["diagnóstico sem decisão", { diagnostico: {} }, false],
  ] as const)(
    "marca como indeterminado quando há %s",
    async (_name, result, detranUnavailable) => {
      const harness = createHarness({
        connectorResult: { ...successfulResult, result },
      });

      await expect(harness.service.execute(input)).resolves.toEqual({
        detranUnavailable,
        impediments: [],
        status: "undetermined",
      });
    },
  );

  it("recusa contexto de autorização de outro tenant antes de tocar no SERPRO", async () => {
    const harness = createHarness({
      authorizationContext: { ...operatorContext, tenantId: OTHER_TENANT_ID },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      reason: "TENANT_MISMATCH",
    });
    expect(harness.connector).not.toHaveBeenCalled();
    expect(harness.begin).not.toHaveBeenCalled();
  });

  it("recusa grants devolvidos para outro sujeito OIDC", async () => {
    const harness = createHarness({
      authorizationContext: {
        ...operatorContext,
        subject: "oidc|outro-usuario",
      },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      reason: "INVALID_CONTEXT",
    });
    expect(harness.connector).not.toHaveBeenCalled();
    expect(harness.begin).not.toHaveBeenCalled();
  });

  it("recusa estabelecimento fora do escopo do operador", async () => {
    const harness = createHarness({
      authorizationContext: {
        ...operatorContext,
        grants: [
          {
            establishmentIds: [OTHER_ESTABLISHMENT_ID],
            role: "renave_operator",
          },
        ],
      },
    });

    const result = harness.service.execute(input);
    await expect(result).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(result).rejects.toMatchObject({
      reason: "ESTABLISHMENT_SCOPE_DENIED",
    });
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("recusa papel sem permissão para a consulta", async () => {
    const harness = createHarness({
      authorizationContext: {
        ...operatorContext,
        grants: [
          {
            establishmentIds: "*",
            role: "compliance_auditor",
          },
        ],
      },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      reason: "ROLE_DENIED",
    });
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("recusa estabelecimento inativo mesmo quando o papel permite o escopo", async () => {
    const harness = createHarness({
      establishment: {
        cnpj: ESTABLISHMENT_CNPJ,
        id: ESTABLISHMENT_ID,
        status: "inactive",
        tenantId: TENANT_ID,
      },
    });

    await expect(harness.service.execute(input)).rejects.toEqual(
      new EstablishmentUnavailableError("INACTIVE"),
    );
    expect(harness.connector).not.toHaveBeenCalled();
    expect(harness.begin).not.toHaveBeenCalled();
  });

  it("audita e mantém o erro quando o RENAVE confirma identidade divergente", async () => {
    const connectorError = new RenaveIdentityMismatchError(
      "INTEGRATOR_MISMATCH",
    );
    const harness = createHarness({ connectorError });

    await expect(harness.service.execute(input)).rejects.toBe(connectorError);
    expect(harness.fail).toHaveBeenCalledWith({
      errorCode: "RENAVE_IDENTITY_MISMATCH",
      payloadReference: PAYLOAD_REFERENCE,
    });
    expect(harness.audits.map((event) => event.outcome)).toEqual([
      "attempted",
      "rejected",
    ]);
    expect(JSON.stringify(harness.audits)).not.toContain("ABC1D23");
  });

  it("registra falha opaca do conector sem guardar mensagem externa na auditoria", async () => {
    const connectorError = new Error(
      "mensagem externa que não deve ir para a trilha",
    );
    const harness = createHarness({ connectorError });

    await expect(harness.service.execute(input)).rejects.toBe(connectorError);
    expect(harness.fail).toHaveBeenCalledWith({
      errorCode: "RENAVE_CONNECTOR_ERROR",
      payloadReference: PAYLOAD_REFERENCE,
    });
    expect(JSON.stringify(harness.audits)).not.toContain("mensagem externa");
  });

  it("não reclassifica resposta válida como rejeitada quando a evidência local falha", async () => {
    const evidenceError = new Error("armazenamento de evidência indisponível");
    const harness = createHarness({ evidenceCompleteError: evidenceError });

    await expect(harness.service.execute(input)).rejects.toBe(evidenceError);
    expect(harness.connector).toHaveBeenCalledOnce();
    expect(harness.audits.map((event) => event.outcome)).toEqual(["attempted"]);
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it("preserva o erro do conector quando o registro secundário da falha também falha", async () => {
    const connectorError = new RenaveIdentityMismatchError(
      "ESTABLISHMENT_MISMATCH",
    );
    const harness = createHarness({
      auditError: new Error("auditoria indisponível"),
      connectorError,
      evidenceFailError: new Error("evidência indisponível"),
    });

    await expect(harness.service.execute(input)).rejects.toBe(connectorError);
    expect(harness.fail).toHaveBeenCalledOnce();
    expect(harness.audits.map((event) => event.outcome)).toEqual(["attempted"]);
  });

  it("recusa identidade verificada de outro contexto antes de salvar sucesso", async () => {
    const harness = createHarness({
      connectorResult: {
        ...successfulResult,
        verifiedIdentity: {
          ...successfulResult.verifiedIdentity,
          tenantId: OTHER_TENANT_ID,
        },
      },
    });

    await expect(harness.service.execute(input)).rejects.toMatchObject({
      code: "ELIGIBILITY_VERIFIED_IDENTITY_MISMATCH",
    });
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.audits.map((event) => event.outcome)).toEqual([
      "attempted",
      "rejected",
    ]);
  });

  it.each([
    ["nula", null],
    ["array", []],
    ["texto", "resposta inesperada"],
    ["diagnóstico incompatível", { diagnostico: { veiculoApto: "sim" } }],
  ])(
    "recusa resposta %s antes de completar evidência ou auditar sucesso",
    async (_description, result) => {
      const harness = createHarness({
        connectorResult: { ...successfulResult, result },
      });

      await expect(harness.service.execute(input)).rejects.toMatchObject({
        code: "RENAVE_PROTOCOL_ERROR",
      });
      expect(harness.complete).not.toHaveBeenCalled();
      expect(harness.fail).toHaveBeenCalledWith({
        errorCode: "RENAVE_PROTOCOL_ERROR",
        payloadReference: PAYLOAD_REFERENCE,
      });
      expect(harness.audits.map((event) => event.outcome)).toEqual([
        "attempted",
        "rejected",
      ]);
    },
  );
});
