import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  listPlatformCredentialLinkQueue,
  PlatformQueueContractError,
} from "../../src/platform-console-reader.js";

const input = {
  actorDigest: Buffer.alloc(32, 1),
  actorIp: "127.0.0.1",
  limit: 50,
  reasonTicketDigest: Buffer.alloc(32, 2),
  traceDigest: Buffer.alloc(32, 3),
};

function pool(rows: unknown[]): Pool {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as Pool;
}

const empty = {
  cursor_priority: null,
  establishment_id: null,
  link_status: null,
  link_updated_at: null,
  tenant_display_name: null,
  tenant_id: null,
  trade_name: null,
  truncated: false,
};

describe("listPlatformCredentialLinkQueue", () => {
  it("distingue acesso negado de fila autorizada vazia", async () => {
    await expect(
      listPlatformCredentialLinkQueue(
        pool([{ ...empty, authorized: false }]),
        input,
      ),
    ).resolves.toEqual({ authorized: false });
    await expect(
      listPlatformCredentialLinkQueue(
        pool([{ ...empty, authorized: true }]),
        input,
      ),
    ).resolves.toEqual({ authorized: true, entries: [], truncated: false });
  });

  it("mapeia página sanitizada e cursor somente quando truncada", async () => {
    const updatedAt = new Date("2026-11-24T12:34:56.000Z");
    await expect(
      listPlatformCredentialLinkQueue(
        pool([
          {
            authorized: true,
            cursor_priority: 0,
            establishment_id: "22222222-2222-4222-8222-222222222222",
            link_status: "pending",
            link_updated_at: updatedAt,
            tenant_display_name: "Tenant A",
            tenant_id: "11111111-1111-4111-8111-111111111111",
            trade_name: "Loja A",
            truncated: true,
          },
        ]),
        input,
      ),
    ).resolves.toMatchObject({
      authorized: true,
      entries: [
        expect.objectContaining({
          linkStatus: "pending",
          tenantDisplayName: "Tenant A",
          tradeName: "Loja A",
        }),
      ],
      nextCursor: {
        establishmentId: "22222222-2222-4222-8222-222222222222",
        priority: 0,
        tenantId: "11111111-1111-4111-8111-111111111111",
        updatedAt,
      },
      truncated: true,
    });
  });

  it.each([
    { rows: [] },
    {
      rows: [
        { ...empty, authorized: false },
        { ...empty, authorized: true },
      ],
    },
    {
      rows: [{ ...empty, authorized: true, truncated: true }],
    },
    {
      rows: [
        {
          ...empty,
          authorized: true,
          cursor_priority: 5,
          establishment_id: "22222222-2222-4222-8222-222222222222",
          link_status: "pending",
          link_updated_at: new Date(),
          tenant_display_name: "Tenant A",
          tenant_id: "11111111-1111-4111-8111-111111111111",
          trade_name: "Loja A",
        },
      ],
    },
  ])("recusa resposta impossível %#", async ({ rows }) => {
    await expect(
      listPlatformCredentialLinkQueue(pool(rows), input),
    ).rejects.toBeInstanceOf(PlatformQueueContractError);
  });
});
