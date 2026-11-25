import { createHash } from "node:crypto";

import {
  authorize,
  AuthorizationDeniedError,
  type AuthorizationContext,
} from "@seu-renave/access-control";
import {
  normalizeCnpj,
  type CrvType,
  type StockInventoryQueryResult,
  type StockInventorySummary,
  type MutationResult,
  type RenaveServerContext,
  type RenaveStockRecord,
  type RenaveStockState,
  type StockDetail,
  type StockDetailQueryResult,
  type StockQueryResult,
  type StockSummary,
} from "@seu-renave/renave-connector";

import {
  EstablishmentUnavailableError,
  type ApplicationEstablishment,
} from "./vehicle-eligibility.js";
import {
  StockExitPreflightRejectedError,
  verifyStockExitPreflight,
  type StockExitPreflightAuditContext,
  type StockExitPreflightConfirmation,
  type StockExitVehicleIdentity,
} from "./stock-exit-preflight.js";

const ACTION = "renave.stock.read" as const;
const STOCK_STATES = new Set<RenaveStockState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);

export interface StockQueryInput {
  actorIp: string;
  establishmentId: string;
  plate: string;
  subject: string;
  tenantId: string;
  traceId?: string;
}

export type StockInventoryQueryInput = Omit<StockQueryInput, "plate">;
export type StockDetailQueryInput = StockInventoryQueryInput & {
  stockId: number;
};
export type StockExitPreflightQueryInput = StockDetailQueryInput & {
  vehicle: StockExitVehicleIdentity;
};

export interface StockQueryAuthorizationContextPort {
  load(input: {
    subject: string;
    tenantId: string;
  }): Promise<AuthorizationContext | null>;
}

export interface StockQueryEstablishmentPort {
  load(input: {
    establishmentId: string;
    tenantId: string;
  }): Promise<ApplicationEstablishment | null>;
}

export interface StockQueryConnectorPort {
  getStockById(
    context: RenaveServerContext,
    stockId: number,
  ): Promise<MutationResult<StockDetailQueryResult>>;
  getRecentStocks(
    context: RenaveServerContext,
  ): Promise<MutationResult<StockInventoryQueryResult>>;
  getStocksByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<StockQueryResult>>;
}

export interface StockQueryEvidenceContext {
  action: typeof ACTION;
  actorSubject: string;
  establishmentId: string;
  request: {
    placa?: string;
    stockId?: number;
    vehicle?: StockExitVehicleIdentity;
  };
  tenantId: string;
  traceId?: string;
}

export interface StockQueryEvidencePort {
  begin(
    context: StockQueryEvidenceContext,
  ): Promise<{ payloadReference: string }>;
}

export type StockQueryAuditOutcome = "attempted" | "rejected" | "succeeded";

export interface StockQueryAuditRecord {
  action: typeof ACTION;
  actorIp: string;
  actorSubject: string;
  certificateThumbprintSha256: string;
  cnpjConfirmed?: string;
  cnpjSent: string;
  establishmentId: string;
  integratorCnpjConfirmed?: string;
  outcome: StockQueryAuditOutcome;
  payloadReference: string;
  requestSha256: string;
  responseSha256?: string;
  tenantId: string;
  traceId?: string;
}

export interface StockQueryAuditPort {
  append(record: StockQueryAuditRecord): Promise<void>;
}

/** Finaliza evidência e auditoria em uma única transação PostgreSQL curta. */
export interface StockQueryFinalizationPort {
  succeed(input: {
    audit: StockQueryAuditRecord;
    evidenceResponse: unknown;
    payloadReference: string;
  }): Promise<void>;
  fail(input: {
    audit: StockQueryAuditRecord;
    errorCode: string;
    payloadReference: string;
  }): Promise<void>;
}

export interface StockQueryPorts {
  audit: StockQueryAuditPort;
  authorizationContexts: StockQueryAuthorizationContextPort;
  connector: StockQueryConnectorPort;
  establishments: StockQueryEstablishmentPort;
  finalization: StockQueryFinalizationPort;
  protectedEvidence: StockQueryEvidencePort;
}

export interface StockQueryServiceConfig {
  certificateThumbprintSha256: string;
  integratorCnpj: string;
}

export class InvalidStockQueryApplicationInputError extends Error {
  readonly code = "INVALID_STOCK_QUERY_APPLICATION_INPUT";

  constructor(readonly field: keyof StockQueryInput | "stockId") {
    super("A consulta pontual de estoque contém dados inválidos");
    this.name = "InvalidStockQueryApplicationInputError";
  }
}

export class StockQueryEvidenceError extends Error {
  readonly code = "STOCK_QUERY_EVIDENCE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "StockQueryEvidenceError";
  }
}

export class StockQueryVerifiedIdentityMismatchError extends Error {
  readonly code = "STOCK_QUERY_VERIFIED_IDENTITY_MISMATCH";

  constructor() {
    super("A identidade verificada não corresponde ao contexto autorizado");
    this.name = "StockQueryVerifiedIdentityMismatchError";
  }
}

export class StockQueryResultInvalidError extends Error {
  readonly code = "RENAVE_STOCK_QUERY_RESULT_INVALID";

  constructor() {
    super("O resultado da consulta de estoque é incompatível");
    this.name = "StockQueryResultInvalidError";
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

function stableErrorCode(error: unknown): string {
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

function requireText(value: unknown, field: keyof StockQueryInput): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    throw new InvalidStockQueryApplicationInputError(field);
  }
  return value;
}

function normalizedPlate(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidStockQueryApplicationInputError("plate");
  }
  const plate = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{7}$/.test(plate)) {
    throw new InvalidStockQueryApplicationInputError("plate");
  }
  return plate;
}

function validatePayloadReference(reference: unknown): string {
  if (
    typeof reference !== "string" ||
    !/^pev1_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      reference,
    )
  ) {
    throw new StockQueryEvidenceError(
      "O armazenamento protegido não devolveu uma referência válida",
    );
  }
  return reference;
}

function validateVerifiedIdentity(
  result: MutationResult<unknown>,
  expected: RenaveServerContext,
): void {
  const identity = result.verifiedIdentity;
  let confirmedEstablishment: string;
  let confirmedIntegrator: string;
  try {
    confirmedEstablishment = normalizeCnpj(identity.confirmedEstablishmentCnpj);
    confirmedIntegrator = normalizeCnpj(identity.confirmedIntegratorCnpj);
  } catch {
    throw new StockQueryVerifiedIdentityMismatchError();
  }
  if (
    identity.environment !== expected.environment ||
    identity.tenantId !== expected.tenantId ||
    identity.establishmentId !== expected.establishmentId ||
    confirmedEstablishment !== normalizeCnpj(expected.establishmentCnpj) ||
    confirmedIntegrator !== normalizeCnpj(expected.integratorCnpj)
  ) {
    throw new StockQueryVerifiedIdentityMismatchError();
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StockQueryResultInvalidError();
  }
  return value as Record<string, unknown>;
}

function resultPlate(value: unknown): string {
  try {
    return normalizedPlate(value);
  } catch {
    throw new StockQueryResultInvalidError();
  }
}

function rebuildPublicResult(
  result: StockQueryResult,
  expectedPlate: string,
): {
  evidence: readonly RenaveStockRecord[];
  publicResult: readonly StockSummary[];
} {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.evidence) ||
    !Array.isArray(result.publicResult)
  ) {
    throw new StockQueryResultInvalidError();
  }
  if (result.evidence.length !== result.publicResult.length) {
    throw new StockQueryResultInvalidError();
  }

  const ids = new Set<number>();
  const publicResult = result.publicResult.map((source, index) => {
    const candidate = recordObject(source);
    const evidence = recordObject(result.evidence[index]);
    const id = candidate.id;
    const plate = resultPlate(candidate.placa);
    const state = candidate.estado;
    if (
      !Number.isSafeInteger(id) ||
      (id as number) <= 0 ||
      ids.has(id as number) ||
      plate !== expectedPlate ||
      typeof state !== "string" ||
      !STOCK_STATES.has(state as RenaveStockState) ||
      evidence.id !== id ||
      resultPlate(evidence.placa) !== plate ||
      evidence.estado !== state
    ) {
      throw new StockQueryResultInvalidError();
    }
    ids.add(id as number);
    return Object.freeze({
      estado: state as RenaveStockState,
      id: id as number,
      placa: plate,
    });
  });

  return {
    evidence: result.evidence,
    publicResult: Object.freeze(publicResult),
  };
}

const INVENTORY_PUBLIC_KEYS = new Set([
  "chassi",
  "dataHoraRegistroEntrada",
  "estado",
  "id",
  "placa",
  "renavam",
  "tipoCrv",
]);

function optionalInventoryString(
  candidate: Record<string, unknown>,
  key: "chassi" | "dataHoraRegistroEntrada" | "renavam" | "tipoCrv",
): string | undefined {
  const value = candidate[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new StockQueryResultInvalidError();
  }
  return value;
}

function evidenceRegistrationTime(
  evidence: Record<string, unknown>,
): string | undefined {
  if (evidence.entradaEstoque === undefined) return undefined;
  const entry = recordObject(evidence.entradaEstoque);
  if (entry.dataHoraRegistro === undefined) return undefined;
  if (typeof entry.dataHoraRegistro !== "string") {
    throw new StockQueryResultInvalidError();
  }
  return entry.dataHoraRegistro;
}

function rebuildInventoryPublicResult(result: StockInventoryQueryResult): {
  evidence: readonly RenaveStockRecord[];
  publicResult: readonly StockInventorySummary[];
} {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.evidence) ||
    !Array.isArray(result.publicResult)
  ) {
    throw new StockQueryResultInvalidError();
  }

  const activeEvidence = new Map<number, Record<string, unknown>>();
  for (const source of result.evidence) {
    const evidence = recordObject(source);
    if (evidence.cancelamentoEstoque !== undefined) continue;
    if (
      !Number.isSafeInteger(evidence.id) ||
      (evidence.id as number) <= 0 ||
      activeEvidence.has(evidence.id as number)
    ) {
      throw new StockQueryResultInvalidError();
    }
    activeEvidence.set(evidence.id as number, evidence);
  }
  if (activeEvidence.size !== result.publicResult.length) {
    throw new StockQueryResultInvalidError();
  }

  const ids = new Set<number>();
  const publicResult = result.publicResult.map((source) => {
    const candidate = recordObject(source);
    if (Object.keys(candidate).some((key) => !INVENTORY_PUBLIC_KEYS.has(key))) {
      throw new StockQueryResultInvalidError();
    }
    const id = candidate.id;
    const evidence = Number.isSafeInteger(id)
      ? activeEvidence.get(id as number)
      : undefined;
    const plate = resultPlate(candidate.placa);
    const state = candidate.estado;
    const chassi = optionalInventoryString(candidate, "chassi");
    const renavam = optionalInventoryString(candidate, "renavam");
    const tipoCrv = optionalInventoryString(candidate, "tipoCrv");
    const registrationTime = optionalInventoryString(
      candidate,
      "dataHoraRegistroEntrada",
    );
    if (
      !Number.isSafeInteger(id) ||
      (id as number) <= 0 ||
      !evidence ||
      ids.has(id as number) ||
      typeof state !== "string" ||
      !STOCK_STATES.has(state as RenaveStockState) ||
      evidence.id !== id ||
      resultPlate(evidence.placa) !== plate ||
      evidence.estado !== state ||
      (tipoCrv !== undefined && !CRV_TYPES.has(tipoCrv as CrvType)) ||
      evidence.chassi !== chassi ||
      evidence.renavam !== renavam ||
      evidence.tipoCrv !== tipoCrv ||
      evidenceRegistrationTime(evidence) !== registrationTime
    ) {
      throw new StockQueryResultInvalidError();
    }
    ids.add(id as number);
    return Object.freeze({
      ...(chassi === undefined ? {} : { chassi }),
      ...(registrationTime === undefined
        ? {}
        : { dataHoraRegistroEntrada: registrationTime }),
      estado: state as RenaveStockState,
      id: id as number,
      placa: plate,
      ...(renavam === undefined ? {} : { renavam }),
      ...(tipoCrv === undefined ? {} : { tipoCrv: tipoCrv as CrvType }),
    });
  });

  return {
    evidence: result.evidence,
    publicResult: Object.freeze(publicResult),
  };
}

const DETAIL_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/u;

function optionalDetailText(
  value: unknown,
  pattern: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw new StockQueryResultInvalidError();
  }
  return value;
}

function detailMovementFromEvidence(
  value: unknown,
  includeReason = false,
):
  | { dataHora?: string; dataHoraRegistro?: string; motivo?: string }
  | undefined {
  if (value === undefined) return undefined;
  const source = recordObject(value);
  const dataHora = optionalDetailText(source.dataHora, DETAIL_DATE_TIME);
  const dataHoraRegistro = optionalDetailText(
    source.dataHoraRegistro,
    DETAIL_DATE_TIME,
  );
  const motivo = includeReason
    ? optionalDetailText(source.motivo, /^[A-Z0-9_]{1,80}$/u)
    : undefined;
  return Object.freeze({
    ...(dataHora === undefined ? {} : { dataHora }),
    ...(dataHoraRegistro === undefined ? {} : { dataHoraRegistro }),
    ...(motivo === undefined ? {} : { motivo }),
  });
}

function detailCancellationFromEvidence(
  value: unknown,
): { dataHora?: string; motivo?: string } | undefined {
  if (value === undefined) return undefined;
  const source = recordObject(value);
  const dataHora = optionalDetailText(
    source.dataHoraCancelamentoEstoque,
    DETAIL_DATE_TIME,
  );
  const motivo = optionalDetailText(
    source.motivoCancelamentoEstoque,
    /^[A-Z0-9_]{1,80}$/u,
  );
  return Object.freeze({
    ...(dataHora === undefined ? {} : { dataHora }),
    ...(motivo === undefined ? {} : { motivo }),
  });
}

function detailRestrictionsFromEvidence(
  value: unknown,
): StockDetail["restricoes"] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 256) {
    throw new StockQueryResultInvalidError();
  }
  return Object.freeze(
    value.map((item) => {
      const source = recordObject(item);
      const codigoTipo = optionalDetailText(
        source.codigoTipoRestricao,
        /^[A-Za-z0-9_.-]{1,64}$/u,
      );
      const tipo = optionalDetailText(source.tipoRestricao, /^.{1,256}$/u);
      return Object.freeze({
        ...(codigoTipo === undefined ? {} : { codigoTipo }),
        ...(tipo === undefined ? {} : { tipo }),
      });
    }),
  );
}

function rebuildStockDetail(
  result: StockDetailQueryResult,
  expectedId: number,
): { evidence: RenaveStockRecord; publicResult: StockDetail } {
  if (!result || typeof result !== "object") {
    throw new StockQueryResultInvalidError();
  }
  const evidence = recordObject(result.evidence);
  const id = evidence.id;
  const plate = resultPlate(evidence.placa);
  const state = evidence.estado;
  const chassi = optionalDetailText(evidence.chassi, /^[A-Z0-9]{3,64}$/u);
  const renavam = optionalDetailText(evidence.renavam, /^\d{9,11}$/u);
  const tipoCrv = optionalDetailText(evidence.tipoCrv, /^[A-Z]+$/u);
  if (
    id !== expectedId ||
    !Number.isSafeInteger(id) ||
    typeof state !== "string" ||
    !STOCK_STATES.has(state as RenaveStockState) ||
    (tipoCrv !== undefined && !CRV_TYPES.has(tipoCrv as CrvType)) ||
    (evidence.quilometragemHodometro !== undefined &&
      (!Number.isSafeInteger(evidence.quilometragemHodometro) ||
        (evidence.quilometragemHodometro as number) < 0 ||
        (evidence.quilometragemHodometro as number) > 2_147_483_647))
  ) {
    throw new StockQueryResultInvalidError();
  }
  const dataHoraMedicaoHodometro = optionalDetailText(
    evidence.dataHoraMedicaoHodometro,
    DETAIL_DATE_TIME,
  );
  const entrada = detailMovementFromEvidence(evidence.entradaEstoque);
  const saida = detailMovementFromEvidence(evidence.saidaEstoque, true);
  const cancelamento = detailCancellationFromEvidence(
    evidence.cancelamentoEstoque,
  );
  const expected = Object.freeze({
    ...(cancelamento === undefined ? {} : { cancelamento }),
    ...(chassi === undefined ? {} : { chassi }),
    ...(dataHoraMedicaoHodometro === undefined
      ? {}
      : { dataHoraMedicaoHodometro }),
    ...(entrada === undefined ? {} : { entrada }),
    estado: state as RenaveStockState,
    id: id as number,
    placa: plate,
    ...(evidence.quilometragemHodometro === undefined
      ? {}
      : { quilometragemHodometro: evidence.quilometragemHodometro as number }),
    ...(renavam === undefined ? {} : { renavam }),
    restricoes: detailRestrictionsFromEvidence(evidence.restricoesVeiculo),
    ...(saida === undefined ? {} : { saida }),
    ...(tipoCrv === undefined ? {} : { tipoCrv: tipoCrv as CrvType }),
  });
  if (canonicalize(result.publicResult) !== canonicalize(expected)) {
    throw new StockQueryResultInvalidError();
  }
  return { evidence: result.evidence, publicResult: expected };
}

type StockExitPreflightDecision =
  | {
      accepted: true;
      confirmation: StockExitPreflightConfirmation;
    }
  | { accepted: false };

interface StockQueryExecution<T> {
  auditContext: StockExitPreflightAuditContext;
  output: T;
}

function rebuildStockExitPreflight(
  result: StockDetailQueryResult,
  input: Pick<StockExitPreflightQueryInput, "stockId" | "vehicle">,
): { evidence: RenaveStockRecord; publicResult: StockExitPreflightDecision } {
  const detail = rebuildStockDetail(result, input.stockId);
  try {
    return {
      evidence: detail.evidence,
      publicResult: Object.freeze({
        accepted: true,
        confirmation: verifyStockExitPreflight(input, detail.evidence),
      }),
    };
  } catch (error) {
    if (!(error instanceof StockExitPreflightRejectedError)) throw error;
    return {
      evidence: detail.evidence,
      publicResult: Object.freeze({ accepted: false }),
    };
  }
}

export class StockQueryService {
  private readonly certificateThumbprintSha256: string;
  private readonly integratorCnpj: string;

  constructor(
    private readonly ports: StockQueryPorts,
    config: StockQueryServiceConfig,
  ) {
    if (!/^[0-9a-f]{64}$/.test(config.certificateThumbprintSha256)) {
      throw new StockQueryEvidenceError(
        "A impressão digital SHA-256 do certificado é inválida",
      );
    }
    this.certificateThumbprintSha256 = config.certificateThumbprintSha256;
    this.integratorCnpj = normalizeCnpj(config.integratorCnpj);
  }

  async execute(input: StockQueryInput): Promise<readonly StockSummary[]> {
    const plate = normalizedPlate(input.plate);
    const result = await this.executeQuery(
      input,
      { placa: plate },
      (context) => this.ports.connector.getStocksByPlate(context, plate),
      (result) => rebuildPublicResult(result, plate),
    );
    return result.output;
  }

  async executeRecent(
    input: StockInventoryQueryInput,
  ): Promise<readonly StockInventorySummary[]> {
    const result = await this.executeQuery(
      input,
      {},
      (context) => this.ports.connector.getRecentStocks(context),
      rebuildInventoryPublicResult,
    );
    return result.output;
  }

  async executeById(input: StockDetailQueryInput): Promise<StockDetail> {
    if (!Number.isSafeInteger(input.stockId) || input.stockId <= 0) {
      throw new InvalidStockQueryApplicationInputError("stockId");
    }
    const stockId = input.stockId;
    const result = await this.executeQuery(
      input,
      { stockId },
      (context) => this.ports.connector.getStockById(context, stockId),
      (result) => rebuildStockDetail(result, stockId),
    );
    return result.output;
  }

  async executeStockExitPreflight(
    input: StockExitPreflightQueryInput,
  ): Promise<StockExitPreflightConfirmation> {
    if (!Number.isSafeInteger(input.stockId) || input.stockId <= 0) {
      throw new InvalidStockQueryApplicationInputError("stockId");
    }
    const stockId = input.stockId;
    const vehicle = Object.freeze({ ...input.vehicle });
    const execution = await this.executeQuery(
      input,
      { stockId, vehicle },
      (context) => this.ports.connector.getStockById(context, stockId),
      (result) => rebuildStockExitPreflight(result, { stockId, vehicle }),
    );
    if (!execution.output.accepted) {
      throw new StockExitPreflightRejectedError(execution.auditContext);
    }
    return execution.output.confirmation;
  }

  private async executeQuery<TResult, TOutput>(
    input: StockInventoryQueryInput,
    request: StockQueryEvidenceContext["request"],
    query: (context: RenaveServerContext) => Promise<MutationResult<TResult>>,
    rebuild: (result: TResult) => {
      evidence: unknown;
      publicResult: TOutput;
    },
  ): Promise<StockQueryExecution<TOutput>> {
    const subject = requireText(input.subject, "subject");
    const tenantId = requireText(input.tenantId, "tenantId");
    const establishmentId = requireText(
      input.establishmentId,
      "establishmentId",
    );
    const actorIp = requireText(input.actorIp, "actorIp");
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
      { action: ACTION, establishmentId, tenantId },
    );
    if (!decision.allowed) throw new AuthorizationDeniedError(decision.reason);

    const establishment = await this.ports.establishments.load({
      establishmentId,
      tenantId,
    });
    if (!establishment) throw new EstablishmentUnavailableError("NOT_FOUND");
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
    const evidence = await this.ports.protectedEvidence.begin({
      action: ACTION,
      actorSubject: subject,
      establishmentId,
      request,
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
      requestSha256: sha256(request),
      tenantId,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    } as const;

    await this.ports.audit.append({ ...commonAudit, outcome: "attempted" });

    const context: RenaveServerContext = {
      environment: "homologation",
      establishmentCnpj,
      establishmentId,
      integratorCnpj: this.integratorCnpj,
      tenantId,
    };

    let response: MutationResult<TResult>;
    let validated: ReturnType<typeof rebuild>;
    try {
      response = await query(context);
      validateVerifiedIdentity(response, context);
      validated = rebuild(response.result);
    } catch (error) {
      await this.ports.finalization
        .fail({
          audit: { ...commonAudit, outcome: "rejected" },
          errorCode: stableErrorCode(error),
          payloadReference,
        })
        .catch(() => undefined);
      throw error;
    }

    await this.ports.finalization.succeed({
      audit: {
        ...commonAudit,
        cnpjConfirmed: response.verifiedIdentity.confirmedEstablishmentCnpj,
        integratorCnpjConfirmed:
          response.verifiedIdentity.confirmedIntegratorCnpj,
        outcome: "succeeded",
        responseSha256: sha256(validated.evidence),
      },
      evidenceResponse: validated.evidence,
      payloadReference,
    });
    return Object.freeze({
      auditContext: Object.freeze({
        certificateThumbprintSha256: this.certificateThumbprintSha256,
        cnpjSent: establishmentCnpj,
        payloadReference,
        requestSha256: commonAudit.requestSha256,
      }),
      output: validated.publicResult,
    });
  }
}
