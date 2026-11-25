import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  createOrReplayHeldLocalStockExitOperation,
  type CreateHeldLocalOperationInput,
  type CreateHeldLocalStockExitOperationInput,
  type CreateOperationResult,
  type TenantClient,
} from "@seu-renave/db/api-runtime";
import type { AuthenticatedSession } from "@seu-renave/identity";
import {
  type DecryptedRenavePrincipal,
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  type RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import {
  prepareStockExitRequest,
  type OwnerDocumentType,
  type PreparedRenaveMutation,
  type StockExitRequest,
} from "@seu-renave/renave-connector";
import type { FastifyInstance } from "fastify";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";
import { buildCreateOperationInput } from "./operation-request-builder.js";
import type {
  ResolvedVerifiedRenavePrincipals,
  StockEntryRuntimeKeyGenerationChecker,
  VerifiedRenavePrincipalResolver,
} from "./stock-entry-operations.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PLATE = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u;
const CPF = /^\d{11}$/u;
const CNPJ = /^[0-9A-Z]{12}\d{2}$/u;
const CEP = /^\d{8}$/u;
const SECURITY_CODE = /^\d{11}$/u;
const CRV_NUMBER = /^\d{12}$/u;
const RENAVAM = /^\d{11}$/u;
const KEY_GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DOCUMENT_TYPES = new Set<OwnerDocumentType>(["CPF", "CNPJ"]);
const MAX_SALE_VALUE = 99_999_999.99;
const MAX_MUNICIPALITY_CODE = 2_147_483_647;
const FIRST_CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export const DEFAULT_STOCK_EXIT_BUSINESS_TIME_ZONE = "America/Sao_Paulo";

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

export interface StockExitBusinessInput {
  comprador: {
    email: string;
    endereco: {
      bairro: string;
      cep: string;
      codigoMunicipio: number;
      complemento?: string;
      logradouro: string;
      numero: string;
    };
    nome: string;
    numeroDocumento: string;
    tipoDocumento: OwnerDocumentType;
  };
  dataVenda: string;
  stockId: number;
  valorVenda: number;
  veiculo: {
    codigoSegurancaCrv: string;
    numeroCrv: string;
    placa: string;
    renavam: string;
  };
}

export interface StockExitMunicipalityCatalog {
  contains(client: TenantClient, municipalityCode: number): Promise<boolean>;
}

export interface StockExitPreflightPort {
  verify(input: {
    actorIp: string;
    establishmentId: string;
    stockId: number;
    subject: string;
    tenantId: string;
    traceId: string;
    vehicle: StockExitBusinessInput["veiculo"];
  }): Promise<{ remoteStockId: number }>;
}

export interface StockExitOperationResult {
  createdAt: Date;
  operationId: string;
  replayed: boolean;
  status: "HELD_LOCAL";
}

export interface StockExitOperationUseCase {
  destroy?(): void;
  authorize(input: {
    establishmentId: string;
    session: AuthenticatedSession;
    tenantId: string;
  }): Promise<void>;
  execute(input: {
    actorIp: string;
    business: StockExitBusinessInput;
    establishmentId: string;
    idempotencyKey: string;
    now: Date;
    session: AuthenticatedSession;
    tenantId: string;
    traceId: string;
  }): Promise<StockExitOperationResult>;
}

export interface StockExitMutationRateLimiter {
  acquire(input: {
    subject: string;
    tenantId: string;
  }): Promise<
    { allowed: true } | { allowed: false; retryAfterSeconds: number }
  >;
}

export class StockExitOperationError extends Error {
  readonly code: string;

  constructor(
    code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("A operação local de saída de estoque não pôde ser criada.");
    this.name = "StockExitOperationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function calendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const reconstructed = new Date(Date.UTC(year, month - 1, day));
  return (
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day
  );
}

function cpfDigit(base: string, factor: number): number {
  let total = 0;
  for (const character of base) {
    total += Number(character) * factor;
    factor -= 1;
  }
  const remainder = (total * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function validCpf(value: string): boolean {
  return (
    CPF.test(value) &&
    !/^(\d)\1{10}$/u.test(value) &&
    cpfDigit(value.slice(0, 9), 10) === Number(value[9]) &&
    cpfDigit(value.slice(0, 10), 11) === Number(value[10])
  );
}

function cnpjDigit(values: readonly number[], weights: readonly number[]) {
  const total = values.reduce(
    (sum, value, index) => sum + value * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function validCnpj(value: string): boolean {
  if (!CNPJ.test(value) || /^(\d)\1{13}$/u.test(value)) return false;
  const base = [...value.slice(0, 12)].map(
    (character) => character.charCodeAt(0) - 48,
  );
  const first = cnpjDigit(base, FIRST_CNPJ_WEIGHTS);
  const second = cnpjDigit([...base, first], SECOND_CNPJ_WEIGHTS);
  return `${first}${second}` === value.slice(12);
}

function createBusinessDateFormatter(timeZone: string): (date: Date) => string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      calendar: "iso8601",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
    });
  } catch {
    throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
  }
  return (date) => {
    if (!Number.isFinite(date.getTime())) {
      throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
    }
    const parts = new Map(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const result = `${parts.get("year") ?? ""}-${parts.get("month") ?? ""}-${parts.get("day") ?? ""}`;
    if (!calendarDate(result)) {
      throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
    }
    return result;
  };
}

/** Valida somente campos comerciais; identidade do operador fica fora do corpo. */
export function parseStockExitBusinessInput(
  value: unknown,
  businessDate: string,
): StockExitBusinessInput | undefined {
  if (!isRecord(value) || !calendarDate(businessDate)) return undefined;
  if (
    !exactKeys(value, [
      "comprador",
      "dataVenda",
      "stockId",
      "valorVenda",
      "veiculo",
    ]) ||
    typeof value.dataVenda !== "string" ||
    !calendarDate(value.dataVenda) ||
    value.dataVenda > businessDate ||
    !Number.isSafeInteger(value.stockId) ||
    (value.stockId as number) < 1 ||
    typeof value.valorVenda !== "number" ||
    !Number.isFinite(value.valorVenda) ||
    value.valorVenda <= 0 ||
    value.valorVenda > MAX_SALE_VALUE ||
    Math.round(value.valorVenda * 100) < 1 ||
    Math.abs(value.valorVenda - Math.round(value.valorVenda * 100) / 100) >
      1e-9 ||
    !isRecord(value.comprador) ||
    !isRecord(value.veiculo)
  ) {
    return undefined;
  }
  const buyer = value.comprador;
  if (
    !exactKeys(buyer, [
      "email",
      "endereco",
      "nome",
      "numeroDocumento",
      "tipoDocumento",
    ]) ||
    !text(buyer.email, 254) ||
    !EMAIL.test(buyer.email) ||
    !text(buyer.nome, 40) ||
    typeof buyer.tipoDocumento !== "string" ||
    !DOCUMENT_TYPES.has(buyer.tipoDocumento as OwnerDocumentType) ||
    typeof buyer.numeroDocumento !== "string" ||
    (buyer.tipoDocumento === "CPF" && !validCpf(buyer.numeroDocumento)) ||
    (buyer.tipoDocumento === "CNPJ" && !validCnpj(buyer.numeroDocumento)) ||
    !isRecord(buyer.endereco)
  ) {
    return undefined;
  }
  const address = buyer.endereco;
  if (
    !exactKeys(
      address,
      ["bairro", "cep", "codigoMunicipio", "logradouro", "numero"],
      ["complemento"],
    ) ||
    !text(address.bairro, 200) ||
    typeof address.cep !== "string" ||
    !CEP.test(address.cep) ||
    !Number.isInteger(address.codigoMunicipio) ||
    (address.codigoMunicipio as number) <= 0 ||
    (address.codigoMunicipio as number) > MAX_MUNICIPALITY_CODE ||
    !text(address.logradouro, 200) ||
    !text(address.numero, 30) ||
    (address.complemento !== undefined && !text(address.complemento, 200))
  ) {
    return undefined;
  }
  const vehicle = value.veiculo;
  if (
    !exactKeys(vehicle, [
      "codigoSegurancaCrv",
      "numeroCrv",
      "placa",
      "renavam",
    ]) ||
    typeof vehicle.codigoSegurancaCrv !== "string" ||
    !SECURITY_CODE.test(vehicle.codigoSegurancaCrv) ||
    typeof vehicle.numeroCrv !== "string" ||
    !CRV_NUMBER.test(vehicle.numeroCrv) ||
    typeof vehicle.placa !== "string" ||
    !PLATE.test(vehicle.placa) ||
    typeof vehicle.renavam !== "string" ||
    !RENAVAM.test(vehicle.renavam)
  ) {
    return undefined;
  }
  return {
    comprador: {
      email: buyer.email,
      endereco: {
        bairro: address.bairro,
        cep: address.cep,
        codigoMunicipio: address.codigoMunicipio as number,
        ...(typeof address.complemento === "string"
          ? { complemento: address.complemento }
          : {}),
        logradouro: address.logradouro,
        numero: address.numero,
      },
      nome: buyer.nome,
      numeroDocumento: buyer.numeroDocumento,
      tipoDocumento: buyer.tipoDocumento as OwnerDocumentType,
    },
    dataVenda: value.dataVenda,
    stockId: value.stockId as number,
    valorVenda: value.valorVenda,
    veiculo: {
      codigoSegurancaCrv: vehicle.codigoSegurancaCrv,
      numeroCrv: vehicle.numeroCrv,
      placa: vehicle.placa,
      renavam: vehicle.renavam,
    },
  };
}

interface DigestKeys {
  actor: Uint8Array;
  idempotency: Uint8Array;
  vehicle: Uint8Array;
}

interface RuntimeKeyGeneration {
  fingerprint: Uint8Array;
  generationId: string;
}

function copyDigestKeys(source: DigestKeys): {
  actor: Buffer;
  idempotency: Buffer;
  vehicle: Buffer;
} {
  const keys = [source.actor, source.idempotency, source.vehicle];
  if (
    keys.some((key) => !(key instanceof Uint8Array) || key.byteLength !== 32)
  ) {
    throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
  }
  const copies = keys.map((key) => Buffer.from(key));
  if (
    timingSafeEqual(copies[0]!, copies[1]!) ||
    timingSafeEqual(copies[0]!, copies[2]!) ||
    timingSafeEqual(copies[1]!, copies[2]!)
  ) {
    for (const copy of copies) copy.fill(0);
    throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
  }
  return { actor: copies[0]!, idempotency: copies[1]!, vehicle: copies[2]! };
}

function copyKeyGeneration(source: RuntimeKeyGeneration): {
  fingerprint: Buffer;
  generationId: string;
} {
  if (
    !source ||
    !(source.fingerprint instanceof Uint8Array) ||
    source.fingerprint.byteLength !== 32 ||
    typeof source.generationId !== "string" ||
    !KEY_GENERATION_ID.test(source.generationId)
  ) {
    throw new StockExitOperationError("STOCK_EXIT_OPERATION_NOT_CONFIGURED");
  }
  return {
    fingerprint: Buffer.from(source.fingerprint),
    generationId: source.generationId,
  };
}

function hmac(key: Buffer, purpose: string, fields: readonly string[]): Buffer {
  return createHmac("sha256", key)
    .update(JSON.stringify([`seu-renave-${purpose}-v1`, ...fields]))
    .digest();
}

function decodeSecret(secret: DecryptedRenavePrincipal): {
  bytes: Buffer;
  value: string;
} {
  const bytes = secret.copyUtf8Bytes();
  try {
    return {
      bytes,
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    bytes.fill(0);
    throw new StockExitOperationError("STOCK_EXIT_PRINCIPALS_UNAVAILABLE");
  }
}

function zeroPrincipals(
  principals: ResolvedVerifiedRenavePrincipals | undefined,
) {
  for (const principal of [principals?.operator, principals?.establishment]) {
    if (!principal) continue;
    principal.envelope.aadSha256.fill(0);
    principal.envelope.authTag.fill(0);
    principal.envelope.ciphertext.fill(0);
    principal.envelope.hmac.digest.fill(0);
    principal.envelope.nonce.fill(0);
  }
}

type BuildOperation = typeof buildCreateOperationInput;

export class PostgresHeldStockExitOperation implements StockExitOperationUseCase {
  private readonly digestKeys: ReturnType<typeof copyDigestKeys>;
  private readonly keyGeneration: ReturnType<typeof copyKeyGeneration>;
  private destroyed = false;

  constructor(
    private readonly options: {
      buildOperation?: BuildOperation;
      createOperation?: typeof createOrReplayHeldLocalStockExitOperation;
      digestKeys: DigestKeys;
      environment: "homologation";
      keyGeneration: RuntimeKeyGeneration;
      keyGenerationChecker: StockEntryRuntimeKeyGenerationChecker;
      municipalityCatalog: StockExitMunicipalityCatalog;
      preflight: StockExitPreflightPort;
      principalCrypto: RenavePrincipalCrypto;
      projectionCipher: OperationReconciliationProjectionCipher;
      requestCipher: OperationRequestCipher;
      resolver: VerifiedRenavePrincipalResolver;
      runner: TenantActionRunner;
    },
  ) {
    this.digestKeys = copyDigestKeys(options.digestKeys);
    try {
      this.keyGeneration = copyKeyGeneration(options.keyGeneration);
    } catch (error) {
      this.digestKeys.actor.fill(0);
      this.digestKeys.idempotency.fill(0);
      this.digestKeys.vehicle.fill(0);
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.digestKeys.actor.fill(0);
    this.digestKeys.idempotency.fill(0);
    this.digestKeys.vehicle.fill(0);
    this.keyGeneration.fingerprint.fill(0);
    this.destroyed = true;
  }

  async authorize(input: {
    establishmentId: string;
    session: AuthenticatedSession;
    tenantId: string;
  }): Promise<void> {
    const result = await this.options.runner.run(
      {
        action: "renave.stock-exit.request",
        establishmentId: input.establishmentId,
        mfa: "required",
        session: input.session,
        tenantId: input.tenantId,
      },
      async () => undefined,
    );
    if (!result.allowed) {
      throw new StockExitOperationError(
        result.reason === "MFA_REQUIRED"
          ? "MFA_REQUIRED"
          : "STOCK_EXIT_RESOURCE_NOT_FOUND",
      );
    }
  }

  async execute(input: {
    actorIp: string;
    business: StockExitBusinessInput;
    establishmentId: string;
    idempotencyKey: string;
    now: Date;
    session: AuthenticatedSession;
    tenantId: string;
    traceId: string;
  }): Promise<StockExitOperationResult> {
    if (this.destroyed) {
      throw new StockExitOperationError("STOCK_EXIT_OPERATION_UNAVAILABLE");
    }
    await this.authorize({
      establishmentId: input.establishmentId,
      session: input.session,
      tenantId: input.tenantId,
    });
    let confirmation: { remoteStockId: number };
    try {
      confirmation = await this.options.preflight.verify({
        actorIp: input.actorIp,
        establishmentId: input.establishmentId,
        stockId: input.business.stockId,
        subject: input.session.subject,
        tenantId: input.tenantId,
        traceId: input.traceId,
        vehicle: { ...input.business.veiculo },
      });
    } catch (error) {
      const code = safeCode(error);
      if (code === "STOCK_EXIT_PREFLIGHT_REJECTED") {
        throw new StockExitOperationError(code);
      }
      if (code === "STOCK_EXIT_PREFLIGHT_LIMITED") {
        const retryAfterSeconds = safeRetryAfterSeconds(error);
        if (retryAfterSeconds !== undefined) {
          throw new StockExitOperationError(code, retryAfterSeconds);
        }
      }
      throw new StockExitOperationError("STOCK_EXIT_PREFLIGHT_UNAVAILABLE");
    }
    if (
      !confirmation ||
      !Number.isSafeInteger(confirmation.remoteStockId) ||
      confirmation.remoteStockId !== input.business.stockId
    ) {
      throw new StockExitOperationError("STOCK_EXIT_PREFLIGHT_REJECTED");
    }
    const result = await this.options.runner.run(
      {
        action: "renave.stock-exit.request",
        establishmentId: input.establishmentId,
        mfa: "required",
        session: input.session,
        tenantId: input.tenantId,
      },
      async ({ client }) =>
        await this.createWithinTransaction(
          client,
          input,
          confirmation.remoteStockId,
        ),
    );
    if (!result.allowed) {
      throw new StockExitOperationError(
        result.reason === "MFA_REQUIRED"
          ? "MFA_REQUIRED"
          : "STOCK_EXIT_RESOURCE_NOT_FOUND",
      );
    }
    return result.value;
  }

  private async createWithinTransaction(
    client: TenantClient,
    input: Parameters<StockExitOperationUseCase["execute"]>[0],
    remoteStockId: number,
  ): Promise<StockExitOperationResult> {
    let principals: ResolvedVerifiedRenavePrincipals | undefined;
    let operatorSecret: DecryptedRenavePrincipal | undefined;
    let establishmentSecret: DecryptedRenavePrincipal | undefined;
    let operator: ReturnType<typeof decodeSecret> | undefined;
    let establishment: ReturnType<typeof decodeSecret> | undefined;
    let prepared: PreparedRenaveMutation | undefined;
    let actorDigest: Buffer | undefined;
    let idempotencyDigest: Buffer | undefined;
    let vehicleDigest: Buffer | undefined;
    let operationInput: CreateHeldLocalOperationInput | undefined;
    let fingerprint: Buffer | undefined;
    try {
      fingerprint = Buffer.from(this.keyGeneration.fingerprint);
      await this.options.keyGenerationChecker.assert(client, {
        fingerprint,
        generationId: this.keyGeneration.generationId,
      });
      fingerprint.fill(0);
      fingerprint = undefined;
      if (
        !(await this.options.municipalityCatalog.contains(
          client,
          input.business.comprador.endereco.codigoMunicipio,
        ))
      ) {
        throw new StockExitOperationError("INVALID_STOCK_EXIT_MUNICIPALITY");
      }
      idempotencyDigest = hmac(
        this.digestKeys.idempotency,
        "stock-exit-idempotency",
        [
          input.tenantId,
          input.establishmentId,
          input.session.subject,
          input.idempotencyKey,
        ],
      );
      principals = await this.options.resolver.resolve(client, {
        establishmentId: input.establishmentId,
        idempotencyKeyDigest: idempotencyDigest,
        subject: input.session.subject,
      });
      if (
        !UUID.test(principals.operator.binding.profileId) ||
        !/^[1-9]\d*$/u.test(principals.operator.binding.profileVersion) ||
        !UUID.test(principals.establishment.binding.profileId) ||
        !/^[1-9]\d*$/u.test(principals.establishment.binding.profileVersion)
      ) {
        throw new StockExitOperationError("STOCK_EXIT_PRINCIPALS_UNAVAILABLE");
      }
      operatorSecret = this.options.principalCrypto.decrypt(
        principals.operator.envelope,
        principals.operator.binding,
      );
      establishmentSecret = this.options.principalCrypto.decrypt(
        principals.establishment.envelope,
        principals.establishment.binding,
      );
      operator = decodeSecret(operatorSecret);
      establishment = decodeSecret(establishmentSecret);
      const { stockId: _stockId, ...businessRequest } = input.business;
      const request: StockExitRequest = {
        ...businessRequest,
        cpfOperadorResponsavel: operator.value,
        emailEstabelecimento: establishment.value,
      };
      prepared = await prepareStockExitRequest(request, { now: input.now });
      actorDigest = hmac(this.digestKeys.actor, "stock-exit-actor", [
        input.tenantId,
        input.session.subject,
      ]);
      vehicleDigest = hmac(this.digestKeys.vehicle, "stock-exit-vehicle", [
        input.tenantId,
        input.business.veiculo.placa,
        input.business.veiculo.renavam,
        input.business.veiculo.numeroCrv,
      ]);
      operationInput = (
        this.options.buildOperation ?? buildCreateOperationInput
      )(this.options.requestCipher, this.options.projectionCipher, {
        actorSubjectHash: actorDigest,
        correlationId: randomUUID(),
        environment: this.options.environment,
        establishmentId: input.establishmentId,
        establishmentProfileId: principals.establishment.binding.profileId,
        establishmentProfileVersion:
          principals.establishment.binding.profileVersion,
        idempotencyKeyDigest: idempotencyDigest,
        operatorProfileId: principals.operator.binding.profileId,
        operatorProfileVersion: principals.operator.binding.profileVersion,
        prepared,
        subject: input.session.subject,
        tenantId: input.tenantId,
        vehicleKeyDigest: vehicleDigest,
      });
      prepared = undefined;
      const stockExitOperationInput: CreateHeldLocalStockExitOperationInput = {
        ...operationInput,
        kind: "USED_STOCK_EXIT",
        mutationFamily: "STOCK_EXIT",
        reconciliationProjectionKind: "STOCK_EXIT_RECONCILIATION",
        remoteStockId,
      };
      const result: CreateOperationResult = await (
        this.options.createOperation ??
        createOrReplayHeldLocalStockExitOperation
      )(client, stockExitOperationInput);
      if (
        result.operation.status !== "HELD_LOCAL" ||
        result.operation.kind !== "USED_STOCK_EXIT" ||
        result.operation.mutationFamily !== "STOCK_EXIT"
      ) {
        throw new StockExitOperationError("STOCK_EXIT_OPERATION_UNAVAILABLE");
      }
      return {
        createdAt: result.operation.createdAt,
        operationId: result.operation.id,
        replayed: result.replayed,
        status: "HELD_LOCAL",
      };
    } catch (error) {
      if (error instanceof StockExitOperationError) throw error;
      const code = safeCode(error);
      if (
        code === "OperationActiveConflictError" ||
        code === "OperationIdempotencyConflictError" ||
        code === "OperationCredentialLinkNotEnabledError"
      ) {
        throw new StockExitOperationError("STOCK_EXIT_OPERATION_CONFLICT");
      }
      if (
        code === "RenavePrincipalDecryptionError" ||
        code === "RenavePrincipalResolutionStorageError" ||
        code === "RenavePrincipalResolutionUnavailableError"
      ) {
        throw new StockExitOperationError("STOCK_EXIT_PRINCIPALS_UNAVAILABLE");
      }
      throw new StockExitOperationError("STOCK_EXIT_OPERATION_UNAVAILABLE");
    } finally {
      prepared?.destroy();
      operator?.bytes.fill(0);
      establishment?.bytes.fill(0);
      operatorSecret?.destroy();
      establishmentSecret?.destroy();
      zeroPrincipals(principals);
      actorDigest?.fill(0);
      idempotencyDigest?.fill(0);
      vehicleDigest?.fill(0);
      fingerprint?.fill(0);
      if (operationInput) {
        operationInput.actorSubjectHash.fill(0);
        operationInput.idempotencyKeyDigest.fill(0);
        operationInput.requestAuthTag.fill(0);
        operationInput.requestCiphertext.fill(0);
        operationInput.requestNonce.fill(0);
        operationInput.requestSha256.fill(0);
        operationInput.vehicleKeyDigest.fill(0);
        operationInput.reconciliationProjectionAuthTag.fill(0);
        operationInput.reconciliationProjectionCiphertext.fill(0);
        operationInput.reconciliationProjectionNonce.fill(0);
      }
    }
  }
}

function safeCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name !== "Error") return error.name;
  return undefined;
}

function safeRetryAfterSeconds(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryAfterSeconds" in error) ||
    !Number.isSafeInteger(error.retryAfterSeconds) ||
    (error.retryAfterSeconds as number) < 1
  ) {
    return undefined;
  }
  return error.retryAfterSeconds as number;
}

function mapError(error: unknown): {
  code: string;
  retryAfterSeconds?: number;
  status: 400 | 403 | 404 | 409 | 429 | 500 | 503;
} {
  const code = safeCode(error);
  if (code === "INVALID_STOCK_EXIT_MUNICIPALITY") {
    return { code, status: 400 };
  }
  if (code === "MFA_REQUIRED") return { code, status: 403 };
  if (code === "STOCK_EXIT_RESOURCE_NOT_FOUND") {
    return { code, status: 404 };
  }
  if (
    code === "OperationActiveConflictError" ||
    code === "OperationIdempotencyConflictError" ||
    code === "OperationCredentialLinkNotEnabledError" ||
    code === "STOCK_EXIT_OPERATION_CONFLICT" ||
    code === "STOCK_EXIT_PREFLIGHT_REJECTED"
  ) {
    return {
      code:
        code === "STOCK_EXIT_PREFLIGHT_REJECTED"
          ? code
          : "STOCK_EXIT_OPERATION_CONFLICT",
      status: 409,
    };
  }
  if (
    code === "STOCK_EXIT_PRINCIPALS_UNAVAILABLE" ||
    code === "STOCK_EXIT_OPERATION_UNAVAILABLE" ||
    code === "STOCK_EXIT_PREFLIGHT_UNAVAILABLE"
  ) {
    return { code, status: 503 };
  }
  if (code === "STOCK_EXIT_PREFLIGHT_LIMITED") {
    const retryAfterSeconds = safeRetryAfterSeconds(error);
    return retryAfterSeconds === undefined
      ? { code: "STOCK_EXIT_PREFLIGHT_UNAVAILABLE", status: 503 }
      : { code, retryAfterSeconds, status: 429 };
  }
  return { code: "INTERNAL_ERROR", status: 500 };
}

export function registerStockExitOperationRoute(
  app: FastifyInstance,
  options: {
    accessGuard: RequestAccessGuard;
    businessTimeZone?: string;
    clock?: Clock;
    mutationRateLimiter?: StockExitMutationRateLimiter;
    operation?: StockExitOperationUseCase;
    publicOrigin: string;
  },
): void {
  const formatBusinessDate = createBusinessDateFormatter(
    options.businessTimeZone ?? DEFAULT_STOCK_EXIT_BUSINESS_TIME_ZONE,
  );
  app.post(
    "/api/tenants/:tenantId/establishments/:establishmentId/stock-exit-operations",
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      if (request.headers.origin !== options.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const session = await options.accessGuard.authenticate(request, reply, {
        mfa: "required",
      });
      if (!session.ok) return;
      const params = request.params as Record<string, unknown>;
      if (
        typeof params.tenantId !== "string" ||
        typeof params.establishmentId !== "string" ||
        !UUID.test(params.tenantId) ||
        !UUID.test(params.establishmentId)
      ) {
        return reply.code(404).send({ code: "STOCK_EXIT_RESOURCE_NOT_FOUND" });
      }
      const tenantId = params.tenantId.toLowerCase();
      const establishmentId = params.establishmentId.toLowerCase();
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) {
        return reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY" });
      }
      const now = (options.clock ?? systemClock).now();
      const business = parseStockExitBusinessInput(
        request.body,
        formatBusinessDate(now),
      );
      if (!business) {
        return reply.code(400).send({ code: "INVALID_STOCK_EXIT_INPUT" });
      }
      if (!options.operation || !options.mutationRateLimiter) {
        return reply
          .code(503)
          .send({ code: "STOCK_EXIT_OPERATION_NOT_CONFIGURED" });
      }
      try {
        await options.operation.authorize({
          establishmentId,
          session: session.session,
          tenantId,
        });
      } catch (error) {
        const mapped = mapError(error);
        return reply.code(mapped.status).send({ code: mapped.code });
      }
      let rateLimit;
      try {
        rateLimit = await options.mutationRateLimiter.acquire({
          subject: session.session.subject,
          tenantId,
        });
      } catch {
        return reply
          .code(503)
          .send({ code: "STOCK_EXIT_RATE_LIMIT_UNAVAILABLE" });
      }
      if (!rateLimit.allowed) {
        if (
          !Number.isInteger(rateLimit.retryAfterSeconds) ||
          rateLimit.retryAfterSeconds < 1
        ) {
          return reply
            .code(503)
            .send({ code: "STOCK_EXIT_RATE_LIMIT_UNAVAILABLE" });
        }
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ code: "STOCK_EXIT_RATE_LIMITED" });
      }
      try {
        const result = await options.operation.execute({
          actorIp: request.ip,
          business,
          establishmentId,
          idempotencyKey: idempotencyKey.toLowerCase(),
          now,
          session: session.session,
          tenantId,
          traceId: request.id,
        });
        if (result.replayed) reply.header("idempotency-replayed", "true");
        return reply.code(result.replayed ? 200 : 202).send({
          createdAt: result.createdAt.toISOString(),
          operationId: result.operationId,
          replayed: result.replayed,
          status: "HELD_LOCAL",
        });
      } catch (error) {
        const mapped = mapError(error);
        if (mapped.retryAfterSeconds !== undefined) {
          reply.header("retry-after", String(mapped.retryAfterSeconds));
        }
        request.log.error({
          errorCode: mapped.code,
          event: "renave.stock_exit_operation.failed",
          traceId: request.id,
        });
        return reply.code(mapped.status).send({ code: mapped.code });
      }
    },
  );
}
