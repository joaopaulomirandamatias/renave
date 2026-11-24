import { describe, expect, it, vi } from "vitest";

import {
  CREDENTIAL_LINK_QUEUE_PAGE_SIZE,
  listCredentialLinkQueue,
} from "../../src/credential-links.js";
import type { TenantClient } from "../../src/tenant-context.js";

function client(query: ReturnType<typeof vi.fn>): TenantClient {
  return { query } as unknown as TenantClient;
}

describe("fila de vínculos Credencia", () => {
  it("prioriza os mais antigos e sinaliza truncamento sem expor o item extra", async () => {
    const rows = Array.from(
      { length: CREDENTIAL_LINK_QUEUE_PAGE_SIZE + 1 },
      (_, index) => ({
        establishment_id: `store-${index}`,
        status: "pending" as const,
        trade_name: `Loja ${index}`,
        updated_at: new Date(1_700_000_000_000 + index),
      }),
    );
    const query = vi.fn().mockResolvedValue({ rows });

    const page = await listCredentialLinkQueue(client(query));

    expect(page.truncated).toBe(true);
    expect(page.entries).toHaveLength(CREDENTIAL_LINK_QUEUE_PAGE_SIZE);
    expect(page.entries.at(-1)?.establishmentId).toBe("store-499");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("link.updated_at asc nulls last");
    expect(sql).toContain("limit 501");
  });
});
