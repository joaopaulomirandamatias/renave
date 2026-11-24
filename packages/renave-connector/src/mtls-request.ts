import { Agent, request as httpsRequest } from "node:https";
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { createSecureContext } from "node:tls";

import type { RenaveEnvironment } from "./connector.js";
import type { RenaveHttpRequest } from "./http-transport.js";

const HOMOLOGATION_ORIGIN = "https://hom.renave.estaleiro.serpro.gov.br";
const HOMOLOGATION_IDENTITY_URL = `${HOMOLOGATION_ORIGIN}/renave-ws/api/cliente-autenticado`;
const HOMOLOGATION_ELIGIBILITY_URL = `${HOMOLOGATION_ORIGIN}/renave-ws/api/aptidao-veiculo-estoque`;
const HOMOLOGATION_STOCKS_URL = `${HOMOLOGATION_ORIGIN}/renave-ws/api/estoques`;
const HOMOLOGATION_VEHICLES_URL = `${HOMOLOGATION_ORIGIN}/renave-ws/api/veiculos`;
const HOMOLOGATION_STOCK_ENTRY_URL = `${HOMOLOGATION_ORIGIN}/renave-ws/api/solicitacoes-entrada-estoque`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PemMtlsMaterial {
  ca: string | readonly string[];
  cert: string;
  key: string;
  passphrase?: string;
}

export interface HomologationMtlsClient {
  getCertificateTemporalStatus(now?: Date): MtlsCertificateTemporalStatus;
  close(): void;
  isCertificateValidAt(now?: Date): boolean;
  request: RenaveHttpRequest;
}

export interface PemMtlsClientOptions {
  now?: () => Date;
}

interface HomologationRenaveReadOnlyRequestState {
  request: RenaveHttpRequest;
}

const homologationRenaveReadOnlyRequestStates = new WeakMap<
  HomologationRenaveReadOnlyRequest,
  HomologationRenaveReadOnlyRequestState
>();

const homologationRenaveReadOnlyRequestConstructorToken = Object.freeze({});

export type PemMtlsValidationCode =
  | "RENAVE_MTLS_CA_INVALID"
  | "RENAVE_MTLS_CERT_EXPIRED"
  | "RENAVE_MTLS_CERT_INVALID"
  | "RENAVE_MTLS_CERT_NOT_YET_VALID"
  | "RENAVE_MTLS_CERT_USAGE_INVALID"
  | "RENAVE_MTLS_KEY_INVALID"
  | "RENAVE_MTLS_KEY_MISMATCH";

export type MtlsCertificateTemporalStatus =
  | "invalid_clock"
  | "not_yet_valid"
  | "healthy"
  | "expiring_90d"
  | "expiring_60d"
  | "expiring_30d"
  | "expiring_15d"
  | "expiring_7d"
  | "expiring_1d"
  | "expired";

export class PemMtlsProductionBlockedError extends Error {
  readonly code = "PEM_MTLS_PRODUCTION_BLOCKED";

  constructor() {
    super("Produção exige chave não exportável em HSM; PEM é proibido");
    this.name = "PemMtlsProductionBlockedError";
  }
}

export class InvalidPemMtlsMaterialError extends Error {
  constructor(
    readonly field: "ca" | "cert" | "key",
    readonly code: PemMtlsValidationCode,
  ) {
    super(`Material mTLS inválido: ${field}`);
    this.name = "InvalidPemMtlsMaterialError";
  }
}

export class RenaveMtlsOriginError extends Error {
  readonly code = "RENAVE_MTLS_TARGET_BLOCKED";

  constructor() {
    super(
      "O destino solicitado não pertence à allowlist RENAVE de homologação",
    );
    this.name = "RenaveMtlsOriginError";
  }
}

/** Capacidade nominal mTLS limitada às leituras de reconciliação. */
export class HomologationRenaveReadOnlyRequest {
  constructor(token: never, request: RenaveHttpRequest) {
    if (
      new.target !== HomologationRenaveReadOnlyRequest ||
      token !== (homologationRenaveReadOnlyRequestConstructorToken as never) ||
      typeof request !== "function"
    ) {
      throw new RenaveMtlsOriginError();
    }
    homologationRenaveReadOnlyRequestStates.set(this, {
      request: request.bind(undefined),
    });
    Object.freeze(this);
  }

  async request(input: string, init: RequestInit): Promise<Response> {
    return await executeHomologationRenaveReadOnlyRequest(
      homologationRenaveReadOnlyRequestState(this),
      input,
      init,
    );
  }
}

export function createHomologationRenaveReadOnlyRequest(
  environment: RenaveEnvironment,
  request: RenaveHttpRequest,
): HomologationRenaveReadOnlyRequest {
  if (environment !== "homologation") {
    throw new PemMtlsProductionBlockedError();
  }
  return new HomologationRenaveReadOnlyRequest(
    homologationRenaveReadOnlyRequestConstructorToken as never,
    request,
  );
}

/** @internal Liga o transporte HTTP à marca nominal sem dispatch virtual. */
export function bindHomologationRenaveReadOnlyRequest(
  capability: HomologationRenaveReadOnlyRequest,
): RenaveHttpRequest {
  const state = homologationRenaveReadOnlyRequestState(capability);
  return async (input, init) =>
    await executeHomologationRenaveReadOnlyRequest(state, input, init);
}

function homologationRenaveReadOnlyRequestState(
  capability: HomologationRenaveReadOnlyRequest,
): HomologationRenaveReadOnlyRequestState {
  const state = homologationRenaveReadOnlyRequestStates.get(capability);
  if (!state) throw new RenaveMtlsOriginError();
  return state;
}

function isAllowedReadUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (
    url.origin !== HOMOLOGATION_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  if (input === HOMOLOGATION_IDENTITY_URL) return true;
  if (input === HOMOLOGATION_STOCKS_URL) return true;
  if (
    url.search === "" &&
    url.pathname.startsWith("/renave-ws/api/estoques/")
  ) {
    const rawStockId = url.pathname.slice("/renave-ws/api/estoques/".length);
    const stockId = Number(rawStockId);
    return (
      /^[1-9]\d*$/u.test(rawStockId) &&
      Number.isSafeInteger(stockId) &&
      stockId > 0 &&
      String(stockId) === rawStockId &&
      input === `${HOMOLOGATION_STOCKS_URL}/${rawStockId}`
    );
  }
  if (url.pathname === "/renave-ws/api/aptidao-veiculo-estoque") {
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 2 || entries[0]?.[0] !== "tipoCrv") return false;

    const crvType = entries[0][1];
    if (!["AZUL", "VERDE", "BRANCO", "DIGITAL"].includes(crvType)) {
      return false;
    }
    const identifier = entries[1];
    if (!identifier) return false;
    const identifierIsValid =
      (identifier[0] === "placa" && /^[A-Z0-9]{7}$/.test(identifier[1])) ||
      (identifier[0] === "renavam" && /^\d{11}$/.test(identifier[1])) ||
      (identifier[0] === "numeroCrv" && /^\d{12}$/.test(identifier[1]));
    if (!identifierIsValid) return false;

    const canonical = new URLSearchParams({ tipoCrv: crvType });
    canonical.set(identifier[0], identifier[1]);
    return input === `${HOMOLOGATION_ELIGIBILITY_URL}?${canonical.toString()}`;
  }
  if (
    url.pathname !== "/renave-ws/api/estoques" &&
    url.pathname !== "/renave-ws/api/veiculos"
  ) {
    return false;
  }

  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "placa" ||
    !/^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/.test(entries[0][1])
  ) {
    return false;
  }
  const base =
    url.pathname === "/renave-ws/api/veiculos"
      ? HOMOLOGATION_VEHICLES_URL
      : HOMOLOGATION_STOCKS_URL;
  return input === `${base}?placa=${entries[0][1]}`;
}

function isAllowedMtlsRequest(input: string, init: RequestInit): boolean {
  if (init.redirect !== "error") return false;
  if (init.method === "GET") {
    return init.body === undefined && isAllowedReadUrl(input);
  }
  if (init.method !== "POST" || input !== HOMOLOGATION_STOCK_ENTRY_URL) {
    return false;
  }
  return (
    typeof init.body === "string" ||
    init.body instanceof Uint8Array ||
    init.body instanceof ArrayBuffer
  );
}

function executeHomologationRenaveReadOnlyRequest(
  state: HomologationRenaveReadOnlyRequestState,
  input: string,
  init: RequestInit,
): Promise<Response> {
  let method: string | undefined;
  let redirect: RequestRedirect | undefined;
  let body: BodyInit | null | undefined;
  let headers: HeadersInit | undefined;
  let signal: AbortSignal | null | undefined;
  try {
    method = init.method;
    redirect = init.redirect;
    body = init.body;
    headers = init.headers;
    signal = init.signal;
  } catch {
    throw new RenaveMtlsOriginError();
  }
  if (
    method !== "GET" ||
    redirect !== "error" ||
    body !== undefined ||
    !isAllowedReadUrl(input)
  ) {
    throw new RenaveMtlsOriginError();
  }

  const safeInit: RequestInit = {
    headers: new Headers(headers),
    method: "GET",
    redirect: "error",
    ...(signal === undefined || signal === null ? {} : { signal }),
  };
  return state.request(input, safeInit);
}

export class RenaveMtlsResponseTooLargeError extends Error {
  readonly code = "RENAVE_MTLS_RESPONSE_TOO_LARGE";

  constructor() {
    super("A resposta RENAVE excedeu o limite permitido");
    this.name = "RenaveMtlsResponseTooLargeError";
  }
}

export async function readBoundedResponseBody(
  source: AsyncIterable<Uint8Array>,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes inválido");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new RenaveMtlsResponseTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function invalidMaterial(
  field: "ca" | "cert" | "key",
  code: PemMtlsValidationCode,
): InvalidPemMtlsMaterialError {
  return new InvalidPemMtlsMaterialError(field, code);
}

function parseCertificate(
  value: string,
  field: "ca" | "cert",
): X509Certificate {
  try {
    return new X509Certificate(value);
  } catch {
    throw invalidMaterial(
      field,
      field === "ca" ? "RENAVE_MTLS_CA_INVALID" : "RENAVE_MTLS_CERT_INVALID",
    );
  }
}

function parsePrivateKey(material: PemMtlsMaterial): KeyObject {
  try {
    return createPrivateKey({
      key: material.key,
      ...(material.passphrase === undefined
        ? {}
        : { passphrase: material.passphrase }),
    });
  } catch {
    throw invalidMaterial("key", "RENAVE_MTLS_KEY_INVALID");
  }
}

function validateMaterial(
  material: PemMtlsMaterial,
  now: Date,
): X509Certificate {
  const authorities = Array.isArray(material.ca) ? material.ca : [material.ca];
  if (authorities.length === 0) {
    throw invalidMaterial("ca", "RENAVE_MTLS_CA_INVALID");
  }
  for (const authority of authorities) parseCertificate(authority, "ca");

  const certificate = parseCertificate(material.cert, "cert");
  const privateKey = parsePrivateKey(material);
  if (!certificate.checkPrivateKey(privateKey)) {
    throw invalidMaterial("key", "RENAVE_MTLS_KEY_MISMATCH");
  }

  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) {
    throw new RangeError("Relógio mTLS inválido");
  }
  if (nowTime < certificate.validFromDate.getTime()) {
    throw invalidMaterial("cert", "RENAVE_MTLS_CERT_NOT_YET_VALID");
  }
  if (nowTime >= certificate.validToDate.getTime()) {
    throw invalidMaterial("cert", "RENAVE_MTLS_CERT_EXPIRED");
  }
  if (certificate.ca) {
    throw invalidMaterial("cert", "RENAVE_MTLS_CERT_USAGE_INVALID");
  }
  const extendedKeyUsage = certificate.keyUsage;
  if (
    extendedKeyUsage !== undefined &&
    !extendedKeyUsage.includes("1.3.6.1.5.5.7.3.2")
  ) {
    throw invalidMaterial("cert", "RENAVE_MTLS_CERT_USAGE_INVALID");
  }

  try {
    createSecureContext({
      ca: [...authorities],
      cert: material.cert,
      key: material.key,
      minVersion: "TLSv1.2",
      ...(material.passphrase === undefined
        ? {}
        : { passphrase: material.passphrase }),
    });
  } catch {
    throw invalidMaterial("cert", "RENAVE_MTLS_CERT_INVALID");
  }
  return certificate;
}

function isCertificateValidAt(
  certificate: X509Certificate,
  now: Date,
): boolean {
  const timestamp = now.getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= certificate.validFromDate.getTime() &&
    timestamp < certificate.validToDate.getTime()
  );
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

function getCertificateTemporalStatus(
  certificate: X509Certificate,
  now: Date,
): MtlsCertificateTemporalStatus {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) return "invalid_clock";
  if (timestamp < certificate.validFromDate.getTime()) return "not_yet_valid";

  const remainingMilliseconds = certificate.validToDate.getTime() - timestamp;
  if (remainingMilliseconds <= 0) return "expired";
  if (remainingMilliseconds <= DAY_IN_MILLISECONDS) return "expiring_1d";
  if (remainingMilliseconds <= 7 * DAY_IN_MILLISECONDS) return "expiring_7d";
  if (remainingMilliseconds <= 15 * DAY_IN_MILLISECONDS) return "expiring_15d";
  if (remainingMilliseconds <= 30 * DAY_IN_MILLISECONDS) return "expiring_30d";
  if (remainingMilliseconds <= 60 * DAY_IN_MILLISECONDS) return "expiring_60d";
  if (remainingMilliseconds <= 90 * DAY_IN_MILLISECONDS) return "expiring_90d";
  return "healthy";
}

function responseHeaders(
  source: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

export function createHomologationPemMtlsClient(
  environment: RenaveEnvironment,
  material: PemMtlsMaterial,
  options: PemMtlsClientOptions = {},
): HomologationMtlsClient {
  if (environment === "production") throw new PemMtlsProductionBlockedError();
  const certificate = validateMaterial(
    material,
    (options.now ?? (() => new Date()))(),
  );

  const agent = new Agent({
    ca: [...(Array.isArray(material.ca) ? material.ca : [material.ca])],
    cert: material.cert,
    keepAlive: true,
    key: material.key,
    maxFreeSockets: 4,
    maxSockets: 16,
    minVersion: "TLSv1.2",
    ...(material.passphrase === undefined
      ? {}
      : { passphrase: material.passphrase }),
    rejectUnauthorized: true,
  });

  const request: RenaveHttpRequest = async (input, init) => {
    if (!isAllowedMtlsRequest(input, init)) {
      throw new RenaveMtlsOriginError();
    }
    const url = new URL(input);

    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          agent,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          method: init.method,
          signal: init.signal ?? undefined,
        },
        (response) => {
          const headers = responseHeaders(response.headers);
          const status = response.statusCode ?? 500;
          const statusText = response.statusMessage;
          void readBoundedResponseBody(response)
            .then((body) => {
              resolve(
                new Response(Uint8Array.from(body), {
                  headers,
                  status,
                  ...(statusText === undefined ? {} : { statusText }),
                }),
              );
            })
            .catch((error: unknown) => {
              response.destroy();
              reject(error);
            });
        },
      );
      request.on("error", reject);

      if (init.body === undefined || init.body === null) {
        request.end();
      } else if (
        typeof init.body === "string" ||
        init.body instanceof Uint8Array
      ) {
        request.end(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        request.end(new Uint8Array(init.body));
      } else {
        request.destroy(
          new TypeError("O transporte RENAVE aceita apenas body em bytes"),
        );
      }
    });
  };

  return {
    close: () => agent.destroy(),
    getCertificateTemporalStatus: (now = new Date()) =>
      getCertificateTemporalStatus(certificate, now),
    isCertificateValidAt: (now = new Date()) =>
      isCertificateValidAt(certificate, now),
    request,
  };
}

Object.freeze(HomologationRenaveReadOnlyRequest.prototype);
Object.freeze(HomologationRenaveReadOnlyRequest);
