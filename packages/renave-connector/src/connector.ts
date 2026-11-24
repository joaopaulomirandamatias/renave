import { normalizeCnpj } from "./cnpj.js";
import type {
  RenaveMutationOperation,
  StockEntryRequest,
  StockEntryResponse,
  VehicleEligibilityQuery,
  VehicleEligibilityResponse,
} from "./operations.js";
import {
  reconcileStockEntry as reconcileStockEntryRecords,
  type RenaveStockRecord,
  type StockEntryReconciliation,
  type StockEntryReconciliationWindow,
} from "./reconciliation.js";

export type RenaveEnvironment = "homologation" | "production";

export interface RenaveServerContext {
  environment: RenaveEnvironment;
  establishmentCnpj: string;
  establishmentId: string;
  integratorCnpj: string;
  tenantId: string;
}

export interface AuthenticatedClientIdentity {
  cnpj: string | null;
  cnpjIntegradora: string | null;
}

export interface VerifiedRenaveIdentity {
  confirmedEstablishmentCnpj: string;
  confirmedIntegratorCnpj: string;
  environment: RenaveEnvironment;
  establishmentId: string;
  tenantId: string;
}

export type EstablishmentHeaders = Readonly<{
  "CNPJ-Estabelecimento": string;
}>;

export interface RenaveTransport {
  readonly environment: RenaveEnvironment;
  getAuthenticatedClient(
    headers: EstablishmentHeaders,
  ): Promise<AuthenticatedClientIdentity>;
  getVehicleEligibility(
    headers: EstablishmentHeaders,
    query: VehicleEligibilityQuery,
  ): Promise<VehicleEligibilityResponse>;
  findStocksByPlate(
    headers: EstablishmentHeaders,
    plate: string,
  ): Promise<RenaveStockRecord[]>;
  mutate<TResult>(
    operation: RenaveMutationOperation,
    headers: EstablishmentHeaders,
    payload: unknown,
  ): Promise<TResult>;
}

export interface MutationResult<TResult> {
  result: TResult;
  verifiedIdentity: VerifiedRenaveIdentity;
}

export type IdentityMismatchReason =
  | "ESTABLISHMENT_MISSING"
  | "ESTABLISHMENT_MISMATCH"
  | "INTEGRATOR_MISSING"
  | "INTEGRATOR_MISMATCH";

export class RenaveIdentityMismatchError extends Error {
  readonly code = "RENAVE_IDENTITY_MISMATCH";

  constructor(readonly reason: IdentityMismatchReason) {
    super(
      "A identidade confirmada pelo RENAVE não corresponde ao contexto autorizado",
    );
    this.name = "RenaveIdentityMismatchError";
  }
}

export class RenaveEnvironmentMismatchError extends Error {
  readonly code = "RENAVE_ENVIRONMENT_MISMATCH";

  constructor() {
    super(
      "O ambiente do transporte RENAVE não corresponde ao contexto autorizado",
    );
    this.name = "RenaveEnvironmentMismatchError";
  }
}

export class RenaveProductionBlockedError extends Error {
  readonly code = "RENAVE_PRODUCTION_BLOCKED";

  constructor() {
    super(
      "Integração RENAVE em produção permanece bloqueada até confirmação formal do contrato de integradora",
    );
    this.name = "RenaveProductionBlockedError";
  }
}

export class InvalidVehicleEligibilityQueryError extends Error {
  readonly code = "INVALID_VEHICLE_ELIGIBILITY_QUERY";

  constructor(readonly reason: "IDENTIFIER_COUNT" | "IDENTIFIER_FORMAT") {
    super("Informe exatamente um identificador de veículo em formato válido");
    this.name = "InvalidVehicleEligibilityQueryError";
  }
}

function normalizeConfirmedCnpj(
  value: string | null,
  missingReason: IdentityMismatchReason,
  mismatchReason: IdentityMismatchReason,
): string {
  if (!value) throw new RenaveIdentityMismatchError(missingReason);
  try {
    return normalizeCnpj(value);
  } catch {
    throw new RenaveIdentityMismatchError(mismatchReason);
  }
}

function verifyIdentity(
  context: RenaveServerContext,
  identity: AuthenticatedClientIdentity,
): VerifiedRenaveIdentity {
  const expectedEstablishment = normalizeCnpj(context.establishmentCnpj);
  const expectedIntegrator = normalizeCnpj(context.integratorCnpj);
  const confirmedEstablishment = normalizeConfirmedCnpj(
    identity.cnpj,
    "ESTABLISHMENT_MISSING",
    "ESTABLISHMENT_MISMATCH",
  );
  const confirmedIntegrator = normalizeConfirmedCnpj(
    identity.cnpjIntegradora,
    "INTEGRATOR_MISSING",
    "INTEGRATOR_MISMATCH",
  );

  if (confirmedEstablishment !== expectedEstablishment) {
    throw new RenaveIdentityMismatchError("ESTABLISHMENT_MISMATCH");
  }
  if (confirmedIntegrator !== expectedIntegrator) {
    throw new RenaveIdentityMismatchError("INTEGRATOR_MISMATCH");
  }

  return {
    confirmedEstablishmentCnpj: confirmedEstablishment,
    confirmedIntegratorCnpj: confirmedIntegrator,
    environment: context.environment,
    establishmentId: context.establishmentId,
    tenantId: context.tenantId,
  };
}

function validateVehicleEligibilityQuery(
  query: VehicleEligibilityQuery,
): VehicleEligibilityQuery {
  const allowedCrvTypes = new Set(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);
  if (!allowedCrvTypes.has(query.tipoCrv)) {
    throw new InvalidVehicleEligibilityQueryError("IDENTIFIER_FORMAT");
  }
  const identifiers = [query.placa, query.renavam, query.numeroCrv].filter(
    (value): value is string => typeof value === "string",
  );
  const suppliedIdentifiers = [
    query.placa,
    query.renavam,
    query.numeroCrv,
  ].filter((value) => value !== undefined);
  if (identifiers.length !== 1 || suppliedIdentifiers.length !== 1) {
    throw new InvalidVehicleEligibilityQueryError("IDENTIFIER_COUNT");
  }

  const placa = query.placa?.trim().toUpperCase();
  const renavam = query.renavam?.trim();
  const numeroCrv = query.numeroCrv?.trim();
  if (
    (placa !== undefined && !/^[A-Z0-9]{7}$/.test(placa)) ||
    (renavam !== undefined && !/^\d{11}$/.test(renavam)) ||
    (numeroCrv !== undefined && !/^\d{12}$/.test(numeroCrv))
  ) {
    throw new InvalidVehicleEligibilityQueryError("IDENTIFIER_FORMAT");
  }

  return {
    ...(numeroCrv === undefined ? {} : { numeroCrv }),
    ...(placa === undefined ? {} : { placa }),
    ...(renavam === undefined ? {} : { renavam }),
    tipoCrv: query.tipoCrv,
  };
}

export class RenaveConnector {
  constructor(private readonly transport: RenaveTransport) {}

  private async authorize(context: RenaveServerContext): Promise<{
    headers: EstablishmentHeaders;
    verifiedIdentity: VerifiedRenaveIdentity;
  }> {
    if (context.environment === "production") {
      throw new RenaveProductionBlockedError();
    }
    if (this.transport.environment !== context.environment) {
      throw new RenaveEnvironmentMismatchError();
    }

    const headers: EstablishmentHeaders = Object.freeze({
      "CNPJ-Estabelecimento": normalizeCnpj(context.establishmentCnpj),
    });
    const identity = await this.transport.getAuthenticatedClient(headers);
    return { headers, verifiedIdentity: verifyIdentity(context, identity) };
  }

  /** Confirma o vínculo sem executar consulta veicular nem mutação. */
  async verifyIdentity(
    context: RenaveServerContext,
  ): Promise<VerifiedRenaveIdentity> {
    return (await this.authorize(context)).verifiedIdentity;
  }

  async executeMutation<TResult>(
    context: RenaveServerContext,
    operation: RenaveMutationOperation,
    payload: unknown,
  ): Promise<MutationResult<TResult>> {
    // Não há cache autorizador: cada mutação confirma as duas identidades.
    const { headers, verifiedIdentity } = await this.authorize(context);
    const result = await this.transport.mutate<TResult>(
      operation,
      headers,
      payload,
    );

    return { result, verifiedIdentity };
  }

  requestStockEntry(
    context: RenaveServerContext,
    payload: StockEntryRequest,
  ): Promise<MutationResult<StockEntryResponse>> {
    return this.executeMutation(context, "request-stock-entry", payload);
  }

  async getVehicleEligibility(
    context: RenaveServerContext,
    query: VehicleEligibilityQuery,
  ): Promise<MutationResult<VehicleEligibilityResponse>> {
    const validatedQuery = validateVehicleEligibilityQuery(query);
    const { headers, verifiedIdentity } = await this.authorize(context);
    const result = await this.transport.getVehicleEligibility(
      headers,
      validatedQuery,
    );

    return { result, verifiedIdentity };
  }

  async reconcileStockEntry(
    context: RenaveServerContext,
    request: StockEntryRequest,
    window: StockEntryReconciliationWindow,
  ): Promise<MutationResult<StockEntryReconciliation>> {
    const { headers, verifiedIdentity } = await this.authorize(context);
    const records = await this.transport.findStocksByPlate(
      headers,
      request.veiculo.placa.trim().toUpperCase(),
    );
    return {
      result: reconcileStockEntryRecords(request, records, window),
      verifiedIdentity,
    };
  }
}
