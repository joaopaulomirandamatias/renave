import { describe, expect, it, vi } from "vitest";

import { listTenantMembers } from "../../src/authorization.js";
import type { TenantClient } from "../../src/tenant-context.js";

const ESTABLISHMENT_A = "22222222-2222-4222-8222-222222222222";
const ESTABLISHMENT_B = "33333333-3333-4333-8333-333333333333";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("listTenantMembers", () => {
  it("agrupa estabelecimentos por (memberId, role), ordena deterministicamente e nunca seleciona subject", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          created_at: new Date("2026-11-20T10:00:00.000Z"),
          establishment_id: null,
          member_digest:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          role: "tenant_admin",
          status: "active",
          subject: "oidc|must-not-leak",
          subject_hash: "raw-hash-must-not-leak",
        },
        {
          created_at: new Date("2026-11-21T10:00:00.000Z"),
          establishment_id: ESTABLISHMENT_B,
          member_digest:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          role: "renave_operator",
          status: "suspended",
        },
        {
          created_at: new Date("2026-11-21T10:00:00.000Z"),
          establishment_id: ESTABLISHMENT_A,
          member_digest:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          role: "renave_operator",
          status: "suspended",
        },
      ],
    }));

    const items = await listTenantMembers({ query } as unknown as TenantClient);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      active: true,
      createdAt: "2026-11-20T10:00:00.000Z",
      establishmentIds: [],
      memberId: expect.stringMatching(UUID_PATTERN),
      role: "tenant_admin",
      status: "active",
    });
    expect(items[1]).toEqual({
      active: false,
      createdAt: "2026-11-21T10:00:00.000Z",
      establishmentIds: [ESTABLISHMENT_A, ESTABLISHMENT_B],
      memberId: expect.stringMatching(UUID_PATTERN),
      role: "renave_operator",
      status: "suspended",
    });
    expect(items[0]!.memberId).not.toBe(items[1]!.memberId);

    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("subject");

    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).not.toMatch(/,\s*u\.subject\b/i);
    expect(sql).not.toMatch(/\bas\s+subject\b/i);
    expect(sql).toContain("pg_catalog.sha256");
  });
});
