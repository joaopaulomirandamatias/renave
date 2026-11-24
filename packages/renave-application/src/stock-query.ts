import { createHash } from "node:crypto";

import {
  authorize,
  AuthorizationDeniedError,
  type AuthorizationContext,
} from "@seu-renave/access-control";
import {
  normalizeCnpj,
  type MutationResult,
  type RenaveServerContext,
  type RenaveStockRecord,
  type RenaveStockState,
  type StockQueryResult,
  type StockSummary,
} from "@seu-renave/renave-connector";

import {
  EstablishmentUnavailableError,
  type ApplicationEstablishment,
} from "./vehicle-eligibility.js";

const ACTION = "renave.stock.read" as const;
const STOCK_STATES = new Set<RenaveStockState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);

export interface StockQueryInput {
  actorIp: string;
  establishmentId: string;
  plate: string;
  subject: string;
  tenantId: string;
  traceId?: string;
}

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
  getStocksByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<StockQueryResult>>;
}

export interface StockQueryEvidenceContext {
  action: typeof ACTION;
  actorSubject: string;
  establishmentId: string;
  request: { placa: string };
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
    evidenceResponse: readonly RenaveStockRecord[];
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

  constructor(readonly field: keyof StockQueryInput) {
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
    reference.trim().length === 0 ||
    reference.trim() !== reference
  ) {
    throw new StockQueryEvidenceError(
      "O armazenamento protegido não devolveu uma referência válida",
    );
  }
  return reference;
}

function validateVerifiedIdentity(
  result: MutationResult<StockQueryResult>,
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
    const subject = requireText(input.subject, "subject");
    const tenantId = requireText(input.tenantId, "tenantId");
    const establishmentId = requireText(
      input.establishmentId,
      "establishmentId",
    );
    const actorIp = requireText(input.actorIp, "actorIp");
    const plate = normalizedPlate(input.plate);
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
    const request = { placa: plate } as const;
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

    let response: MutationResult<StockQueryResult>;
    let validated: ReturnType<typeof rebuildPublicResult>;
    try {
      response = await this.ports.connector.getStocksByPlate(context, plate);
      validateVerifiedIdentity(response, context);
      validated = rebuildPublicResult(response.result, plate);
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
    return validated.publicResult;
  }
}
