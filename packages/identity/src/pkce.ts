import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** RFC 7636 §4.2: code_challenge = BASE64URL(SHA256(code_verifier)). */
export function codeChallengeS256(verifier: string): string {
  return sha256Base64Url(verifier);
}

/** Verifier PKCE: 64 bytes aleatórios => 86 caracteres (faixa 43–128). */
export function createCodeVerifier(): string {
  return randomToken(64);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
