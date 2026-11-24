import type { RenaveMutationOperation } from "./operations.js";

const MAX_MUTATION_BODY_BYTES = 1_048_576;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
type OwnedBytes = Uint8Array<ArrayBuffer>;

interface PreparedState {
  body: OwnedBytes;
  byteLength: number;
  operation: RenaveMutationOperation;
  requestSha256: string;
}

export interface PreparedRenaveMutationSnapshot {
  readonly body: OwnedBytes;
  readonly byteLength: number;
  readonly operation: RenaveMutationOperation;
  readonly requestSha256: string;
}

const CONSTRUCTION_TOKEN = Symbol("PreparedRenaveMutation");
const states = new WeakMap<PreparedRenaveMutation, PreparedState>();
const destroyed = new WeakSet<PreparedRenaveMutation>();

export type InvalidPreparedRenaveMutationReason =
  | "BODY_FORMAT"
  | "BODY_SIZE"
  | "HASH_FORMAT"
  | "HASH_MISMATCH"
  | "NOT_SERIALIZABLE"
  | "OPERATION"
  | "DESTROYED";

export class InvalidPreparedRenaveMutationError extends Error {
  readonly code = "INVALID_PREPARED_RENAVE_MUTATION";

  constructor(readonly reason: InvalidPreparedRenaveMutationReason) {
    super("A requisição RENAVE não pôde ser preparada com segurança");
    this.name = "InvalidPreparedRenaveMutationError";
  }
}

async function sha256(bytes: OwnedBytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validateBodySize(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MUTATION_BODY_BYTES) {
    throw new InvalidPreparedRenaveMutationError("BODY_SIZE");
  }
}

export function assertRenaveMutationOperation(
  operation: unknown,
): asserts operation is RenaveMutationOperation {
  if (
    operation !== "request-stock-entry" &&
    operation !== "request-stock-exit"
  ) {
    throw new InvalidPreparedRenaveMutationError("OPERATION");
  }
}

function validateJsonObject(bytes: OwnedBytes): void {
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidPreparedRenaveMutationError("BODY_FORMAT");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidPreparedRenaveMutationError("BODY_FORMAT");
  }
}

function preparedState(prepared: PreparedRenaveMutation): PreparedState {
  const state = states.get(prepared);
  if (!state) {
    if (destroyed.has(prepared)) {
      throw new InvalidPreparedRenaveMutationError("DESTROYED");
    }
    throw new InvalidPreparedRenaveMutationError("NOT_SERIALIZABLE");
  }
  return state;
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Envelope nominal de uma mutação já serializada.
 * O corpo não é enumerável nem compartilhado; somente cópias defensivas saem daqui.
 */
export class PreparedRenaveMutation {
  private constructor(token: symbol, state: PreparedState) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new InvalidPreparedRenaveMutationError("NOT_SERIALIZABLE");
    }
    states.set(this, state);
    Object.freeze(this);
  }

  get operation(): RenaveMutationOperation {
    return preparedState(this).operation;
  }

  get requestSha256(): string {
    return preparedState(this).requestSha256;
  }

  get byteLength(): number {
    return preparedState(this).byteLength;
  }

  static async prepare(
    operation: RenaveMutationOperation,
    payload: unknown,
  ): Promise<PreparedRenaveMutation> {
    assertRenaveMutationOperation(operation);
    let json: string | undefined;
    try {
      json = JSON.stringify(payload);
    } catch {
      throw new InvalidPreparedRenaveMutationError("NOT_SERIALIZABLE");
    }
    if (json === undefined) {
      throw new InvalidPreparedRenaveMutationError("NOT_SERIALIZABLE");
    }
    const body = new TextEncoder().encode(json);
    validateBodySize(body);
    validateJsonObject(body);
    const requestSha256 = await sha256(body);
    return new PreparedRenaveMutation(CONSTRUCTION_TOKEN, {
      body,
      byteLength: body.byteLength,
      operation,
      requestSha256,
    });
  }

  static async restore(
    operation: RenaveMutationOperation,
    source: Uint8Array,
    expectedSha256: string,
  ): Promise<PreparedRenaveMutation> {
    assertRenaveMutationOperation(operation);
    if (!(source instanceof Uint8Array)) {
      throw new InvalidPreparedRenaveMutationError("BODY_SIZE");
    }
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new InvalidPreparedRenaveMutationError("HASH_FORMAT");
    }
    // A cópia acontece antes do primeiro await para fechar a janela TOCTOU.
    const body = new Uint8Array(source.byteLength);
    body.set(source);
    validateBodySize(body);
    validateJsonObject(body);
    const actualSha256 = await sha256(body);
    if (!equalDigest(actualSha256, expectedSha256)) {
      throw new InvalidPreparedRenaveMutationError("HASH_MISMATCH");
    }
    return new PreparedRenaveMutation(CONSTRUCTION_TOKEN, {
      body,
      byteLength: body.byteLength,
      operation,
      requestSha256: actualSha256,
    });
  }

  copyBodyBytes(): OwnedBytes {
    return copyPreparedRenaveMutationBody(this);
  }

  /**
   * Apaga o plaintext mantido pelo envelope. É idempotente para permitir uso
   * seguro em `finally`; qualquer leitura posterior falha fechada.
   */
  destroy(): void {
    const state = states.get(this);
    if (!state) {
      if (destroyed.has(this)) return;
      throw new InvalidPreparedRenaveMutationError("NOT_SERIALIZABLE");
    }
    state.body.fill(0);
    states.delete(this);
    destroyed.add(this);
  }

  toJSON(): Readonly<{
    byteLength: number;
    operation: RenaveMutationOperation;
    requestSha256: string;
  }> {
    return Object.freeze({
      byteLength: this.byteLength,
      operation: this.operation,
      requestSha256: this.requestSha256,
    });
  }
}

// Impede substituição dos getters ou factories por monkey-patching em runtime.
Object.freeze(PreparedRenaveMutation.prototype);
Object.freeze(PreparedRenaveMutation);

export function prepareRenaveMutation(
  operation: RenaveMutationOperation,
  payload: unknown,
): Promise<PreparedRenaveMutation> {
  return PreparedRenaveMutation.prepare(operation, payload);
}

export function restorePreparedRenaveMutation(
  operation: RenaveMutationOperation,
  body: Uint8Array,
  expectedSha256: string,
): Promise<PreparedRenaveMutation> {
  return PreparedRenaveMutation.restore(operation, body, expectedSha256);
}

/**
 * Fronteira nominal para consumidores confiáveis do envelope preparado.
 * Lê o estado diretamente do WeakMap e nunca invoca propriedades do argumento.
 */
export function readPreparedRenaveMutation(
  prepared: PreparedRenaveMutation,
): PreparedRenaveMutationSnapshot {
  const state = preparedState(prepared);
  const body = new Uint8Array(state.body.byteLength);
  body.set(state.body);
  return Object.freeze({
    body,
    byteLength: state.byteLength,
    operation: state.operation,
    requestSha256: state.requestSha256,
  });
}

/** Uso interno do transporte; não é reexportado pelo pacote. */
export function copyPreparedRenaveMutationBody(
  prepared: PreparedRenaveMutation,
): OwnedBytes {
  return readPreparedRenaveMutation(prepared).body;
}
