import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  assertStockEntryRuntimeKeyGeneration,
  createOrReplayHeldLocalOperation,
  resolveVerifiedRenavePrincipals,
  type CreateOperationInput,
  type CreateOperationResult,
  type TenantClient,
} from "@seu-renave/db/api-runtime";
import type { AuthenticatedSession } from "@seu-renave/identity";
import {
  type DecryptedRenavePrincipal,
  OperationReconciliationProjectionCipher,
  OperationRequestCipher,
  type ProtectedRenavePrincipal,
  type RenavePrincipalBinding,
  RenavePrincipalCrypto,
} from "@seu-renave/protected-evidence";
import {
  prepareRenaveMutation,
  type CrvType,
  type OwnerDocumentType,
  type PreparedRenaveMutation,
  type StockEntryRequest,
} from "@seu-renave/renave-connector";
import type { FastifyInstance } from "fastify";

import type {
  RequestAccessGuard,
  TenantActionRunner,
} from "../auth/request-access-guard.js";
import { buildCreateOperationInput } from "./operation-request-builder.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const OFFSET_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const EMAIL = /^[-A-Za-z0-9_.]+@[-A-Za-z0-9_]+\.[-A-Za-z0-9_.]+$/u;
const PLATE = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u;
const CPF = /^\d{11}$/u;
const CNPJ = /^[A-Za-z0-9]{12}\d{2}$/u;
const SECURITY_CODE = /^\d{11}$/u;
const CRV_NUMBER = /^\d{12}$/u;
const RENAVAM = /^\d{11}$/u;
const KEY_GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CRV_TYPES = new Set<CrvType>(["AZUL", "VERDE", "BRANCO", "DIGITAL"]);
const OWNER_DOCUMENT_TYPES = new Set<OwnerDocumentType>(["CPF", "CNPJ"]);
const MAX_PURCHASE_VALUE = 99_999_999.99;
const MAX_ODOMETER = 2_147_483_647;
export const DEFAULT_STOCK_ENTRY_BUSINESS_TIME_ZONE = "America/Sao_Paulo";

const systemClock: Clock = {
  now: () => new Date(),
};

export interface Clock {
  now(): Date;
}

export interface StockEntryBusinessTime {
  businessDate: string;
  now: Date;
}

function createBusinessDateFormatter(
  timeZone: string,
): (instant: Date) => string {
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
    throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_NOT_CONFIGURED");
  }
  return (instant) => {
    if (!Number.isFinite(instant.getTime())) {
      throw new StockEntryOperationError(
        "STOCK_ENTRY_OPERATION_NOT_CONFIGURED",
      );
    }
    const fields = new Map(
      formatter
        .formatToParts(instant)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const year = fields.get("year");
    const month = fields.get("month");
    const day = fields.get("day");
    const result = `${year ?? ""}-${month ?? ""}-${day ?? ""}`;
    if (!isCalendarDate(result)) {
      throw new StockEntryOperationError(
        "STOCK_ENTRY_OPERATION_NOT_CONFIGURED",
      );
    }
    return result;
  };
}

export function stockEntryBusinessTime(
  instant: Date,
  timeZone = DEFAULT_STOCK_ENTRY_BUSINESS_TIME_ZONE,
): StockEntryBusinessTime {
  return {
    businessDate: createBusinessDateFormatter(timeZone)(instant),
    now: instant,
  };
}

export interface StockEntryBusinessInput {
  dataCompra: string;
  emailVendedor: string;
  valorCompra: number;
  veiculo: {
    codigoSegurancaCrv: string;
    dataHoraMedicaoHodometro: string;
    documentoProprietarioAtual: string;
    numeroCrv?: string;
    placa: string;
    quilometragemHodometro: number;
    renavam?: string;
    tipoCrv: CrvType;
    tipoDocumentoProprietarioAtual: OwnerDocumentType;
  };
}

export interface ResolvedPrincipal {
  binding: RenavePrincipalBinding;
  envelope: ProtectedRenavePrincipal;
}

export interface ResolvedVerifiedRenavePrincipals {
  establishment: ResolvedPrincipal;
  operator: ResolvedPrincipal;
}

export interface VerifiedRenavePrincipalResolver {
  resolve(
    client: TenantClient,
    input: {
      establishmentId: string;
      idempotencyKeyDigest: Buffer;
      subject: string;
    },
  ): Promise<ResolvedVerifiedRenavePrincipals>;
}

/** Adapter estrutural para o resolver atômico do banco, sem alargar a rota. */
export const databaseVerifiedRenavePrincipalResolver: VerifiedRenavePrincipalResolver =
  Object.freeze({ resolve: resolveVerifiedRenavePrincipals });

export interface StockEntryRuntimeKeyGenerationChecker {
  assert(
    client: TenantClient,
    input: { fingerprint: Uint8Array; generationId: string },
  ): Promise<void>;
}

export const databaseStockEntryRuntimeKeyGenerationChecker: StockEntryRuntimeKeyGenerationChecker =
  Object.freeze({ assert: assertStockEntryRuntimeKeyGeneration });

export interface StockEntryOperationResult {
  createdAt: Date;
  operationId: string;
  replayed: boolean;
  status: "HELD_LOCAL";
}

export interface StockEntryOperationUseCase {
  /** Zera material de chave process-lifetime no encerramento ordenado. */
  destroy?(): void;
  authorize(input: {
    establishmentId: string;
    session: AuthenticatedSession;
    tenantId: string;
  }): Promise<void>;
  execute(input: {
    business: StockEntryBusinessInput;
    establishmentId: string;
    idempotencyKey: string;
    session: AuthenticatedSession;
    tenantId: string;
    traceId: string;
  }): Promise<StockEntryOperationResult>;
}

export interface StockEntryMutationRateLimiter {
  acquire(input: {
    subject: string;
    tenantId: string;
  }): Promise<
    { allowed: true } | { allowed: false; retryAfterSeconds: number }
  >;
}

export class StockEntryOperationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("A operação local de entrada de estoque não pôde ser criada.");
    this.name = "StockEntryOperationError";
    this.code = code;
  }
}

function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isOffsetDateTime(value: string, now: Date): boolean {
  const match = OFFSET_DATE_TIME.exec(value);
  if (!match || !isCalendarDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] !== "Z") {
    const offset = match[5]!;
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

export function parseStockEntryBusinessInput(
  value: unknown,
  time: StockEntryBusinessTime,
): StockEntryBusinessInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "dataCompra",
      "emailVendedor",
      "valorCompra",
      "veiculo",
    ]) ||
    typeof record.dataCompra !== "string" ||
    !isCalendarDate(record.dataCompra) ||
    !isCalendarDate(time.businessDate) ||
    record.dataCompra > time.businessDate ||
    typeof record.emailVendedor !== "string" ||
    record.emailVendedor.length > 254 ||
    !EMAIL.test(record.emailVendedor) ||
    typeof record.valorCompra !== "number" ||
    !Number.isFinite(record.valorCompra) ||
    record.valorCompra <= 0 ||
    record.valorCompra > MAX_PURCHASE_VALUE ||
    typeof record.veiculo !== "object" ||
    record.veiculo === null ||
    Array.isArray(record.veiculo)
  ) {
    return undefined;
  }
  const vehicle = record.veiculo as Record<string, unknown>;
  if (
    !exactKeys(
      vehicle,
      [
        "codigoSegurancaCrv",
        "dataHoraMedicaoHodometro",
        "documentoProprietarioAtual",
        "placa",
        "quilometragemHodometro",
        "tipoCrv",
        "tipoDocumentoProprietarioAtual",
      ],
      ["numeroCrv", "renavam"],
    ) ||
    typeof vehicle.codigoSegurancaCrv !== "string" ||
    !SECURITY_CODE.test(vehicle.codigoSegurancaCrv) ||
    typeof vehicle.dataHoraMedicaoHodometro !== "string" ||
    !isOffsetDateTime(vehicle.dataHoraMedicaoHodometro, time.now) ||
    typeof vehicle.documentoProprietarioAtual !== "string" ||
    typeof vehicle.placa !== "string" ||
    !PLATE.test(vehicle.placa) ||
    typeof vehicle.quilometragemHodometro !== "number" ||
    !Number.isInteger(vehicle.quilometragemHodometro) ||
    vehicle.quilometragemHodometro < 0 ||
    vehicle.quilometragemHodometro > MAX_ODOMETER ||
    typeof vehicle.tipoCrv !== "string" ||
    !CRV_TYPES.has(vehicle.tipoCrv as CrvType) ||
    typeof vehicle.tipoDocumentoProprietarioAtual !== "string" ||
    !OWNER_DOCUMENT_TYPES.has(
      vehicle.tipoDocumentoProprietarioAtual as OwnerDocumentType,
    ) ||
    (vehicle.tipoDocumentoProprietarioAtual === "CPF" &&
      !CPF.test(vehicle.documentoProprietarioAtual)) ||
    (vehicle.tipoDocumentoProprietarioAtual === "CNPJ" &&
      !CNPJ.test(vehicle.documentoProprietarioAtual)) ||
    (Object.hasOwn(vehicle, "numeroCrv") &&
      (typeof vehicle.numeroCrv !== "string" ||
        !CRV_NUMBER.test(vehicle.numeroCrv))) ||
    (Object.hasOwn(vehicle, "renavam") &&
      (typeof vehicle.renavam !== "string" || !RENAVAM.test(vehicle.renavam)))
  ) {
    return undefined;
  }
  return {
    dataCompra: record.dataCompra,
    emailVendedor: record.emailVendedor,
    valorCompra: record.valorCompra,
    veiculo: {
      codigoSegurancaCrv: vehicle.codigoSegurancaCrv,
      dataHoraMedicaoHodometro: vehicle.dataHoraMedicaoHodometro,
      documentoProprietarioAtual: vehicle.documentoProprietarioAtual,
      placa: vehicle.placa,
      quilometragemHodometro: vehicle.quilometragemHodometro,
      tipoCrv: vehicle.tipoCrv as CrvType,
      tipoDocumentoProprietarioAtual:
        vehicle.tipoDocumentoProprietarioAtual as OwnerDocumentType,
      ...(typeof vehicle.numeroCrv === "string"
        ? { numeroCrv: vehicle.numeroCrv }
        : {}),
      ...(typeof vehicle.renavam === "string"
        ? { renavam: vehicle.renavam }
        : {}),
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

function copyRuntimeKeyGeneration(source: RuntimeKeyGeneration): {
  fingerprint: Buffer;
  generationId: string;
} {
  if (
    !source ||
    typeof source.generationId !== "string" ||
    !KEY_GENERATION_ID.test(source.generationId) ||
    !(source.fingerprint instanceof Uint8Array) ||
    source.fingerprint.byteLength !== 32
  ) {
    throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_NOT_CONFIGURED");
  }
  return {
    fingerprint: Buffer.from(source.fingerprint),
    generationId: source.generationId,
  };
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
    throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_NOT_CONFIGURED");
  }
  const copies = keys.map((key) => Buffer.from(key));
  if (
    timingSafeEqual(copies[0]!, copies[1]!) ||
    timingSafeEqual(copies[0]!, copies[2]!) ||
    timingSafeEqual(copies[1]!, copies[2]!)
  ) {
    for (const copy of copies) copy.fill(0);
    throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_NOT_CONFIGURED");
  }
  return { actor: copies[0]!, idempotency: copies[1]!, vehicle: copies[2]! };
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
    throw new StockEntryOperationError("STOCK_ENTRY_PRINCIPALS_UNAVAILABLE");
  }
}

function zeroResolvedPrincipal(principal: ResolvedPrincipal | undefined): void {
  if (!principal) return;
  principal.envelope.aadSha256.fill(0);
  principal.envelope.authTag.fill(0);
  principal.envelope.ciphertext.fill(0);
  principal.envelope.hmac.digest.fill(0);
  principal.envelope.nonce.fill(0);
}

/**
 * Possui somente as cópias das três chaves de digest e do fingerprint da
 * geração fixada no banco.
 * `principalCrypto`, `requestCipher` e `projectionCipher` são empréstimos: o
 * compositor deve destruí-los, nessa ordem de ciclo de vida, apenas depois de
 * fechar todos os casos de uso que possam compartilhá-los.
 */
export class PostgresHeldStockEntryOperation implements StockEntryOperationUseCase {
  private readonly digestKeys: ReturnType<typeof copyDigestKeys>;
  private readonly keyGeneration: ReturnType<typeof copyRuntimeKeyGeneration>;
  private destroyed = false;

  constructor(
    private readonly options: {
      digestKeys: DigestKeys;
      environment: "homologation";
      keyGeneration: RuntimeKeyGeneration;
      keyGenerationChecker: StockEntryRuntimeKeyGenerationChecker;
      principalCrypto: RenavePrincipalCrypto;
      projectionCipher: OperationReconciliationProjectionCipher;
      requestCipher: OperationRequestCipher;
      resolver: VerifiedRenavePrincipalResolver;
      runner: TenantActionRunner;
      createOperation?: typeof createOrReplayHeldLocalOperation;
    },
  ) {
    this.digestKeys = copyDigestKeys(options.digestKeys);
    try {
      this.keyGeneration = copyRuntimeKeyGeneration(options.keyGeneration);
    } catch (error) {
      this.digestKeys.actor.fill(0);
      this.digestKeys.idempotency.fill(0);
      this.digestKeys.vehicle.fill(0);
      throw error;
    }
  }

  /** Zera só as chaves próprias; nunca destrói recursos criptográficos emprestados. */
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
        action: "renave.stock-entry.request",
        establishmentId: input.establishmentId,
        mfa: "required",
        session: input.session,
        tenantId: input.tenantId,
      },
      async () => undefined,
    );
    if (!result.allowed) {
      throw new StockEntryOperationError(
        result.reason === "MFA_REQUIRED"
          ? "MFA_REQUIRED"
          : "STOCK_ENTRY_RESOURCE_NOT_FOUND",
      );
    }
  }

  async execute(input: {
    business: StockEntryBusinessInput;
    establishmentId: string;
    idempotencyKey: string;
    session: AuthenticatedSession;
    tenantId: string;
    traceId: string;
  }): Promise<StockEntryOperationResult> {
    if (this.destroyed) {
      throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_UNAVAILABLE");
    }
    const result = await this.options.runner.run(
      {
        action: "renave.stock-entry.request",
        establishmentId: input.establishmentId,
        mfa: "required",
        session: input.session,
        tenantId: input.tenantId,
      },
      async ({ client }) => await this.createWithinTransaction(client, input),
    );
    if (!result.allowed) {
      throw new StockEntryOperationError(
        result.reason === "MFA_REQUIRED"
          ? "MFA_REQUIRED"
          : "STOCK_ENTRY_RESOURCE_NOT_FOUND",
      );
    }
    return result.value;
  }

  private async createWithinTransaction(
    client: TenantClient,
    input: {
      business: StockEntryBusinessInput;
      establishmentId: string;
      idempotencyKey: string;
      session: AuthenticatedSession;
      tenantId: string;
      traceId: string;
    },
  ): Promise<StockEntryOperationResult> {
    let operatorSecret: DecryptedRenavePrincipal | undefined;
    let establishmentSecret: DecryptedRenavePrincipal | undefined;
    let operator: ReturnType<typeof decodeSecret> | undefined;
    let establishment: ReturnType<typeof decodeSecret> | undefined;
    let prepared: PreparedRenaveMutation | undefined;
    let actorDigest: Buffer | undefined;
    let idempotencyDigest: Buffer | undefined;
    let vehicleDigest: Buffer | undefined;
    let operationInput: CreateOperationInput | undefined;
    let principals: ResolvedVerifiedRenavePrincipals | undefined;
    let generationFingerprint: Buffer | undefined;
    try {
      generationFingerprint = Buffer.from(this.keyGeneration.fingerprint);
      await this.options.keyGenerationChecker.assert(client, {
        fingerprint: generationFingerprint,
        generationId: this.keyGeneration.generationId,
      });
      generationFingerprint.fill(0);
      generationFingerprint = undefined;
      idempotencyDigest = hmac(
        this.digestKeys.idempotency,
        "stock-entry-idempotency",
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
      const request: StockEntryRequest = {
        ...input.business,
        cpfOperadorResponsavel: operator.value,
        emailEstabelecimento: establishment.value,
      };
      prepared = await prepareRenaveMutation("request-stock-entry", request);
      actorDigest = hmac(this.digestKeys.actor, "stock-entry-actor", [
        input.tenantId,
        input.session.subject,
      ]);
      vehicleDigest = hmac(this.digestKeys.vehicle, "stock-entry-vehicle", [
        input.tenantId,
        input.business.veiculo.placa,
        input.business.veiculo.renavam ?? "",
        input.business.veiculo.numeroCrv ?? "",
      ]);
      operationInput = buildCreateOperationInput(
        this.options.requestCipher,
        this.options.projectionCipher,
        {
          actorSubjectHash: actorDigest,
          correlationId: randomUUID(),
          environment: this.options.environment,
          establishmentId: input.establishmentId,
          idempotencyKeyDigest: idempotencyDigest,
          prepared,
          tenantId: input.tenantId,
          vehicleKeyDigest: vehicleDigest,
        },
      );
      prepared = undefined;
      const created: CreateOperationResult = await (
        this.options.createOperation ?? createOrReplayHeldLocalOperation
      )(client, operationInput);
      if (created.operation.status !== "HELD_LOCAL") {
        throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_UNAVAILABLE");
      }
      return {
        createdAt: created.operation.createdAt,
        operationId: created.operation.id,
        replayed: created.replayed,
        status: "HELD_LOCAL",
      };
    } catch (error) {
      if (error instanceof StockEntryOperationError) throw error;
      const code = safeCode(error);
      if (
        code === "OperationActiveConflictError" ||
        code === "OperationIdempotencyConflictError" ||
        code === "OperationCredentialLinkNotEnabledError"
      ) {
        throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_CONFLICT");
      }
      if (
        code === "RenavePrincipalDecryptionError" ||
        code === "RenavePrincipalResolutionStorageError" ||
        code === "RenavePrincipalResolutionUnavailableError"
      ) {
        throw new StockEntryOperationError(
          "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE",
        );
      }
      throw new StockEntryOperationError("STOCK_ENTRY_OPERATION_UNAVAILABLE");
    } finally {
      prepared?.destroy();
      operator?.bytes.fill(0);
      establishment?.bytes.fill(0);
      operatorSecret?.destroy();
      establishmentSecret?.destroy();
      zeroResolvedPrincipal(principals?.operator);
      zeroResolvedPrincipal(principals?.establishment);
      actorDigest?.fill(0);
      idempotencyDigest?.fill(0);
      vehicleDigest?.fill(0);
      generationFingerprint?.fill(0);
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

function mapStockEntryError(error: unknown): {
  code: string;
  status: 403 | 404 | 409 | 500 | 503;
} {
  const code = safeCode(error);
  if (code === "MFA_REQUIRED") return { code, status: 403 };
  if (code === "STOCK_ENTRY_RESOURCE_NOT_FOUND") {
    return { code, status: 404 };
  }
  if (
    code === "OperationActiveConflictError" ||
    code === "OperationIdempotencyConflictError" ||
    code === "OperationCredentialLinkNotEnabledError" ||
    code === "STOCK_ENTRY_OPERATION_CONFLICT"
  ) {
    return { code: "STOCK_ENTRY_OPERATION_CONFLICT", status: 409 };
  }
  if (
    code === "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE" ||
    code === "STOCK_ENTRY_OPERATION_UNAVAILABLE"
  ) {
    return { code, status: 503 };
  }
  return { code: "INTERNAL_ERROR", status: 500 };
}

export function registerStockEntryOperationRoute(
  app: FastifyInstance,
  options: {
    accessGuard: RequestAccessGuard;
    businessTimeZone?: string;
    clock?: Clock;
    mutationRateLimiter?: StockEntryMutationRateLimiter;
    operation?: StockEntryOperationUseCase;
    publicOrigin: string;
  },
): void {
  const formatBusinessDate = createBusinessDateFormatter(
    options.businessTimeZone ?? DEFAULT_STOCK_ENTRY_BUSINESS_TIME_ZONE,
  );
  app.post(
    "/api/tenants/:tenantId/establishments/:establishmentId/stock-entry-operations",
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      if (request.headers.origin !== options.publicOrigin) {
        return reply.code(403).send({ code: "CSRF_ORIGIN_MISMATCH" });
      }
      const lookup = await options.accessGuard.authenticate(request, reply, {
        mfa: "required",
      });
      if (!lookup.ok) return;
      const params = request.params as Record<string, unknown>;
      if (
        typeof params?.tenantId !== "string" ||
        typeof params.establishmentId !== "string" ||
        !UUID.test(params.tenantId) ||
        !UUID.test(params.establishmentId)
      ) {
        return reply.code(404).send({ code: "STOCK_ENTRY_RESOURCE_NOT_FOUND" });
      }
      const tenantId = params.tenantId.toLowerCase();
      const establishmentId = params.establishmentId.toLowerCase();
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) {
        return reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY" });
      }
      const now = (options.clock ?? systemClock).now();
      const business = parseStockEntryBusinessInput(request.body, {
        businessDate: formatBusinessDate(now),
        now,
      });
      if (!business) {
        return reply.code(400).send({ code: "INVALID_STOCK_ENTRY_INPUT" });
      }
      if (!options.operation || !options.mutationRateLimiter) {
        return reply
          .code(503)
          .send({ code: "STOCK_ENTRY_OPERATION_NOT_CONFIGURED" });
      }
      try {
        await options.operation.authorize({
          establishmentId,
          session: lookup.session,
          tenantId,
        });
      } catch (error) {
        const mapped = mapStockEntryError(error);
        return reply.code(mapped.status).send({ code: mapped.code });
      }
      let rateLimit;
      try {
        rateLimit = await options.mutationRateLimiter.acquire({
          subject: lookup.session.subject,
          tenantId,
        });
      } catch {
        return reply
          .code(503)
          .send({ code: "STOCK_ENTRY_RATE_LIMIT_UNAVAILABLE" });
      }
      if (!rateLimit.allowed) {
        if (
          !Number.isInteger(rateLimit.retryAfterSeconds) ||
          rateLimit.retryAfterSeconds < 1
        ) {
          return reply
            .code(503)
            .send({ code: "STOCK_ENTRY_RATE_LIMIT_UNAVAILABLE" });
        }
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ code: "STOCK_ENTRY_RATE_LIMITED" });
      }
      try {
        const result = await options.operation.execute({
          business,
          establishmentId,
          idempotencyKey: idempotencyKey.toLowerCase(),
          session: lookup.session,
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
        const mapped = mapStockEntryError(error);
        request.log.error({
          errorCode: mapped.code,
          event: "renave.stock_entry_operation.failed",
          traceId: request.id,
        });
        return reply.code(mapped.status).send({ code: mapped.code });
      }
    },
  );
}
