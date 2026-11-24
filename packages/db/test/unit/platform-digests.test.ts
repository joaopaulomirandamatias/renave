import { describe, expect, it } from "vitest";

import {
  decodePlatformOperatorHmacKeyBase64,
  derivePlatformActorDigest,
  derivePlatformDecisionTicketDigest,
  derivePlatformReasonDigest,
  PlatformDigestInputError,
} from "../../src/platform-digests.js";

describe("digests canônicos do console global", () => {
  it("separa issuer/subject estruturalmente e domínios de tickets", () => {
    const key = Buffer.alloc(32, 7);
    expect(
      derivePlatformActorDigest(key, "issuer-a\0subject-b", "subject-c"),
    ).not.toEqual(
      derivePlatformActorDigest(key, "issuer-a", "subject-b\0subject-c"),
    );
    expect(derivePlatformActorDigest(key, "issuer-a", "subject-b")).not.toEqual(
      derivePlatformActorDigest(key, "issuer-a", "subject-c"),
    );
    expect(derivePlatformDecisionTicketDigest(key, "SEC-123")).not.toEqual(
      derivePlatformReasonDigest(key, "SEC-123"),
    );
  });

  it("aceita somente chave base64 canônica de 32 bytes", () => {
    const encoded = Buffer.alloc(32, 9).toString("base64");
    expect(decodePlatformOperatorHmacKeyBase64(encoded)).toHaveLength(32);
    expect(() => decodePlatformOperatorHmacKeyBase64("invalid")).toThrow(
      PlatformDigestInputError,
    );
  });
});
