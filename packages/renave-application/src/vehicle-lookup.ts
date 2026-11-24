import { createHash } from "node:crypto";

import {
  authorize,
  AuthorizationDeniedError,
  type AuthorizationContext,
} from "@seu-renave/access-control";
import {
  normalizeCnpj,
  RenaveHttpError,
  type MutationResult,
  type RenaveServerContext,
  type RenaveStockRecord,
  type RenaveVehicle,
  type StockQueryResult,
} from "@seu-renave/renave-connector";

import {
  EstablishmentUnavailableError,
  type ApplicationEstablishment,
} from "./vehicle-eligibility.js";

const ACTION = "renave.vehicle.read" as const;

export interface VehicleLookupInput {
  actorIp: string;
  establishmentId: string;
  plate: string;
  subject: string;
  tenantId: string;
  traceId?: string;
}

export interface VehicleLookupAuthorizationContextPort {
  load(input: {
    subject: string;
    tenantId: string;
  }): Promise<AuthorizationContext | null>;
}

export interface VehicleLookupEstablishmentPort {
  load(input: {
    establishmentId: string;
    tenantId: string;
  }): Promise<ApplicationEstablishment | null>;
}

export interface VehicleLookupConnectorPort {
  getStocksByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<StockQueryResult>>;
  getVehicleByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<RenaveVehicle>>;
}

export interface VehicleLookupEvidenceContext {
  action: typeof ACTION;
  actorSubject: string;
  establishmentId: string;
  request: { placa: string };
  tenantId: string;
  traceId?: string;
}

export interface VehicleLookupEvidencePort {
  begin(
    context: VehicleLookupEvidenceContext,
  ): Promise<{ payloadReference: string }>;
}

export type VehicleLookupAuditOutcome = "attempted" | "rejected" | "succeeded";

export interface VehicleLookupAuditRecord {
  action: typeof ACTION;
  actorIp: string;
  actorSubject: string;
  certificateThumbprintSha256: string;
  cnpjConfirmed?: string;
  cnpjSent: string;
  establishmentId: string;
  integratorCnpjConfirmed?: string;
  outcome: VehicleLookupAuditOutcome;
  payloadReference: string;
  requestSha256: string;
  responseSha256?: string;
  tenantId: string;
  traceId?: string;
}

export interface VehicleLookupAuditPort {
  append(record: VehicleLookupAuditRecord): Promise<void>;
}

export interface VehicleLookupFinalizationPort {
  succeed(input: {
    audit: VehicleLookupAuditRecord;
    evidenceResponse: {
      stock: RenaveStockRecord;
      vehicle: RenaveVehicle;
    };
    payloadReference: string;
  }): Promise<void>;
  fail(input: {
    audit: VehicleLookupAuditRecord;
    errorCode: string;
    payloadReference: string;
  }): Promise<void>;
}

export interface VehicleLookupPorts {
  audit: VehicleLookupAuditPort;
  authorizationContexts: VehicleLookupAuthorizationContextPort;
  connector: VehicleLookupConnectorPort;
  establishments: VehicleLookupEstablishmentPort;
  finalization: VehicleLookupFinalizationPort;
  protectedEvidence: VehicleLookupEvidencePort;
}

export interface VehicleLookupServiceConfig {
  certificateThumbprintSha256: string;
  integratorCnpj: string;
}

export class InvalidVehicleLookupApplicationInputError extends Error {
  readonly code = "INVALID_VEHICLE_LOOKUP_APPLICATION_INPUT";

  constructor(readonly field: keyof VehicleLookupInput) {
    super("A consulta do veículo contém dados inválidos");
    this.name = "InvalidVehicleLookupApplicationInputError";
  }
}

export class VehicleLookupEvidenceError extends Error {
  readonly code = "VEHICLE_LOOKUP_EVIDENCE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "VehicleLookupEvidenceError";
  }
}

export class VehicleLookupVerifiedIdentityMismatchError extends Error {
  readonly code = "VEHICLE_LOOKUP_VERIFIED_IDENTITY_MISMATCH";

  constructor() {
    super("A identidade verificada não corresponde ao contexto autorizado");
    this.name = "VehicleLookupVerifiedIdentityMismatchError";
  }
}

export class VehicleLookupResultInvalidError extends Error {
  readonly code = "RENAVE_VEHICLE_LOOKUP_RESULT_INVALID";

  constructor() {
    super("O resultado da consulta do veículo é incompatível");
    this.name = "VehicleLookupResultInvalidError";
  }
}

export class VehicleNotAvailableError extends Error {
  readonly code = "VEHICLE_NOT_AVAILABLE";

  constructor() {
    super("O veículo não está disponível para consulta");
    this.name = "VehicleNotAvailableError";
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
    /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "RENAVE_CONNECTOR_ERROR";
}

function requireText(value: unknown, field: keyof VehicleLookupInput): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    throw new InvalidVehicleLookupApplicationInputError(field);
  }
  return value;
}

function normalizedPlate(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidVehicleLookupApplicationInputError("plate");
  }
  const plate = value.trim().toUpperCase();
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(plate)) {
    throw new InvalidVehicleLookupApplicationInputError("plate");
  }
  return plate;
}

function validatePayloadReference(reference: unknown): string {
  if (
    typeof reference !== "string" ||
    reference.trim().length === 0 ||
    reference.trim() !== reference
  ) {
    throw new VehicleLookupEvidenceError(
      "O armazenamento protegido não devolveu uma referência válida",
    );
  }
  return reference;
}

function validateVerifiedIdentity<T>(
  result: MutationResult<T>,
  expected: RenaveServerContext,
): void {
  const identity = result.verifiedIdentity;
  let confirmedEstablishment: string;
  let confirmedIntegrator: string;
  try {
    confirmedEstablishment = normalizeCnpj(identity.confirmedEstablishmentCnpj);
    confirmedIntegrator = normalizeCnpj(identity.confirmedIntegratorCnpj);
  } catch {
    throw new VehicleLookupVerifiedIdentityMismatchError();
  }
  if (
    identity.environment !== expected.environment ||
    identity.tenantId !== expected.tenantId ||
    identity.establishmentId !== expected.establishmentId ||
    confirmedEstablishment !== normalizeCnpj(expected.establishmentCnpj) ||
    confirmedIntegrator !== normalizeCnpj(expected.integratorCnpj)
  ) {
    throw new VehicleLookupVerifiedIdentityMismatchError();
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VehicleLookupResultInvalidError();
  }
  return value as Record<string, unknown>;
}

function requireSingleConfirmedStock(
  result: StockQueryResult,
  expectedPlate: string,
): RenaveStockRecord {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.evidence) ||
    !Array.isArray(result.publicResult) ||
    result.evidence.length !== result.publicResult.length
  ) {
    throw new VehicleLookupResultInvalidError();
  }
  if (result.evidence.length !== 1) throw new VehicleNotAvailableError();

  const evidence = recordObject(result.evidence[0]);
  const summary = recordObject(result.publicResult[0]);
  if (
    !Number.isSafeInteger(evidence.id) ||
    (evidence.id as number) <= 0 ||
    summary.id !== evidence.id ||
    evidence.placa !== expectedPlate ||
    summary.placa !== expectedPlate ||
    evidence.estado !== "CONFIRMADO" ||
    summary.estado !== "CONFIRMADO" ||
    evidence.cancelamentoEstoque !== undefined
  ) {
    throw new VehicleNotAvailableError();
  }
  return result.evidence[0] as RenaveStockRecord;
}

function sanitizedVehicle(
  source: RenaveVehicle,
  expectedPlate: string,
): RenaveVehicle {
  const vehicle = recordObject(source);
  if (vehicle.placa !== expectedPlate || !Array.isArray(vehicle.restricoes)) {
    throw new VehicleLookupResultInvalidError();
  }
  const restrictions = vehicle.restricoes.map((sourceRestriction) => {
    const restriction = recordObject(sourceRestriction);
    if (
      (restriction.codigoTipo !== undefined &&
        typeof restriction.codigoTipo !== "string") ||
      (restriction.tipo !== undefined && typeof restriction.tipo !== "string")
    ) {
      throw new VehicleLookupResultInvalidError();
    }
    return Object.freeze({
      ...(restriction.codigoTipo === undefined
        ? {}
        : { codigoTipo: restriction.codigoTipo }),
      ...(restriction.tipo === undefined ? {} : { tipo: restriction.tipo }),
    });
  });
  const chassi = vehicle.chassi;
  const dataPreCadastro = vehicle.dataPreCadastro;
  const renavam = vehicle.renavam;
  for (const value of [chassi, dataPreCadastro, renavam]) {
    if (value !== undefined && typeof value !== "string") {
      throw new VehicleLookupResultInvalidError();
    }
  }
  if (
    vehicle.veiculoAcabado !== undefined &&
    typeof vehicle.veiculoAcabado !== "boolean"
  ) {
    throw new VehicleLookupResultInvalidError();
  }
  return Object.freeze({
    ...(typeof chassi === "string" ? { chassi } : {}),
    ...(typeof dataPreCadastro === "string" ? { dataPreCadastro } : {}),
    placa: expectedPlate,
    ...(typeof renavam === "string" ? { renavam } : {}),
    restricoes: Object.freeze(restrictions),
    ...(vehicle.veiculoAcabado === undefined
      ? {}
      : { veiculoAcabado: vehicle.veiculoAcabado }),
  });
}

function publicError(error: unknown): unknown {
  return error instanceof RenaveHttpError &&
    (error.status === 404 || error.status === 422)
    ? new VehicleNotAvailableError()
    : error;
}

export class VehicleLookupService {
  private readonly certificateThumbprintSha256: string;
  private readonly integratorCnpj: string;

  constructor(
    private readonly ports: VehicleLookupPorts,
    config: VehicleLookupServiceConfig,
  ) {
    if (!/^[0-9a-f]{64}$/u.test(config.certificateThumbprintSha256)) {
      throw new VehicleLookupEvidenceError(
        "A impressão digital SHA-256 do certificado é inválida",
      );
    }
    this.certificateThumbprintSha256 = config.certificateThumbprintSha256;
    this.integratorCnpj = normalizeCnpj(config.integratorCnpj);
  }

  async execute(input: VehicleLookupInput): Promise<RenaveVehicle> {
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

    let confirmedStock: RenaveStockRecord;
    let vehicleResponse: MutationResult<RenaveVehicle>;
    let vehicle: RenaveVehicle;
    try {
      const stockResponse = await this.ports.connector.getStocksByPlate(
        context,
        plate,
      );
      validateVerifiedIdentity(stockResponse, context);
      confirmedStock = requireSingleConfirmedStock(stockResponse.result, plate);
      vehicleResponse = await this.ports.connector.getVehicleByPlate(
        context,
        plate,
      );
      validateVerifiedIdentity(vehicleResponse, context);
      vehicle = sanitizedVehicle(vehicleResponse.result, plate);
    } catch (cause) {
      const error = publicError(cause);
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
        cnpjConfirmed:
          vehicleResponse.verifiedIdentity.confirmedEstablishmentCnpj,
        integratorCnpjConfirmed:
          vehicleResponse.verifiedIdentity.confirmedIntegratorCnpj,
        outcome: "succeeded",
        responseSha256: sha256({ stock: confirmedStock, vehicle }),
      },
      evidenceResponse: { stock: confirmedStock, vehicle },
      payloadReference,
    });
    return vehicle;
  }
}
