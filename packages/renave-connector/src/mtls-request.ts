import { Agent, request as httpsRequest } from "node:https";

import type { RenaveEnvironment } from "./connector.js";
import type { RenaveHttpRequest } from "./http-transport.js";

const HOMOLOGATION_ORIGIN = "https://hom.renave.estaleiro.serpro.gov.br";
const ALLOWED_PATHS = new Set([
  "/renave-ws/api/aptidao-veiculo-estoque",
  "/renave-ws/api/cliente-autenticado",
  "/renave-ws/api/estoques",
  "/renave-ws/api/solicitacoes-entrada-estoque",
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PemMtlsMaterial {
  ca: string | readonly string[];
  cert: string;
  key: string;
  passphrase?: string;
}

export interface HomologationMtlsClient {
  close(): void;
  request: RenaveHttpRequest;
}

export class PemMtlsProductionBlockedError extends Error {
  readonly code = "PEM_MTLS_PRODUCTION_BLOCKED";

  constructor() {
    super("Produção exige chave não exportável em HSM; PEM é proibido");
    this.name = "PemMtlsProductionBlockedError";
  }
}

export class InvalidPemMtlsMaterialError extends Error {
  readonly code = "INVALID_PEM_MTLS_MATERIAL";

  constructor(readonly field: "ca" | "cert" | "key") {
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

function assertCertificate(value: string, field: "ca" | "cert"): void {
  if (!/-----BEGIN CERTIFICATE-----/.test(value)) {
    throw new InvalidPemMtlsMaterialError(field);
  }
}

function validateMaterial(material: PemMtlsMaterial): void {
  assertCertificate(material.cert, "cert");
  const authorities = Array.isArray(material.ca) ? material.ca : [material.ca];
  if (authorities.length === 0) throw new InvalidPemMtlsMaterialError("ca");
  for (const authority of authorities) assertCertificate(authority, "ca");
  if (!/-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/.test(material.key)) {
    throw new InvalidPemMtlsMaterialError("key");
  }
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
): HomologationMtlsClient {
  if (environment === "production") throw new PemMtlsProductionBlockedError();
  validateMaterial(material);

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
    if (init.redirect !== "error") throw new RenaveMtlsOriginError();
    const url = new URL(input);
    if (
      url.origin !== HOMOLOGATION_ORIGIN ||
      !ALLOWED_PATHS.has(url.pathname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new RenaveMtlsOriginError();
    }

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

  return { close: () => agent.destroy(), request };
}
