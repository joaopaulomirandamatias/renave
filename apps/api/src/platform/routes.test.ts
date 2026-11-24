import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAccessGuard } from "../auth/request-access-guard.js";
import type { PlatformConsole } from "./console.js";
import { registerPlatformRoutes } from "./routes.js";

function setup(options: {
  acquireAllowed?: boolean;
  acquireImplementation?: () => Promise<unknown>;
  authorized?: boolean;
  issuer?: string;
  listImplementation?: () => Promise<unknown>;
  mfaVerifiedAt?: number;
  subject?: string;
}) {
  const list = vi.fn(
    options.listImplementation ??
      (async () =>
        options.authorized === false
          ? { authorized: false, entries: [], truncated: false }
          : {
              authorized: true,
              entries: [
                {
                  establishmentId: "22222222-2222-4222-8222-222222222222",
                  linkStatus: "pending" as const,
                  tenantDisplayName: "Tenant A",
                  tenantId: "11111111-1111-4111-8111-111111111111",
                  tradeName: "Loja A",
                  updatedAt: new Date("2026-11-24T12:34:56.000Z"),
                },
              ],
              truncated: false,
            }),
  );
  const acquire = vi.fn(
    options.acquireImplementation ??
      (async () =>
        options.acquireAllowed === false
          ? { allowed: false, retryAfterSeconds: 37 }
          : { allowed: true, retryAfterSeconds: 0 }),
  );
  const authenticate = vi.fn(
    async (request: { headers: Record<string, unknown> }) => ({
      ok: true as const,
      session: {
        expiresAt: Date.now() + 60_000,
        issuer: options.issuer ?? "https://idp.test",
        mfaVerified: true,
        mfaVerifiedAt: options.mfaVerifiedAt ?? Date.now(),
        roles: ["platform_admin_from_idp"],
        subject:
          (typeof request.headers["x-test-subject"] === "string"
            ? request.headers["x-test-subject"]
            : undefined) ??
          options.subject ??
          "subject-1",
      },
    }),
  );
  const app = Fastify({ logger: false });
  registerPlatformRoutes(app, {
    accessGuard: { authenticate } as unknown as RequestAccessGuard,
    console: { acquire, destroy: vi.fn(), list } as unknown as PlatformConsole,
    mfaMaxAgeSeconds: 300,
  });
  return { acquire, app, authenticate, list };
}

describe("rotas do console global", () => {
  it("exige MFA recente e ignora role administrativa do IdP", async () => {
    const denied = setup({ authorized: false });
    const response = await denied.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "ACCESS_DENIED" });
    expect(denied.authenticate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { mfa: "required", mfaMaxAgeSeconds: 300 },
    );
    expect(denied.list).toHaveBeenCalledOnce();
    await denied.app.close();
  });

  it("rejeita ticket ausente antes do leitor", async () => {
    const context = setup({});
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
    });
    expect(response.statusCode).toBe(400);
    expect(context.list).not.toHaveBeenCalled();
    expect(context.acquire).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("rejeita query e cursor inválidos antes do limitador", async () => {
    const context = setup({});
    for (const url of [
      "/api/platform/renave-link-queue?limit=0",
      "/api/platform/renave-link-queue?unknown=1",
      `/api/platform/renave-link-queue?cursor=${"A".repeat(513)}`,
    ]) {
      const response = await context.app.inject({
        method: "GET",
        url,
        headers: { "x-renave-reason-ticket": "SEC-1234" },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(context.acquire).not.toHaveBeenCalled();
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("aplica limite distribuído antes da fila auditada", async () => {
    const context = setup({ acquireAllowed: false });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("37");
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("falha fechado quando o limitador distribuído fica indisponível", async () => {
    const context = setup({
      acquireImplementation: async () => {
        throw new Error("database detail that must not be returned");
      },
    });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("database detail");
    expect(response.body).not.toContain("SEC-1234");
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("limita concorrência global local sem ocupar uma terceira consulta", async () => {
    const releases: Array<() => void> = [];
    const context = setup({
      listImplementation: () =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve({ authorized: true, entries: [], truncated: false }),
          );
        }),
    });
    const request = (subject: string) =>
      context.app.inject({
        method: "GET",
        url: "/api/platform/renave-link-queue",
        headers: {
          "x-renave-reason-ticket": "SEC-1234",
          "x-test-subject": subject,
        },
      });
    const first = request("subject-1");
    const second = request("subject-2");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const third = await request("subject-3");
    expect(third.statusCode).toBe(429);
    expect(context.list).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await context.app.close();
  });

  it("limita concorrência do mesmo ator e libera o gate após erro", async () => {
    let releaseFirst!: () => void;
    const context = setup({
      listImplementation: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              releaseFirst = () => reject(new Error("reader unavailable"));
            }),
        )
        .mockResolvedValue({ authorized: true, entries: [], truncated: false }),
    });
    const request = () =>
      context.app.inject({
        method: "GET",
        url: "/api/platform/renave-link-queue",
        headers: { "x-renave-reason-ticket": "SEC-1234" },
      });
    const first = request();
    await vi.waitFor(() => expect(context.list).toHaveBeenCalledOnce());
    expect((await request()).statusCode).toBe(429);
    releaseFirst();
    expect((await first).statusCode).toBe(503);
    expect((await request()).statusCode).toBe(200);
    await context.app.close();
  });

  it("devolve somente a projeção sanitizada", async () => {
    const context = setup({});
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue?limit=25",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          establishment: {
            id: "22222222-2222-4222-8222-222222222222",
            tradeName: "Loja A",
          },
          renaveLink: {
            status: "pending",
            updatedAt: "2026-11-24T12:34:56.000Z",
          },
          tenant: {
            displayName: "Tenant A",
            id: "11111111-1111-4111-8111-111111111111",
          },
        },
      ],
      truncated: false,
    });
    expect(response.body).not.toContain("cnpj");
    expect(response.body).not.toContain("subject-1");
    expect(response.body).not.toContain("SEC-1234");
    await context.app.close();
  });

  it("representa fila autorizada vazia sem cursor", async () => {
    const context = setup({
      listImplementation: async () => ({
        authorized: true,
        entries: [],
        truncated: false,
      }),
    });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], truncated: false });
    await context.app.close();
  });
});
