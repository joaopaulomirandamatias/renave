import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  getEstablishmentRenaveProfileStatus,
  getOperatorIdentityProfileStatus,
  RenaveProfileInputError,
} from "../../src/renave-profiles.js";
import type { TenantClient } from "../../src/tenant-context.js";

function client(query: ReturnType<typeof vi.fn>): TenantClient {
  return { query } as unknown as TenantClient;
}

describe("renave profile status repository", () => {
  it("mapeia somente o status sanitizado do operador", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          profile_status: "verified",
        },
      ],
    });

    await expect(
      getOperatorIdentityProfileStatus(client(query), "oidc|operator-1"),
    ).resolves.toBe("verified");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("get_operator_identity_profile_status"),
      ["oidc|operator-1"],
    );
  });

  it("mapeia ausência sem inventar estado", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      getEstablishmentRenaveProfileStatus(client(query), randomUUID()),
    ).resolves.toBeNull();
  });

  it.each(["", " oidc|operator", "oidc|operator ", "x".repeat(256)])(
    "recusa subject inválido %j antes da consulta",
    async (subject) => {
      const query = vi.fn();
      await expect(
        getOperatorIdentityProfileStatus(client(query), subject),
      ).rejects.toBeInstanceOf(RenaveProfileInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-uuid", "00000000-0000-0000-0000"])(
    "recusa estabelecimento inválido %j antes da consulta",
    async (establishmentId) => {
      const query = vi.fn();
      await expect(
        getEstablishmentRenaveProfileStatus(client(query), establishmentId),
      ).rejects.toBeInstanceOf(RenaveProfileInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );
});
