import type {
  AuthenticatedClientIdentity,
  EstablishmentHeaders,
  RenaveEnvironment,
  RenaveReadOptions,
  RenaveReadOnlyTransport,
  RenaveTransport,
} from "./connector.js";
import { RenaveProductionBlockedError } from "./connector.js";
import {
  bindHomologationRenaveReadOnlyRequest,
  type HomologationRenaveReadOnlyRequest,
} from "./mtls-request.js";
import {
  renaveMutationRoutes,
  type RenaveMutationOperation,
  type VehicleEligibilityQuery,
  type VehicleEligibilityResponse,
} from "./operations.js";
import type { RenaveStockRecord } from "./reconciliation.js";
import { normalizeStockPlate } from "./plate.js";
import {
  copyPreparedRenaveMutationBody,
  type PreparedRenaveMutation,
} from "./mutation-request.js";

const baseUrls: Readonly<Record<RenaveEnvironment, string>> = Object.freeze({
  homologation: "https://hom.renave.estaleiro.serpro.gov.br/renave-ws",
  production: "https://renave.estaleiro.serpro.gov.br/renave-ws",
});

export type RenaveHttpRequest = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface HttpRenaveTransportOptions {
  environment: RenaveEnvironment;
  /** Cliente HTTP injetado pelo runtime e configurado com mTLS. */
  request: RenaveHttpRequest;
  /** @deprecated Prefira readTimeoutMs e mutationTimeoutMs. */
  timeoutMs?: number;
  readTimeoutMs?: number;
  mutationTimeoutMs?: number;
}

export interface HttpRenaveReadOnlyTransportOptions {
  environment: "homologation";
  request: HomologationRenaveReadOnlyRequest;
  readTimeoutMs?: number;
}

interface HttpRenaveTransportState {
  environment: RenaveEnvironment;
  mutationTimeoutMs: number;
  readTimeoutMs: number;
  request: RenaveHttpRequest;
}

const httpTransportStates = new WeakMap<
  HttpRenaveTransport,
  HttpRenaveTransportState
>();

interface HttpRenaveReadOnlyTransportState {
  readTimeoutMs: number;
  request: RenaveHttpRequest;
}

const httpReadOnlyTransportStates = new WeakMap<
  HttpRenaveReadOnlyTransport,
  HttpRenaveReadOnlyTransportState
>();

type RenaveHttpOperation =
  | "get-authenticated-client"
  | "get-vehicle-eligibility"
  | "find-stocks-by-plate"
  | RenaveMutationOperation;

const STOCK_STATES = new Set([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);
const CRV_TYPES = new Set(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);

export class RenaveHttpError extends Error {
  readonly code = "RENAVE_HTTP_ERROR";

  constructor(
    readonly status: number,
    readonly operation: RenaveHttpOperation,
  ) {
    super(`O RENAVE respondeu HTTP ${status}`);
    this.name = "RenaveHttpError";
  }
}

export class RenaveMutationOutcomeUnknownError extends Error {
  readonly code = "RENAVE_MUTATION_OUTCOME_UNKNOWN";

  constructor(
    readonly operation: RenaveMutationOperation,
    readonly requestSha256: string,
    readonly status?: number,
  ) {
    super(
      "O resultado da mutação RENAVE é incerto e deve ser reconciliado antes de qualquer reenvio",
    );
    this.name = "RenaveMutationOutcomeUnknownError";
  }
}

export class RenaveProtocolError extends Error {
  readonly code = "RENAVE_PROTOCOL_ERROR";

  constructor(readonly operation: RenaveHttpOperation) {
    super("O RENAVE respondeu em formato incompatível com o contrato esperado");
    this.name = "RenaveProtocolError";
  }
}

async function parseJson(
  response: Response,
  operation: RenaveHttpOperation,
): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RenaveProtocolError(operation);
  }
}

const ELIGIBILITY_BOOLEAN_FIELDS = [
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

function requireObject(
  value: unknown,
  operation: RenaveHttpOperation,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RenaveProtocolError(operation);
  }
  return value as Record<string, unknown>;
}

function validateOptionalStrings(
  value: Record<string, unknown>,
  fields: readonly string[],
  operation: RenaveHttpOperation,
): void {
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new RenaveProtocolError(operation);
    }
  }
}

function vehicleEligibilityFrom(value: unknown): VehicleEligibilityResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.comunicacaoComDetranFalhou !== undefined &&
    typeof candidate.comunicacaoComDetranFalhou !== "boolean"
  ) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
  if (
    ![
      "autorizacaoTransferencia",
      "comunicacaoComDetranFalhou",
      "diagnostico",
      "informacoesDebitos",
      "veiculo",
    ].some((field) => candidate[field] !== undefined)
  ) {
    throw new RenaveProtocolError("get-vehicle-eligibility");
  }
  if (candidate.diagnostico !== undefined) {
    const diagnosis = requireObject(
      candidate.diagnostico,
      "get-vehicle-eligibility",
    );
    for (const field of ELIGIBILITY_BOOLEAN_FIELDS) {
      if (
        diagnosis[field] !== undefined &&
        typeof diagnosis[field] !== "boolean"
      ) {
        throw new RenaveProtocolError("get-vehicle-eligibility");
      }
    }
    if (
      diagnosis.motivosParaNaoAptidao !== undefined &&
      (!Array.isArray(diagnosis.motivosParaNaoAptidao) ||
        diagnosis.motivosParaNaoAptidao.some(
          (reason) => typeof reason !== "string",
        ))
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }
  if (candidate.autorizacaoTransferencia !== undefined) {
    const authorization = requireObject(
      candidate.autorizacaoTransferencia,
      "get-vehicle-eligibility",
    );
    validateOptionalStrings(
      authorization,
      ["cpfOperadorResponsavelAutorizacao", "dataHoraAutorizacao"],
      "get-vehicle-eligibility",
    );
    if (authorization.estabelecimentoAutorizador !== undefined) {
      requireObject(
        authorization.estabelecimentoAutorizador,
        "get-vehicle-eligibility",
      );
    }
  }
  if (candidate.informacoesDebitos !== undefined) {
    const debts = requireObject(
      candidate.informacoesDebitos,
      "get-vehicle-eligibility",
    );
    if (
      debts.existemDebitos !== undefined &&
      typeof debts.existemDebitos !== "boolean"
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
    for (const field of [
      "valorDebitoDpvat",
      "valorDebitoIpva",
      "valorDebitoLicenciamento",
      "valorDebitoMultas",
      "valorTaxasEDebitosDiversos",
    ]) {
      if (
        debts[field] !== undefined &&
        (typeof debts[field] !== "number" ||
          !Number.isFinite(debts[field] as number))
      ) {
        throw new RenaveProtocolError("get-vehicle-eligibility");
      }
    }
    if (
      debts.codigosBancos !== undefined &&
      (!Array.isArray(debts.codigosBancos) ||
        debts.codigosBancos.some((code) => typeof code !== "string"))
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
    if (debts.boletos !== undefined && !Array.isArray(debts.boletos)) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }
  if (candidate.veiculo !== undefined) {
    const vehicle = requireObject(candidate.veiculo, "get-vehicle-eligibility");
    validateOptionalStrings(
      vehicle,
      ["chassi", "dataPreCadastro", "placa", "renavam"],
      "get-vehicle-eligibility",
    );
    if (
      vehicle.veiculoAcabado !== undefined &&
      typeof vehicle.veiculoAcabado !== "boolean"
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
    if (
      vehicle.restricoes !== undefined &&
      !Array.isArray(vehicle.restricoes)
    ) {
      throw new RenaveProtocolError("get-vehicle-eligibility");
    }
  }
  return candidate as VehicleEligibilityResponse;
}

function identityFrom(value: unknown): AuthenticatedClientIdentity {
  if (!value || typeof value !== "object") {
    return { cnpj: null, cnpjIntegradora: null };
  }

  const candidate = value as Record<string, unknown>;
  return {
    cnpj: typeof candidate.cnpj === "string" ? candidate.cnpj : null,
    cnpjIntegradora:
      typeof candidate.cnpjIntegradora === "string"
        ? candidate.cnpjIntegradora
        : null,
  };
}

function stockRecordFrom(value: unknown): RenaveStockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RenaveProtocolError("find-stocks-by-plate");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.id !== undefined &&
    (!Number.isSafeInteger(candidate.id) || (candidate.id as number) <= 0)
  ) {
    throw new RenaveProtocolError("find-stocks-by-plate");
  }
  if (candidate.placa !== undefined && typeof candidate.placa !== "string") {
    throw new RenaveProtocolError("find-stocks-by-plate");
  }
  validateOptionalStrings(
    candidate,
    ["codigoSegurancaCrv", "numeroCrv", "placa", "renavam", "tipoCrv"],
    "find-stocks-by-plate",
  );
  if (
    candidate.estado !== undefined &&
    (typeof candidate.estado !== "string" ||
      !STOCK_STATES.has(candidate.estado))
  ) {
    throw new RenaveProtocolError("find-stocks-by-plate");
  }
  if (
    candidate.tipoCrv !== undefined &&
    (typeof candidate.tipoCrv !== "string" || !CRV_TYPES.has(candidate.tipoCrv))
  ) {
    throw new RenaveProtocolError("find-stocks-by-plate");
  }

  let entradaEstoque: RenaveStockRecord["entradaEstoque"];
  if (candidate.entradaEstoque !== undefined) {
    if (
      !candidate.entradaEstoque ||
      typeof candidate.entradaEstoque !== "object" ||
      Array.isArray(candidate.entradaEstoque)
    ) {
      throw new RenaveProtocolError("find-stocks-by-plate");
    }
    const entry = candidate.entradaEstoque as Record<string, unknown>;
    for (const field of [
      "cpfOperadorResponsavel",
      "dataHora",
      "dataHoraRegistro",
    ]) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") {
        throw new RenaveProtocolError("find-stocks-by-plate");
      }
    }
    entradaEstoque = {
      ...(typeof entry.cpfOperadorResponsavel === "string"
        ? { cpfOperadorResponsavel: entry.cpfOperadorResponsavel }
        : {}),
      ...(typeof entry.dataHora === "string"
        ? { dataHora: entry.dataHora }
        : {}),
      ...(typeof entry.dataHoraRegistro === "string"
        ? { dataHoraRegistro: entry.dataHoraRegistro }
        : {}),
    };
  }

  return {
    ...candidate,
    ...(entradaEstoque === undefined ? {} : { entradaEstoque }),
    ...(candidate.cancelamentoEstoque === undefined
      ? {}
      : { cancelamentoEstoque: candidate.cancelamentoEstoque }),
    ...(typeof candidate.codigoSegurancaCrv === "string"
      ? { codigoSegurancaCrv: candidate.codigoSegurancaCrv }
      : {}),
    ...(typeof candidate.estado === "string"
      ? {
          estado: candidate.estado as NonNullable<RenaveStockRecord["estado"]>,
        }
      : {}),
    ...(typeof candidate.id === "number" ? { id: candidate.id } : {}),
    ...(typeof candidate.numeroCrv === "string"
      ? { numeroCrv: candidate.numeroCrv }
      : {}),
    ...(typeof candidate.placa === "string" ? { placa: candidate.placa } : {}),
    ...(typeof candidate.renavam === "string"
      ? { renavam: candidate.renavam }
      : {}),
    ...(typeof candidate.tipoCrv === "string"
      ? {
          tipoCrv: candidate.tipoCrv as NonNullable<
            RenaveStockRecord["tipoCrv"]
          >,
        }
      : {}),
  };
}

function stockEntryResultFrom(value: unknown): Record<string, unknown> {
  const candidate = requireObject(value, "request-stock-entry");
  if (!Number.isSafeInteger(candidate.id) || (candidate.id as number) <= 0) {
    throw new RenaveProtocolError("request-stock-entry");
  }
  if (
    typeof candidate.estado !== "string" ||
    !STOCK_STATES.has(candidate.estado)
  ) {
    throw new RenaveProtocolError("request-stock-entry");
  }
  validateOptionalStrings(
    candidate,
    ["numeroCrv", "placa", "renavam"],
    "request-stock-entry",
  );
  return candidate;
}

function mutationResultFrom(
  operation: RenaveMutationOperation,
  value: unknown,
): Record<string, unknown> {
  switch (operation) {
    case "request-stock-entry":
      return stockEntryResultFrom(value);
  }
}

export class HttpRenaveTransport implements RenaveTransport {
  constructor(options: HttpRenaveTransportOptions) {
    if (new.target !== HttpRenaveTransport) {
      throw new RenaveProtocolError("get-authenticated-client");
    }
    try {
      const environment = options.environment;
      const request = options.request;
      const timeoutMs = options.timeoutMs;
      const readTimeoutMs = options.readTimeoutMs ?? timeoutMs ?? 60_000;
      const mutationTimeoutMs =
        options.mutationTimeoutMs ?? timeoutMs ?? 120_000;
      if (
        (environment !== "homologation" && environment !== "production") ||
        typeof request !== "function" ||
        !Number.isInteger(readTimeoutMs) ||
        readTimeoutMs < 1 ||
        !Number.isInteger(mutationTimeoutMs) ||
        mutationTimeoutMs < 1
      ) {
        throw new RenaveProtocolError("get-authenticated-client");
      }
      httpTransportStates.set(this, {
        environment,
        mutationTimeoutMs,
        readTimeoutMs,
        request: request.bind(undefined),
      });
      Object.freeze(this);
    } catch (error) {
      if (error instanceof RenaveProtocolError) throw error;
      throw new RenaveProtocolError("get-authenticated-client");
    }
  }

  get environment(): RenaveEnvironment {
    return httpTransportState(this, "get-authenticated-client").environment;
  }

  async getAuthenticatedClient(
    headers: EstablishmentHeaders,
    options?: RenaveReadOptions,
  ): Promise<AuthenticatedClientIdentity> {
    const state = httpTransportState(this, "get-authenticated-client");
    let response: Response;
    try {
      response = await state.request(
        `${baseUrls[state.environment]}/api/cliente-autenticado`,
        {
          headers: { accept: "application/json", ...headers },
          method: "GET",
          redirect: "error",
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(state.readTimeoutMs),
              ])
            : AbortSignal.timeout(state.readTimeoutMs),
        },
      );
    } catch {
      throw new RenaveHttpError(0, "get-authenticated-client");
    }

    if (!response.ok) {
      throw new RenaveHttpError(response.status, "get-authenticated-client");
    }
    return identityFrom(await parseJson(response, "get-authenticated-client"));
  }

  async getVehicleEligibility(
    headers: EstablishmentHeaders,
    query: VehicleEligibilityQuery,
  ): Promise<VehicleEligibilityResponse> {
    const state = httpTransportState(this, "get-vehicle-eligibility");
    const search = new URLSearchParams({ tipoCrv: query.tipoCrv });
    if (query.placa !== undefined) search.set("placa", query.placa);
    if (query.renavam !== undefined) search.set("renavam", query.renavam);
    if (query.numeroCrv !== undefined) search.set("numeroCrv", query.numeroCrv);

    let response: Response;
    try {
      response = await state.request(
        `${baseUrls[state.environment]}/api/aptidao-veiculo-estoque?${search.toString()}`,
        {
          headers: { accept: "application/json", ...headers },
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(state.readTimeoutMs),
        },
      );
    } catch {
      throw new RenaveHttpError(0, "get-vehicle-eligibility");
    }

    if (!response.ok) {
      throw new RenaveHttpError(response.status, "get-vehicle-eligibility");
    }
    return vehicleEligibilityFrom(
      await parseJson(response, "get-vehicle-eligibility"),
    );
  }

  async findStocksByPlate(
    headers: EstablishmentHeaders,
    plate: string,
    options?: RenaveReadOptions,
  ): Promise<RenaveStockRecord[]> {
    const state = httpTransportState(this, "find-stocks-by-plate");
    const normalizedPlate = normalizeStockPlate(plate);
    const search = new URLSearchParams({ placa: normalizedPlate });
    let response: Response;
    try {
      response = await state.request(
        `${baseUrls[state.environment]}/api/estoques?${search.toString()}`,
        {
          headers: { accept: "application/json", ...headers },
          method: "GET",
          redirect: "error",
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(state.readTimeoutMs),
              ])
            : AbortSignal.timeout(state.readTimeoutMs),
        },
      );
    } catch {
      throw new RenaveHttpError(0, "find-stocks-by-plate");
    }

    if (!response.ok) {
      throw new RenaveHttpError(response.status, "find-stocks-by-plate");
    }
    const result = await parseJson(response, "find-stocks-by-plate");
    if (!Array.isArray(result)) {
      throw new RenaveProtocolError("find-stocks-by-plate");
    }
    return result.map(stockRecordFrom);
  }

  async mutate<TResult>(
    headers: EstablishmentHeaders,
    prepared: PreparedRenaveMutation,
  ): Promise<TResult> {
    const state = httpTransportState(this, "request-stock-entry");
    if (state.environment === "production") {
      throw new RenaveProductionBlockedError();
    }
    // Copiado antes do primeiro await e enviado sem nova serialização.
    const body = copyPreparedRenaveMutationBody(prepared);
    const { operation, requestSha256 } = prepared;
    const route = renaveMutationRoutes[operation];
    let response: Response;

    try {
      response = await state.request(
        `${baseUrls[state.environment]}${route.path}`,
        {
          body,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...headers,
          },
          method: route.method,
          redirect: "error",
          signal: AbortSignal.timeout(state.mutationTimeoutMs),
        },
      );
    } catch {
      throw new RenaveMutationOutcomeUnknownError(operation, requestSha256);
    }

    if (response.status >= 500) {
      throw new RenaveMutationOutcomeUnknownError(
        operation,
        requestSha256,
        response.status,
      );
    }
    if (!response.ok) {
      throw new RenaveHttpError(response.status, operation);
    }

    let result: unknown;
    try {
      result = await parseJson(response, operation);
    } catch {
      throw new RenaveMutationOutcomeUnknownError(
        operation,
        requestSha256,
        response.status,
      );
    }
    try {
      return mutationResultFrom(operation, result) as TResult;
    } catch {
      throw new RenaveMutationOutcomeUnknownError(
        operation,
        requestSha256,
        response.status,
      );
    }
  }
}

/** Transporte nominal que não possui superfícies de aptidão ou mutação. */
export class HttpRenaveReadOnlyTransport implements RenaveReadOnlyTransport {
  constructor(options: HttpRenaveReadOnlyTransportOptions) {
    if (new.target !== HttpRenaveReadOnlyTransport) {
      throw new RenaveProtocolError("get-authenticated-client");
    }
    try {
      const environment = options.environment;
      const readTimeoutMs = options.readTimeoutMs ?? 60_000;
      const request = bindHomologationRenaveReadOnlyRequest(options.request);
      if (
        environment !== "homologation" ||
        !Number.isInteger(readTimeoutMs) ||
        readTimeoutMs < 1
      ) {
        throw new RenaveProtocolError("get-authenticated-client");
      }
      httpReadOnlyTransportStates.set(this, { readTimeoutMs, request });
      Object.freeze(this);
    } catch (error) {
      if (error instanceof RenaveProtocolError) throw error;
      throw new RenaveProtocolError("get-authenticated-client");
    }
  }

  get environment(): "homologation" {
    httpReadOnlyTransportState(this, "get-authenticated-client");
    return "homologation";
  }

  async getAuthenticatedClient(
    headers: EstablishmentHeaders,
    options?: RenaveReadOptions,
  ): Promise<AuthenticatedClientIdentity> {
    const state = httpReadOnlyTransportState(this, "get-authenticated-client");
    let response: Response;
    try {
      response = await state.request(
        `${baseUrls.homologation}/api/cliente-autenticado`,
        {
          headers: { accept: "application/json", ...headers },
          method: "GET",
          redirect: "error",
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(state.readTimeoutMs),
              ])
            : AbortSignal.timeout(state.readTimeoutMs),
        },
      );
    } catch {
      throw new RenaveHttpError(0, "get-authenticated-client");
    }
    if (!response.ok) {
      throw new RenaveHttpError(response.status, "get-authenticated-client");
    }
    return identityFrom(await parseJson(response, "get-authenticated-client"));
  }

  async findStocksByPlate(
    headers: EstablishmentHeaders,
    plate: string,
    options?: RenaveReadOptions,
  ): Promise<RenaveStockRecord[]> {
    const state = httpReadOnlyTransportState(this, "find-stocks-by-plate");
    const normalizedPlate = normalizeStockPlate(plate);
    const search = new URLSearchParams({ placa: normalizedPlate });
    let response: Response;
    try {
      response = await state.request(
        `${baseUrls.homologation}/api/estoques?${search.toString()}`,
        {
          headers: { accept: "application/json", ...headers },
          method: "GET",
          redirect: "error",
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(state.readTimeoutMs),
              ])
            : AbortSignal.timeout(state.readTimeoutMs),
        },
      );
    } catch {
      throw new RenaveHttpError(0, "find-stocks-by-plate");
    }
    if (!response.ok) {
      throw new RenaveHttpError(response.status, "find-stocks-by-plate");
    }
    const result = await parseJson(response, "find-stocks-by-plate");
    if (!Array.isArray(result)) {
      throw new RenaveProtocolError("find-stocks-by-plate");
    }
    return result.map(stockRecordFrom);
  }
}

function httpTransportState(
  transport: HttpRenaveTransport,
  operation: RenaveHttpOperation,
): HttpRenaveTransportState {
  const state = httpTransportStates.get(transport);
  if (!state) throw new RenaveProtocolError(operation);
  return state;
}

function httpReadOnlyTransportState(
  transport: HttpRenaveReadOnlyTransport,
  operation: RenaveHttpOperation,
): HttpRenaveReadOnlyTransportState {
  const state = httpReadOnlyTransportStates.get(transport);
  if (!state) throw new RenaveProtocolError(operation);
  return state;
}

Object.freeze(HttpRenaveTransport.prototype);
Object.freeze(HttpRenaveTransport);
Object.freeze(HttpRenaveReadOnlyTransport.prototype);
Object.freeze(HttpRenaveReadOnlyTransport);
