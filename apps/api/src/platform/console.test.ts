import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { derivePlatformActorDigest } from "@seu-renave/db/api-runtime";

import {
  decodePlatformOperatorHmacKeyBase64,
  PlatformConsoleInputError,
  PostgresPlatformConsole,
} from "./console.js";

function pool(rows: unknown[]): Pool {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as Pool;
}

const denied = {
  authorized: false,
  cursor_priority: null,
  establishment_id: null,
  link_status: null,
  link_updated_at: null,
  tenant_display_name: null,
  tenant_id: null,
  trade_name: null,
  truncated: false,
};

describe("PostgresPlatformConsole", () => {
  it("usa o mesmo digest de ator no limitador distribuído", async () => {
    let captured: unknown[] = [];
    const database = {
      query: vi.fn(async (_sql: string, parameters: unknown[]) => {
        captured = parameters.map((value) =>
          Buffer.isBuffer(value) ? Buffer.from(value) : value,
        );
        return { rows: [{ allowed: true, retry_after_seconds: 0 }] };
      }),
    } as unknown as Pool;
    const console = new PostgresPlatformConsole(database, Buffer.alloc(32, 7));
    await expect(
      console.acquire({ issuer: "https://idp.test", subject: "subject-1" }),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(captured).toEqual([
      derivePlatformActorDigest(
        Buffer.alloc(32, 7),
        "https://idp.test",
        "subject-1",
      ),
    ]);
    console.destroy();
  });

  it("gera digests separados e nunca envia valores brutos ao banco", async () => {
    let captured: unknown[] = [];
    const database = {
      query: vi.fn(async (_sql: string, parameters: unknown[]) => {
        captured = parameters.map((value) =>
          Buffer.isBuffer(value) ? Buffer.from(value) : value,
        );
        return { rows: [denied] };
      }),
    } as unknown as Pool;
    const console = new PostgresPlatformConsole(database, Buffer.alloc(32, 7));
    await expect(
      console.list({
        actorIp: "127.0.0.1",
        issuer: "https://idp.test",
        limit: 50,
        reasonTicket: "SEC-1234",
        subject: "subject-1",
        traceId: "trace-1",
      }),
    ).resolves.toEqual({ authorized: false, entries: [], truncated: false });
    const parameters = captured;
    expect(parameters.slice(0, 4)).toEqual([
      expect.any(Buffer),
      expect.any(Buffer),
      "127.0.0.1",
      expect.any(Buffer),
    ]);
    expect(parameters[0]).not.toEqual(parameters[1]);
    expect(parameters[0]).toEqual(
      derivePlatformActorDigest(
        Buffer.alloc(32, 7),
        "https://idp.test",
        "subject-1",
      ),
    );
    expect(JSON.stringify(parameters)).not.toContain("subject-1");
    expect(JSON.stringify(parameters)).not.toContain("SEC-1234");
    expect(JSON.stringify(parameters)).not.toContain("trace-1");
    console.destroy();
  });

  it("recusa cursor adulterado antes da consulta", async () => {
    const database = pool([denied]);
    const console = new PostgresPlatformConsole(database, Buffer.alloc(32, 7));
    await expect(
      console.list({
        actorIp: "127.0.0.1",
        cursor: `${"A".repeat(20)}.${"B".repeat(43)}`,
        issuer: "https://idp.test",
        limit: 50,
        reasonTicket: "SEC-1234",
        subject: "subject-1",
        traceId: "trace-1",
      }),
    ).rejects.toBeInstanceOf(PlatformConsoleInputError);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("autentica e reutiliza o cursor completo sem perder componentes", async () => {
    const firstUpdatedAt = new Date("2026-11-24T12:34:56.000Z");
    const database = pool([
      {
        authorized: true,
        cursor_priority: 0,
        establishment_id: "22222222-2222-4222-8222-222222222222",
        link_status: "pending",
        link_updated_at: firstUpdatedAt,
        tenant_display_name: "Tenant A",
        tenant_id: "11111111-1111-4111-8111-111111111111",
        trade_name: "Loja A",
        truncated: true,
      },
    ]);
    const console = new PostgresPlatformConsole(database, Buffer.alloc(32, 7));
    const first = await console.list({
      actorIp: "127.0.0.1",
      issuer: "https://idp.test",
      limit: 1,
      reasonTicket: "SEC-1234",
      subject: "subject-1",
      traceId: "trace-1",
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) throw new Error("cursor esperado");
    await console.list({
      actorIp: "127.0.0.1",
      cursor: first.nextCursor,
      issuer: "https://idp.test",
      limit: 1,
      reasonTicket: "SEC-1235",
      subject: "subject-1",
      traceId: "trace-2",
    });
    expect(database.query).toHaveBeenLastCalledWith(expect.any(String), [
      expect.any(Buffer),
      expect.any(Buffer),
      "127.0.0.1",
      expect.any(Buffer),
      0,
      firstUpdatedAt,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      1,
    ]);
    console.destroy();
  });

  it("aceita apenas chave canônica de 32 bytes", () => {
    expect(
      decodePlatformOperatorHmacKeyBase64(
        Buffer.alloc(32, 9).toString("base64"),
      ),
    ).toHaveLength(32);
    expect(() => decodePlatformOperatorHmacKeyBase64("not-a-key")).toThrow(
      PlatformConsoleInputError,
    );
  });
});
