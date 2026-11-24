import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  acquirePlatformConsolePermit,
  PlatformConsoleRateLimitContractError,
} from "../../src/platform-console-rate-limiter.js";

function pool(rows: unknown[]): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
}

describe("acquirePlatformConsolePermit", () => {
  it("aceita somente uma decisão coerente", async () => {
    await expect(
      acquirePlatformConsolePermit(
        pool([{ allowed: true, retry_after_seconds: 0 }]),
        Buffer.alloc(32, 1),
      ),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(
      acquirePlatformConsolePermit(
        pool([{ allowed: false, retry_after_seconds: 12 }]),
        Buffer.alloc(32, 1),
      ),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 12 });
  });

  it.each([
    { rows: [] },
    { rows: [{ allowed: true, retry_after_seconds: 1 }] },
    { rows: [{ allowed: false, retry_after_seconds: 0 }] },
    { rows: [{ allowed: "true", retry_after_seconds: 0 }] },
  ])("falha fechado para resposta impossível %#", async ({ rows }) => {
    await expect(
      acquirePlatformConsolePermit(pool(rows), Buffer.alloc(32, 1)),
    ).rejects.toBeInstanceOf(PlatformConsoleRateLimitContractError);
  });
});
