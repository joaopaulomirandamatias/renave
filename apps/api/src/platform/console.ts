import { timingSafeEqual } from "node:crypto";

import {
  acquirePlatformConsolePermit,
  authorizePlatformConsoleAccess,
  decodePlatformOperatorHmacKeyBase64 as decodeSharedPlatformOperatorHmacKey,
  derivePlatformActorDigest,
  derivePlatformCursorDigest,
  derivePlatformReasonDigest,
  derivePlatformTraceDigest,
  listPlatformCredentialLinkQueue,
  PlatformDigestInputError,
  type PlatformQueueCursor,
  type PlatformQueueEntry,
} from "@seu-renave/db/api-runtime";
import type { Pool } from "pg";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PlatformConsolePage {
  authorized: boolean;
  entries: readonly PlatformQueueEntry[];
  nextCursor?: string;
  truncated: boolean;
}

export interface PlatformConsole {
  acquire(input: {
    issuer: string;
    subject: string;
  }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  authorize(input: { issuer: string; subject: string }): Promise<boolean>;
  destroy(): void;
  list(input: {
    actorIp: string;
    cursor?: string;
    issuer: string;
    limit: number;
    reasonTicket: string;
    subject: string;
    traceId: string;
  }): Promise<PlatformConsolePage>;
}

export class PlatformConsoleInputError extends Error {
  readonly code = "PLATFORM_CONSOLE_INPUT_REJECTED";
  override name = "PlatformConsoleInputError";

  constructor() {
    super("A entrada do console global é inválida");
  }
}

export function decodePlatformOperatorHmacKeyBase64(value: string): Buffer {
  try {
    return decodeSharedPlatformOperatorHmacKey(value);
  } catch (error) {
    if (error instanceof PlatformDigestInputError) {
      throw new PlatformConsoleInputError();
    }
    throw error;
  }
}

function encodeCursor(key: Buffer, cursor: PlatformQueueCursor): string {
  const payload = Buffer.from(
    JSON.stringify([
      1,
      cursor.priority,
      cursor.updatedAt.toISOString(),
      cursor.tenantId,
      cursor.establishmentId,
    ]),
    "utf8",
  ).toString("base64url");
  const signature = derivePlatformCursorDigest(key, payload).toString(
    "base64url",
  );
  return `${payload}.${signature}`;
}

function decodeCursor(key: Buffer, value: string): PlatformQueueCursor {
  if (
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)
  ) {
    throw new PlatformConsoleInputError();
  }
  const [payload, providedSignature] = value.split(".") as [string, string];
  const expected = derivePlatformCursorDigest(key, payload);
  const provided = Buffer.from(providedSignature, "base64url");
  try {
    if (provided.byteLength !== 32 || !timingSafeEqual(expected, provided)) {
      throw new PlatformConsoleInputError();
    }
  } finally {
    expected.fill(0);
    provided.fill(0);
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) throw new Error();
    parsed = JSON.parse(bytes.toString("utf8"));
    bytes.fill(0);
  } catch {
    throw new PlatformConsoleInputError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    parsed[0] !== 1 ||
    !Number.isInteger(parsed[1]) ||
    (parsed[1] as number) < 0 ||
    (parsed[1] as number) > 5 ||
    typeof parsed[2] !== "string" ||
    typeof parsed[3] !== "string" ||
    !UUID_PATTERN.test(parsed[3]) ||
    typeof parsed[4] !== "string" ||
    !UUID_PATTERN.test(parsed[4])
  ) {
    throw new PlatformConsoleInputError();
  }
  const updatedAt = new Date(parsed[2]);
  if (
    !Number.isFinite(updatedAt.getTime()) ||
    updatedAt.toISOString() !== parsed[2]
  ) {
    throw new PlatformConsoleInputError();
  }
  return {
    priority: parsed[1] as number,
    updatedAt,
    tenantId: parsed[3].toLowerCase(),
    establishmentId: parsed[4].toLowerCase(),
  };
}

export class PostgresPlatformConsole implements PlatformConsole {
  readonly #key: Buffer;
  #destroyed = false;

  constructor(
    private readonly pool: Pool,
    key: Buffer,
  ) {
    if (key.byteLength !== 32) throw new PlatformConsoleInputError();
    this.#key = Buffer.from(key);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#key.fill(0);
  }

  async acquire(input: { issuer: string; subject: string }) {
    if (this.#destroyed) throw new PlatformConsoleInputError();
    const actor = derivePlatformActorDigest(
      this.#key,
      input.issuer,
      input.subject,
    );
    try {
      return await acquirePlatformConsolePermit(this.pool, actor);
    } finally {
      actor.fill(0);
    }
  }

  async authorize(input: { issuer: string; subject: string }) {
    if (this.#destroyed) throw new PlatformConsoleInputError();
    const actor = derivePlatformActorDigest(
      this.#key,
      input.issuer,
      input.subject,
    );
    try {
      return await authorizePlatformConsoleAccess(this.pool, actor);
    } finally {
      actor.fill(0);
    }
  }

  async list(input: Parameters<PlatformConsole["list"]>[0]) {
    if (this.#destroyed) throw new PlatformConsoleInputError();
    const actor = derivePlatformActorDigest(
      this.#key,
      input.issuer,
      input.subject,
    );
    const reason = derivePlatformReasonDigest(this.#key, input.reasonTicket);
    const trace = derivePlatformTraceDigest(this.#key, input.traceId);
    try {
      const result = await listPlatformCredentialLinkQueue(this.pool, {
        actorDigest: actor,
        actorIp: input.actorIp,
        ...(input.cursor
          ? { after: decodeCursor(this.#key, input.cursor) }
          : {}),
        limit: input.limit,
        reasonTicketDigest: reason,
        traceDigest: trace,
      });
      if (!result.authorized) {
        return { authorized: false, entries: [], truncated: false };
      }
      return {
        authorized: true,
        entries: result.entries,
        truncated: result.truncated,
        ...(result.nextCursor
          ? { nextCursor: encodeCursor(this.#key, result.nextCursor) }
          : {}),
      };
    } finally {
      actor.fill(0);
      reason.fill(0);
      trace.fill(0);
    }
  }
}
