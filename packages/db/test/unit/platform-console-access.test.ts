import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  authorizePlatformConsoleAccess,
  PlatformAccessContractError,
} from "../../src/platform-console-access.js";

function pool(rows: unknown[]): Pool {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as Pool;
}

describe("authorizePlatformConsoleAccess", () => {
  it.each([true, false])(
    "aceita exatamente uma decisão booleana: %s",
    async (authorized) => {
      await expect(
        authorizePlatformConsoleAccess(
          pool([{ authorized }]),
          Buffer.alloc(32, 1),
        ),
      ).resolves.toBe(authorized);
    },
  );

  const impossibleResponses: Array<{ rows: unknown[] }> = [
    { rows: [] },
    { rows: [{ authorized: true }, { authorized: false }] },
    { rows: [{ authorized: 1 }] },
    { rows: [{ authorized: null }] },
  ];

  it.each(impossibleResponses)(
    "recusa resposta impossível %#",
    async ({ rows }) => {
      await expect(
        authorizePlatformConsoleAccess(pool(rows), Buffer.alloc(32, 1)),
      ).rejects.toBeInstanceOf(PlatformAccessContractError);
    },
  );

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])(
    "recusa digest fora de 32 bytes",
    async (actorDigest) => {
      const db = pool([{ authorized: true }]);
      await expect(
        authorizePlatformConsoleAccess(db, actorDigest),
      ).rejects.toBeInstanceOf(PlatformAccessContractError);
      expect(db.query).not.toHaveBeenCalled();
    },
  );
});
