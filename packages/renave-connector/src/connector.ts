import { normalizeCnpj } from "./cnpj.js";
import type {
  RenaveMutationOperation,
  RenaveStockState,
  RenaveVehicle,
  StockEntryRequest,
  StockEntryResponse,
  VehicleEligibilityQuery,
  VehicleEligibilityResponse,
} from "./operations.js";
import {
  assertRenaveMutationOperation,
  prepareRenaveMutation,
  type PreparedRenaveMutation,
} from "./mutation-request.js";
import { normalizeStockPlate } from "./plate.js";
import {
  InvalidStockEntryReconciliationError,
  reconcileStockEntry as reconcileStockEntryRecords,
  type RenaveStockRecord,
  type StockEntryReconciliation,
  type StockEntryReconciliationRequest,
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

export interface StockSummary {
  estado: RenaveStockState;
  id: number;
  placa: string;
}

export interface StockQueryResult {
  /** Resposta validada para persistência cifrada; nunca deve ser serializada pelo BFF. */
  evidence: readonly RenaveStockRecord[];
  publicResult: readonly StockSummary[];
}

export interface RenaveReadOptions {
  signal?: AbortSignal;
}

export type EstablishmentHeaders = Readonly<{
  "CNPJ-Estabelecimento": string;
}>;

export interface RenaveReadOnlyTransport {
  readonly environment: RenaveEnvironment;
  getAuthenticatedClient(
    headers: EstablishmentHeaders,
    options?: RenaveReadOptions,
  ): Promise<AuthenticatedClientIdentity>;
  findStocksByPlate(
    headers: EstablishmentHeaders,
    plate: string,
    options?: RenaveReadOptions,
  ): Promise<RenaveStockRecord[]>;
}

export interface RenaveVehicleLookupTransport {
  readonly environment: RenaveEnvironment;
  getAuthenticatedClient(
    headers: EstablishmentHeaders,
    options?: RenaveReadOptions,
  ): Promise<AuthenticatedClientIdentity>;
  getVehicleByPlate(
    headers: EstablishmentHeaders,
    plate: string,
    options?: RenaveReadOptions,
  ): Promise<RenaveVehicle>;
}

export interface RenaveQueryTransport extends RenaveReadOnlyTransport {
  getVehicleEligibility(
    headers: EstablishmentHeaders,
    query: VehicleEligibilityQuery,
  ): Promise<VehicleEligibilityResponse>;
}

export interface RenaveTransport extends RenaveQueryTransport {
  mutate<TResult>(
    headers: EstablishmentHeaders,
    prepared: PreparedRenaveMutation,
  ): Promise<TResult>;
}

interface RenaveVehicleLookupConnectorState {
  environment: RenaveEnvironment;
  getAuthenticatedClient: RenaveVehicleLookupTransport["getAuthenticatedClient"];
  getVehicleByPlate: RenaveVehicleLookupTransport["getVehicleByPlate"];
}

const vehicleLookupConnectorStates = new WeakMap<
  RenaveVehicleLookupConnector,
  RenaveVehicleLookupConnectorState
>();

export class InvalidVehiclePlateQueryError extends Error {
  readonly code = "INVALID_VEHICLE_PLATE_QUERY";

  constructor() {
    super("Informe uma placa RENAVE válida para consultar o veículo");
    this.name = "InvalidVehiclePlateQueryError";
  }
}

export class RenaveProtocolCapabilityError extends Error {
  readonly code = "RENAVE_CAPABILITY_INVALID";

  constructor() {
    super("A capacidade RENAVE fornecida é inválida");
    this.name = "RenaveProtocolCapabilityError";
  }
}

function normalizeVehiclePlate(value: unknown): string {
  if (typeof value !== "string") throw new InvalidVehiclePlateQueryError();
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(normalized)) {
    throw new InvalidVehiclePlateQueryError();
  }
  return normalized;
}

/** Capacidade nominal dedicada à consulta de Veiculo por placa. */
export class RenaveVehicleLookupConnector {
  constructor(transport: RenaveVehicleLookupTransport) {
    if (new.target !== RenaveVehicleLookupConnector) {
      throw new RenaveProtocolCapabilityError();
    }
    try {
      if (
        typeof transport.getAuthenticatedClient !== "function" ||
        typeof transport.getVehicleByPlate !== "function"
      ) {
        throw new RenaveProtocolCapabilityError();
      }
      vehicleLookupConnectorStates.set(this, {
        environment: transport.environment,
        getAuthenticatedClient:
          transport.getAuthenticatedClient.bind(transport),
        getVehicleByPlate: transport.getVehicleByPlate.bind(transport),
      });
      Object.freeze(this);
    } catch (error) {
      if (error instanceof RenaveProtocolCapabilityError) throw error;
      throw new RenaveProtocolCapabilityError();
    }
  }

  async getVehicleByPlate(
    context: RenaveServerContext,
    plate: string,
    options?: RenaveReadOptions,
  ): Promise<MutationResult<RenaveVehicle>> {
    const normalizedPlate = normalizeVehiclePlate(plate);
    const state = vehicleLookupConnectorStates.get(this);
    if (!state) throw new RenaveProtocolCapabilityError();
    const authorization = await authorizeRead(state, context, options);
    const result = await state.getVehicleByPlate(
      authorization.headers,
      normalizedPlate,
      options,
    );
    return { result, verifiedIdentity: authorization.verifiedIdentity };
  }
}

/** Conector para processos de consulta: não possui qualquer método de mutação. */
export class RenaveQueryConnector {
  constructor(private readonly transport: RenaveQueryTransport) {}

  private async authorize(context: RenaveServerContext): Promise<{
    headers: EstablishmentHeaders;
    verifiedIdentity: VerifiedRenaveIdentity;
  }> {
    return authorizeRead(this.transport, context);
  }

  async verifyIdentity(
    context: RenaveServerContext,
  ): Promise<VerifiedRenaveIdentity> {
    return (await this.authorize(context)).verifiedIdentity;
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

  async getStocksByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<StockQueryResult>> {
    const normalizedPlate = normalizeStockPlate(plate);
    const { headers, verifiedIdentity } = await this.authorize(context);
    const records = await this.transport.findStocksByPlate(
      headers,
      normalizedPlate,
    );
    const publicResult = records.map((record) =>
      stockSummaryFrom(record, normalizedPlate),
    );
    return {
      result: {
        evidence: Object.freeze(records),
        publicResult: Object.freeze(publicResult),
      },
      verifiedIdentity,
    };
  }
}

export type ReconciliationReadErrorCategory =
  "TRANSIENT" | "IDENTITY_MISMATCH" | "PROTOCOL" | "ABORTED";

export class RenaveReconciliationReadError extends Error {
  readonly code = "RENAVE_RECONCILIATION_READ_FAILED";

  override get name(): string {
    return "RenaveReconciliationReadError";
  }

  constructor(readonly category: ReconciliationReadErrorCategory) {
    super("A leitura de reconciliação RENAVE não pôde ser concluída");
  }
}

export type ReconciliationReadResult =
  | {
      observedAt: Date;
      outcome: "confirmed";
      remoteRecordId: number;
      remoteState: RenaveStockState;
    }
  | { observedAt: Date; outcome: "manual_review" }
  | { observedAt: Date; outcome: "not_observed" }
  | { observedAt: Date; outcome: "window_expired" };

export interface RenaveReconciliationReaderOptions {
  now: () => Date;
  transport: RenaveReadOnlyTransport;
}

interface RenaveReconciliationReaderState {
  environment: RenaveEnvironment;
  findStocksByPlate: RenaveReadOnlyTransport["findStocksByPlate"];
  getAuthenticatedClient: RenaveReadOnlyTransport["getAuthenticatedClient"];
  now: () => Date;
}

const reconciliationReaderStates = new WeakMap<
  RenaveReconciliationReader,
  RenaveReconciliationReaderState
>();

export interface MutationResult<TResult> {
  result: TResult;
  verifiedIdentity: VerifiedRenaveIdentity;
}

export interface MutationExecutionResult<
  TResult,
> extends MutationResult<TResult> {
  requestByteLength: number;
  requestSha256: string;
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

export class RenaveStockQueryResultError extends Error {
  readonly code = "RENAVE_STOCK_QUERY_RESULT_INVALID";

  constructor() {
    super("O RENAVE respondeu com um estoque incompatível com a consulta");
    this.name = "RenaveStockQueryResultError";
  }
}

const STOCK_STATES = new Set<RenaveStockState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);

function stockSummaryFrom(
  record: RenaveStockRecord,
  expectedPlate: string,
): StockSummary {
  let plate: string;
  try {
    plate = normalizeStockPlate(record.placa);
  } catch {
    throw new RenaveStockQueryResultError();
  }
  if (
    plate !== expectedPlate ||
    !Number.isSafeInteger(record.id) ||
    (record.id ?? 0) <= 0 ||
    !record.estado ||
    !STOCK_STATES.has(record.estado)
  ) {
    throw new RenaveStockQueryResultError();
  }
  return Object.freeze({ estado: record.estado, id: record.id!, placa: plate });
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

async function authorizeRead(
  transport: Pick<
    RenaveVehicleLookupTransport,
    "environment" | "getAuthenticatedClient"
  >,
  context: RenaveServerContext,
  options?: RenaveReadOptions,
): Promise<{
  headers: EstablishmentHeaders;
  verifiedIdentity: VerifiedRenaveIdentity;
}> {
  if (context.environment === "production") {
    throw new RenaveProductionBlockedError();
  }
  if (transport.environment !== context.environment) {
    throw new RenaveEnvironmentMismatchError();
  }
  const headers: EstablishmentHeaders = Object.freeze({
    "CNPJ-Estabelecimento": normalizeCnpj(context.establishmentCnpj),
  });
  const identity = options
    ? await transport.getAuthenticatedClient(headers, options)
    : await transport.getAuthenticatedClient(headers);
  return { headers, verifiedIdentity: verifyIdentity(context, identity) };
}

function errorMetadata(error: unknown): {
  code?: string;
  status?: number;
} {
  if (error !== null && typeof error === "object") {
    const candidate = error as { code?: unknown; status?: unknown };
    const code = candidate.code;
    const status = candidate.status;
    return {
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof status === "number" && Number.isInteger(status)
        ? { status }
        : {}),
    };
  }
  return {};
}

function sanitizedReadError(
  error: unknown,
  signal: AbortSignal | undefined,
): RenaveReconciliationReadError {
  if (signal?.aborted) return new RenaveReconciliationReadError("ABORTED");
  try {
    const metadata = errorMetadata(error);
    if (error instanceof RenaveIdentityMismatchError) {
      return new RenaveReconciliationReadError("IDENTITY_MISMATCH");
    }
    if (
      metadata.code === "RENAVE_HTTP_ERROR" &&
      (metadata.status === 401 || metadata.status === 403)
    ) {
      return new RenaveReconciliationReadError("IDENTITY_MISMATCH");
    }
    if (
      error instanceof RenaveStockQueryResultError ||
      error instanceof InvalidStockEntryReconciliationError ||
      error instanceof RenaveEnvironmentMismatchError ||
      error instanceof RenaveProductionBlockedError ||
      metadata.code === "RENAVE_PROTOCOL_ERROR" ||
      (metadata.code === "RENAVE_HTTP_ERROR" &&
        metadata.status !== undefined &&
        metadata.status !== 0 &&
        metadata.status !== 408 &&
        metadata.status !== 425 &&
        metadata.status !== 429 &&
        metadata.status < 500)
    ) {
      return new RenaveReconciliationReadError("PROTOCOL");
    }
  } catch {
    // Erros exóticos (incluindo Proxy hostil) também são fechados e sanitizados.
  }
  return new RenaveReconciliationReadError("TRANSIENT");
}

/** Capacidade nominal read-only; transporte e relógio ficam apenas no WeakMap. */
export class RenaveReconciliationReader {
  constructor(options: RenaveReconciliationReaderOptions) {
    if (new.target !== RenaveReconciliationReader) {
      throw new RenaveReconciliationReadError("PROTOCOL");
    }
    try {
      const transport = options.transport;
      const environment = transport.environment;
      const getAuthenticatedClient = transport.getAuthenticatedClient;
      const findStocksByPlate = transport.findStocksByPlate;
      const now = options.now;
      if (
        environment !== "homologation" ||
        typeof getAuthenticatedClient !== "function" ||
        typeof findStocksByPlate !== "function" ||
        typeof now !== "function"
      ) {
        throw new RenaveReconciliationReadError("PROTOCOL");
      }
      reconciliationReaderStates.set(this, {
        environment,
        findStocksByPlate: findStocksByPlate.bind(transport),
        getAuthenticatedClient: getAuthenticatedClient.bind(transport),
        now: now.bind(undefined),
      });
      Object.freeze(this);
    } catch (error) {
      if (error instanceof RenaveReconciliationReadError) throw error;
      throw new RenaveReconciliationReadError("PROTOCOL");
    }
  }

  async reconcileStockEntry(
    context: RenaveServerContext,
    request: StockEntryReconciliationRequest,
    window: Pick<StockEntryReconciliationWindow, "sentAt"> & RenaveReadOptions,
  ): Promise<ReconciliationReadResult> {
    return readRenaveReconciliation(this, context, request, window);
  }
}

export function isRenaveReconciliationReader(
  candidate: unknown,
): candidate is RenaveReconciliationReader {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    reconciliationReaderStates.has(candidate as RenaveReconciliationReader)
  );
}

/** Lê pelo estado nominal; não executa métodos sobrescrevíveis do reader. */
export async function readRenaveReconciliation(
  reader: RenaveReconciliationReader,
  context: RenaveServerContext,
  request: StockEntryReconciliationRequest,
  window: Pick<StockEntryReconciliationWindow, "sentAt"> & RenaveReadOptions,
): Promise<ReconciliationReadResult> {
  const state = reconciliationReaderStates.get(reader);
  if (!state) throw new RenaveReconciliationReadError("PROTOCOL");
  const signal = window.signal;
  try {
    if (signal?.aborted) {
      throw new RenaveReconciliationReadError("ABORTED");
    }
    if (context.environment === "production") {
      throw new RenaveProductionBlockedError();
    }
    if (context.environment !== state.environment) {
      throw new RenaveEnvironmentMismatchError();
    }
    const headers: EstablishmentHeaders = Object.freeze({
      "CNPJ-Estabelecimento": normalizeCnpj(context.establishmentCnpj),
    });
    const identity = await state.getAuthenticatedClient(headers, {
      ...(signal ? { signal } : {}),
    });
    verifyIdentity(context, identity);
    const records = await state.findStocksByPlate(
      headers,
      request.veiculo.placa,
      { ...(signal ? { signal } : {}) },
    );
    // A primeira instrução após o GET captura a fronteira de observação.
    const observedAt = state.now();
    if (
      !(observedAt instanceof Date) ||
      !Number.isFinite(observedAt.getTime()) ||
      !(window.sentAt instanceof Date) ||
      !Number.isFinite(window.sentAt.getTime()) ||
      observedAt.getTime() < window.sentAt.getTime()
    ) {
      throw new InvalidStockEntryReconciliationError("WINDOW");
    }
    const observedAtCopy = new Date(observedAt);
    if (observedAt.getTime() - window.sentAt.getTime() > 60 * 60 * 1_000) {
      return { observedAt: observedAtCopy, outcome: "window_expired" };
    }
    const result = reconcileStockEntryRecords(request, records, {
      observedAt,
      sentAt: window.sentAt,
    });
    if (result.outcome === "confirmed") {
      const matched = records.find(({ id }) => id === result.stockId);
      if (!matched?.estado || !STOCK_STATES.has(matched.estado)) {
        throw new RenaveStockQueryResultError();
      }
      return {
        observedAt: observedAtCopy,
        outcome: "confirmed",
        remoteRecordId: result.stockId,
        remoteState: matched.estado,
      };
    }
    return { observedAt: observedAtCopy, outcome: result.outcome };
  } catch (error) {
    try {
      if (error instanceof RenaveReconciliationReadError) throw error;
    } catch (candidate) {
      if (candidate === error) throw candidate;
    }
    throw sanitizedReadError(error, signal);
  }
}

Object.freeze(RenaveReconciliationReader.prototype);
Object.freeze(RenaveReconciliationReader);
Object.freeze(RenaveVehicleLookupConnector.prototype);
Object.freeze(RenaveVehicleLookupConnector);

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
    return authorizeRead(this.transport, context);
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
  ): Promise<MutationExecutionResult<TResult>> {
    assertRenaveMutationOperation(operation);
    // Autoriza antes de executar JSON.stringify/toJSON controlado pelo chamador.
    const authorization = await this.authorize(context);
    const prepared = await prepareRenaveMutation(operation, payload);
    return this.executeAuthorizedMutation(authorization, prepared);
  }

  async executePreparedMutation<TResult>(
    context: RenaveServerContext,
    prepared: PreparedRenaveMutation,
  ): Promise<MutationExecutionResult<TResult>> {
    // Não há cache autorizador: cada mutação confirma as duas identidades.
    const authorization = await this.authorize(context);
    return this.executeAuthorizedMutation(authorization, prepared);
  }

  private async executeAuthorizedMutation<TResult>(
    authorization: {
      headers: EstablishmentHeaders;
      verifiedIdentity: VerifiedRenaveIdentity;
    },
    prepared: PreparedRenaveMutation,
  ): Promise<MutationExecutionResult<TResult>> {
    const { headers, verifiedIdentity } = authorization;
    const result = await this.transport.mutate<TResult>(headers, prepared);

    return {
      requestByteLength: prepared.byteLength,
      requestSha256: prepared.requestSha256,
      result,
      verifiedIdentity,
    };
  }

  requestStockEntry(
    context: RenaveServerContext,
    payload: StockEntryRequest,
  ): Promise<MutationExecutionResult<StockEntryResponse>> {
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

  async getStocksByPlate(
    context: RenaveServerContext,
    plate: string,
  ): Promise<MutationResult<StockQueryResult>> {
    const normalizedPlate = normalizeStockPlate(plate);
    const { headers, verifiedIdentity } = await this.authorize(context);
    const records = await this.transport.findStocksByPlate(
      headers,
      normalizedPlate,
    );
    const publicResult = records.map((record) =>
      stockSummaryFrom(record, normalizedPlate),
    );
    return {
      result: {
        evidence: Object.freeze(records),
        publicResult: Object.freeze(publicResult),
      },
      verifiedIdentity,
    };
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
