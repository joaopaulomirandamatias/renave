import { createHash } from "node:crypto";

import {
  authorize,
  AuthorizationDeniedError,
  type AuthorizationContext,
} from "@seu-renave/access-control";
import {
  normalizeCnpj,
  RenaveProtocolError,
  type CrvType,
  type MutationResult,
  type RenaveServerContext,
  type VehicleEligibilityQuery,
  type VehicleEligibilityResponse,
} from "@seu-renave/renave-connector";

const ACTION = "renave.vehicle.eligibility.read" as const;

export interface VehicleEligibilityInput {
  actorIp: string;
  crvType: CrvType;
  establishmentId: string;
  plate: string;
  subject: string;
  tenantId: string;
  traceId?: string;
}

export interface ApplicationEstablishment {
  cnpj: string;
  id: string;
  status: "active" | "inactive";
  tenantId: string;
}

export interface AuthorizationContextPort {
  load(input: {
    subject: string;
    tenantId: string;
  }): Promise<AuthorizationContext | null>;
}

export interface EstablishmentPort {
  load(input: {
    establishmentId: string;
    tenantId: string;
  }): Promise<ApplicationEstablishment | null>;
}

export interface VehicleEligibilityConnectorPort {
  getVehicleEligibility(
    context: RenaveServerContext,
    query: VehicleEligibilityQuery,
  ): Promise<MutationResult<VehicleEligibilityResponse>>;
}

export interface EvidenceContext {
  action: typeof ACTION;
  actorSubject: string;
  establishmentId: string;
  request: VehicleEligibilityQuery;
  tenantId: string;
  traceId?: string;
}

export interface ProtectedEvidencePort {
  begin(context: EvidenceContext): Promise<{ payloadReference: string }>;
  complete(input: {
    payloadReference: string;
    response: VehicleEligibilityResponse;
  }): Promise<void>;
  fail(input: { errorCode: string; payloadReference: string }): Promise<void>;
}

export type EligibilityAuditOutcome = "attempted" | "rejected" | "succeeded";

export interface EligibilityAuditRecord {
  action: typeof ACTION;
  actorIp: string;
  actorSubject: string;
  certificateThumbprintSha256: string;
  cnpjConfirmed?: string;
  cnpjSent: string;
  establishmentId: string;
  integratorCnpjConfirmed?: string;
  outcome: EligibilityAuditOutcome;
  payloadReference: string;
  requestSha256: string;
  responseSha256?: string;
  tenantId: string;
  traceId?: string;
}

export interface EligibilityAuditPort {
  append(record: EligibilityAuditRecord): Promise<void>;
}

export interface VehicleEligibilityPorts {
  audit: EligibilityAuditPort;
  authorizationContexts: AuthorizationContextPort;
  connector: VehicleEligibilityConnectorPort;
  establishments: EstablishmentPort;
  protectedEvidence: ProtectedEvidencePort;
}

export interface VehicleEligibilityServiceConfig {
  certificateThumbprintSha256: string;
  integratorCnpj: string;
}

export type EligibilityImpedimentCode =
  | "UNSPECIFIED_INELIGIBILITY"
  | "VEHICLE_WRITTEN_OFF"
  | "VEHICLE_ALARM"
  | "PROVISIONAL_REGISTRATION"
  | "CRV_ISSUANCE_PENDING"
  | "RECALL_PENDING"
  | "EXTRAJUDICIAL_RESTRICTION"
  | "DETRAN_BLOCKING_RESTRICTION"
  | "JUDICIAL_RESTRICTION"
  | "FEDERAL_REVENUE_RESTRICTION"
  | "PGFN_RESTRICTION"
  | "THEFT_OR_ROBBERY"
  | "ATPV_MISSING"
  | "TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT"
  | "SALE_NOTICE_FOR_DIFFERENT_BUYER"
  | "SALE_INTENT_FOR_DIFFERENT_BUYER";

export interface VehicleEligibilitySummary {
  detranUnavailable: boolean;
  impediments: readonly EligibilityImpedimentCode[];
  status: "eligible" | "ineligible" | "undetermined";
}

export class EstablishmentUnavailableError extends Error {
  readonly code = "ESTABLISHMENT_UNAVAILABLE";

  constructor(
    readonly reason:
      "IDENTIFIER_MISMATCH" | "INACTIVE" | "NOT_FOUND" | "TENANT_MISMATCH",
  ) {
    super("O estabelecimento autorizado não está disponível para consulta");
    this.name = "EstablishmentUnavailableError";
  }
}

export class InvalidEligibilityApplicationInputError extends Error {
  readonly code = "INVALID_ELIGIBILITY_APPLICATION_INPUT";

  constructor(readonly field: keyof VehicleEligibilityInput) {
    super("A solicitação de consulta contém dados inválidos");
    this.name = "InvalidEligibilityApplicationInputError";
  }
}

export class EligibilityEvidenceError extends Error {
  readonly code = "ELIGIBILITY_EVIDENCE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "EligibilityEvidenceError";
  }
}

export class EligibilityVerifiedIdentityMismatchError extends Error {
  readonly code = "ELIGIBILITY_VERIFIED_IDENTITY_MISMATCH";

  constructor() {
    super("A identidade verificada não corresponde ao contexto autorizado");
    this.name = "EligibilityVerifiedIdentityMismatchError";
  }
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function normalizedPlate(value: string): string {
  const plate = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{7}$/.test(plate)) {
    throw new InvalidEligibilityApplicationInputError("plate");
  }
  return plate;
}

function validateCrvType(value: CrvType): CrvType {
  if (!["AZUL", "VERDE", "BRANCO", "DIGITAL"].includes(value)) {
    throw new InvalidEligibilityApplicationInputError("crvType");
  }
  return value;
}

function requireText(
  value: string,
  field: keyof VehicleEligibilityInput,
): string {
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidEligibilityApplicationInputError(field);
  }
  return value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code)
  ) {
    return error.code;
  }
  return "RENAVE_CONNECTOR_ERROR";
}

function validatePayloadReference(reference: string): string {
  if (reference.trim().length === 0 || reference.trim() !== reference) {
    throw new EligibilityEvidenceError(
      "O armazenamento protegido não devolveu uma referência válida",
    );
  }
  return reference;
}

function validateVerifiedIdentity(
  result: MutationResult<VehicleEligibilityResponse>,
  expected: RenaveServerContext,
): void {
  const identity = result.verifiedIdentity;
  let confirmedEstablishment: string;
  let confirmedIntegrator: string;
  try {
    confirmedEstablishment = normalizeCnpj(identity.confirmedEstablishmentCnpj);
    confirmedIntegrator = normalizeCnpj(identity.confirmedIntegratorCnpj);
  } catch {
    throw new EligibilityVerifiedIdentityMismatchError();
  }

  if (
    identity.environment !== expected.environment ||
    identity.tenantId !== expected.tenantId ||
    identity.establishmentId !== expected.establishmentId ||
    confirmedEstablishment !== normalizeCnpj(expected.establishmentCnpj) ||
    confirmedIntegrator !== normalizeCnpj(expected.integratorCnpj)
  ) {
    throw new EligibilityVerifiedIdentityMismatchError();
  }
}

const DIAGNOSIS_BOOLEAN_FIELDS = [
  "veiculoApto",
  "veiculoBaixado",
  "veiculoComAlarme",
  "veiculoComLicenciamentoProvisorio",
  "veiculoComPendenciaDeEmissaoCrv",
  "veiculoComRecall",
  "veiculoComRestricaoExtrajudicial",
  "veiculoComRestricaoImpeditivaNoDetran",
  "veiculoComRestricaoJudicial",
  "veiculoComRestricaoNaReceitaFederal",
  "veiculoComRestricaoPgfn",
  "veiculoComRouboFurto",
  "veiculoSemAtpv",
  "veiculoTemAutorizacaoTransferenciaParaEstabelecimentoDiferenteDoEstabelecimentoConsultante",
  "veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
  "veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante",
] as const;

function protocolObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
  return value as Record<string, unknown>;
}

function optionalStrings(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (
    fields.some(
      (field) => value[field] !== undefined && typeof value[field] !== "string",
    )
  ) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
}

function validateEligibilityResponse(
  value: unknown,
): asserts value is VehicleEligibilityResponse {
  const response = protocolObject(value);
  const responseFields = [
    "autorizacaoTransferencia",
    "comunicacaoComDetranFalhou",
    "diagnostico",
    "informacoesDebitos",
    "veiculo",
  ] as const;
  if (!responseFields.some((field) => response[field] !== undefined)) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
  if (
    response.comunicacaoComDetranFalhou !== undefined &&
    typeof response.comunicacaoComDetranFalhou !== "boolean"
  ) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }

  if (response.diagnostico !== undefined) {
    const diagnosis = protocolObject(response.diagnostico);
    if (
      DIAGNOSIS_BOOLEAN_FIELDS.some(
        (field) =>
          diagnosis[field] !== undefined &&
          typeof diagnosis[field] !== "boolean",
      ) ||
      (diagnosis.motivosParaNaoAptidao !== undefined &&
        (!Array.isArray(diagnosis.motivosParaNaoAptidao) ||
          diagnosis.motivosParaNaoAptidao.some(
            (reason) => typeof reason !== "string",
          )))
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }

  if (response.autorizacaoTransferencia !== undefined) {
    const authorization = protocolObject(response.autorizacaoTransferencia);
    optionalStrings(authorization, [
      "cpfOperadorResponsavelAutorizacao",
      "dataHoraAutorizacao",
    ]);
    if (authorization.estabelecimentoAutorizador !== undefined) {
      protocolObject(authorization.estabelecimentoAutorizador);
    }
  }

  if (response.informacoesDebitos !== undefined) {
    const debts = protocolObject(response.informacoesDebitos);
    if (
      (debts.existemDebitos !== undefined &&
        typeof debts.existemDebitos !== "boolean") ||
      [
        "valorDebitoDpvat",
        "valorDebitoIpva",
        "valorDebitoLicenciamento",
        "valorDebitoMultas",
        "valorTaxasEDebitosDiversos",
      ].some(
        (field) =>
          debts[field] !== undefined &&
          (typeof debts[field] !== "number" ||
            !Number.isFinite(debts[field] as number)),
      ) ||
      (debts.codigosBancos !== undefined &&
        (!Array.isArray(debts.codigosBancos) ||
          debts.codigosBancos.some((code) => typeof code !== "string"))) ||
      (debts.boletos !== undefined && !Array.isArray(debts.boletos))
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }

  if (response.veiculo !== undefined) {
    const vehicle = protocolObject(response.veiculo);
    optionalStrings(vehicle, ["chassi", "dataPreCadastro", "placa", "renavam"]);
    if (
      (vehicle.veiculoAcabado !== undefined &&
        typeof vehicle.veiculoAcabado !== "boolean") ||
      (vehicle.restricoes !== undefined && !Array.isArray(vehicle.restricoes))
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }
}

const IMPEDIMENT_FIELDS = [
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
] as const satisfies readonly (readonly [
  Exclude<(typeof DIAGNOSIS_BOOLEAN_FIELDS)[number], "veiculoApto">,
  EligibilityImpedimentCode,
])[];

type DiagnosisImpedimentField = Exclude<
  (typeof DIAGNOSIS_BOOLEAN_FIELDS)[number],
  "veiculoApto"
>;
type MappedImpedimentField = (typeof IMPEDIMENT_FIELDS)[number][0];
const ALL_IMPEDIMENT_FIELDS_MAPPED: Exclude<
  DiagnosisImpedimentField,
  MappedImpedimentField
> extends never
  ? true
  : never = true;

function summarizeEligibility(
  response: VehicleEligibilityResponse,
): VehicleEligibilitySummary {
  const detranUnavailable = response.comunicacaoComDetranFalhou === true;
  const eligible = response.diagnostico?.veiculoApto;
  const mappedImpediments = IMPEDIMENT_FIELDS.flatMap(([field, code]) =>
    response.diagnostico?.[field] === true ? [code] : [],
  );
  void ALL_IMPEDIMENT_FIELDS_MAPPED;
  return {
    detranUnavailable,
    impediments:
      eligible === false && mappedImpediments.length === 0
        ? ["UNSPECIFIED_INELIGIBILITY"]
        : mappedImpediments,
    status:
      detranUnavailable ||
      eligible === undefined ||
      (eligible && mappedImpediments.length > 0)
        ? "undetermined"
        : eligible
          ? "eligible"
          : "ineligible",
  };
}

export class VehicleEligibilityService {
  private readonly certificateThumbprintSha256: string;
  private readonly integratorCnpj: string;

  constructor(
    private readonly ports: VehicleEligibilityPorts,
    config: VehicleEligibilityServiceConfig,
  ) {
    if (!/^[0-9a-f]{64}$/.test(config.certificateThumbprintSha256)) {
      throw new EligibilityEvidenceError(
        "A impressão digital SHA-256 do certificado é inválida",
      );
    }
    this.certificateThumbprintSha256 = config.certificateThumbprintSha256;
    this.integratorCnpj = normalizeCnpj(config.integratorCnpj);
  }

  async execute(
    input: VehicleEligibilityInput,
  ): Promise<VehicleEligibilitySummary> {
    const subject = requireText(input.subject, "subject");
    const tenantId = requireText(input.tenantId, "tenantId");
    const establishmentId = requireText(
      input.establishmentId,
      "establishmentId",
    );
    const actorIp = requireText(input.actorIp, "actorIp");
    const plate = normalizedPlate(input.plate);
    const crvType = validateCrvType(input.crvType);
    if (input.traceId !== undefined) requireText(input.traceId, "traceId");

    const authorizationContext = await this.ports.authorizationContexts.load({
      subject,
      tenantId,
    });
    if (
      authorizationContext !== null &&
      authorizationContext.subject !== subject
    ) {
      throw new AuthorizationDeniedError("INVALID_CONTEXT");
    }
    const decision = authorize(
      authorizationContext ?? { grants: [], subject, tenantId },
      {
        action: ACTION,
        establishmentId,
        tenantId,
      },
    );
    if (!decision.allowed) {
      throw new AuthorizationDeniedError(decision.reason);
    }

    const establishment = await this.ports.establishments.load({
      establishmentId,
      tenantId,
    });
    if (!establishment) {
      throw new EstablishmentUnavailableError("NOT_FOUND");
    }
    if (establishment.tenantId !== tenantId) {
      throw new EstablishmentUnavailableError("TENANT_MISMATCH");
    }
    if (establishment.id !== establishmentId) {
      throw new EstablishmentUnavailableError("IDENTIFIER_MISMATCH");
    }
    if (establishment.status !== "active") {
      throw new EstablishmentUnavailableError("INACTIVE");
    }

    const establishmentCnpj = normalizeCnpj(establishment.cnpj);
    const query: VehicleEligibilityQuery = {
      placa: plate,
      tipoCrv: crvType,
    };
    const requestSha256 = sha256(query);
    const evidence = await this.ports.protectedEvidence.begin({
      action: ACTION,
      actorSubject: subject,
      establishmentId,
      request: query,
      tenantId,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    const payloadReference = validatePayloadReference(
      evidence.payloadReference,
    );
    const commonAudit = {
      action: ACTION,
      actorIp,
      actorSubject: subject,
      certificateThumbprintSha256: this.certificateThumbprintSha256,
      cnpjSent: establishmentCnpj,
      establishmentId,
      payloadReference,
      requestSha256,
      tenantId,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    } as const;

    await this.ports.audit.append({
      ...commonAudit,
      outcome: "attempted",
    });

    const context: RenaveServerContext = {
      environment: "homologation",
      establishmentCnpj,
      establishmentId,
      integratorCnpj: this.integratorCnpj,
      tenantId,
    };

    let response: MutationResult<VehicleEligibilityResponse>;
    try {
      response = await this.ports.connector.getVehicleEligibility(
        context,
        query,
      );
      validateVerifiedIdentity(response, context);
      validateEligibilityResponse(response.result);
    } catch (error) {
      await Promise.allSettled([
        this.ports.protectedEvidence.fail({
          errorCode: errorCode(error),
          payloadReference,
        }),
        this.ports.audit.append({
          ...commonAudit,
          outcome: "rejected",
        }),
      ]);
      throw error;
    }

    await this.ports.protectedEvidence.complete({
      payloadReference,
      response: response.result,
    });
    await this.ports.audit.append({
      ...commonAudit,
      cnpjConfirmed: response.verifiedIdentity.confirmedEstablishmentCnpj,
      integratorCnpjConfirmed:
        response.verifiedIdentity.confirmedIntegratorCnpj,
      outcome: "succeeded",
      responseSha256: sha256(response.result),
    });
    return summarizeEligibility(response.result);
  }
}
