import { describe, expect, it, vi } from "vitest";

import { purgeExpiredIdentityBacklog } from "../../src/identity-maintenance.js";

describe("purgeExpiredIdentityBacklog", () => {
  it("continua drenando depois de lotes cheios até encontrar lote parcial", async () => {
    const purgeExpiredRecords = vi
      .fn()
      .mockResolvedValueOnce({
        loginAttemptsDeleted: 1_000,
        sessionsDeleted: 1_000,
      })
      .mockResolvedValueOnce({
        loginAttemptsDeleted: 1_000,
        sessionsDeleted: 3,
      })
      .mockResolvedValueOnce({ loginAttemptsDeleted: 17, sessionsDeleted: 0 });

    await expect(
      purgeExpiredIdentityBacklog(
        { purgeExpiredRecords },
        { now: () => 1_800_000_000_000 },
      ),
    ).resolves.toEqual({
      backlogMayRemain: false,
      batches: 3,
      loginAttemptsDeleted: 2_017,
      sessionsDeleted: 1_003,
    });
    expect(purgeExpiredRecords).toHaveBeenCalledTimes(3);
  });

  it("para no limite de lotes e sinaliza possível backlog", async () => {
    const purgeExpiredRecords = vi.fn().mockResolvedValue({
      loginAttemptsDeleted: 10,
      sessionsDeleted: 10,
    });

    await expect(
      purgeExpiredIdentityBacklog(
        { purgeExpiredRecords },
        { batchSize: 10, maxBatches: 2, now: () => 1_800_000_000_000 },
      ),
    ).resolves.toMatchObject({ backlogMayRemain: true, batches: 2 });
  });
});
