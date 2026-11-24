import { createHmac } from "node:crypto";

const CANONICAL_32_BYTE_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;

const DOMAINS = Object.freeze({
  actor: "platform-actor-v1",
  cursor: "platform-cursor-v1",
  reason: "platform-reason-v1",
  ticket: "platform-ticket-v1",
  trace: "platform-trace-v1",
});

export class PlatformDigestInputError extends Error {
  readonly code = "PLATFORM_DIGEST_INPUT_REJECTED";
  override name = "PlatformDigestInputError";

  constructor() {
    super("A entrada para o digest do console global e invalida");
  }
}

export function decodePlatformOperatorHmacKeyBase64(value: string): Buffer {
  if (!CANONICAL_32_BYTE_BASE64.test(value)) {
    throw new PlatformDigestInputError();
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new PlatformDigestInputError();
  }
  return key;
}

function digest(key: Buffer, domain: string, parts: readonly string[]): Buffer {
  if (key.byteLength !== 32 || parts.some((part) => part.length === 0)) {
    throw new PlatformDigestInputError();
  }
  return createHmac("sha256", key)
    .update(JSON.stringify([domain, ...parts]), "utf8")
    .digest();
}

export function derivePlatformActorDigest(
  key: Buffer,
  issuer: string,
  subject: string,
): Buffer {
  return digest(key, DOMAINS.actor, [issuer, subject]);
}

export function derivePlatformCursorDigest(
  key: Buffer,
  payload: string,
): Buffer {
  return digest(key, DOMAINS.cursor, [payload]);
}

export function derivePlatformReasonDigest(
  key: Buffer,
  reasonTicket: string,
): Buffer {
  return digest(key, DOMAINS.reason, [reasonTicket]);
}

export function derivePlatformDecisionTicketDigest(
  key: Buffer,
  decisionTicket: string,
): Buffer {
  return digest(key, DOMAINS.ticket, [decisionTicket]);
}

export function derivePlatformTraceDigest(
  key: Buffer,
  traceId: string,
): Buffer {
  return digest(key, DOMAINS.trace, [traceId]);
}
