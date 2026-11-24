import type { AuthenticatedSession } from "@seu-renave/identity";
import Fastify, { type FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAccessGuard } from "../auth/request-access-guard.js";
import type { PlatformConsole } from "./console.js";
import { registerPlatformRoutes } from "./routes.js";

function setup(options: {
  accessAllowed?: boolean;
  acquireAllowed?: boolean;
  acquireImplementation?: () => Promise<unknown>;
  authenticated?: boolean;
  authorizeImplementation?: () => Promise<boolean>;
  authorized?: boolean;
  issuer?: string;
  listImplementation?: () => Promise<unknown>;
  mfaVerified?: boolean;
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
  const authorize = vi.fn(
    options.authorizeImplementation ??
      (async () => options.accessAllowed !== false),
  );
  const authenticate = vi.fn(
    async (
      request: { headers: Record<string, unknown> },
      reply: FastifyReply,
    ) => {
      if (options.authenticated === false) {
        await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
        return { ok: false as const };
      }
      return {
        ok: true as const,
        session: {
          expiresAt: Date.now() + 60_000,
          issuer: options.issuer ?? "https://idp.test",
          mfaVerified: options.mfaVerified ?? true,
          mfaVerifiedAt: options.mfaVerifiedAt ?? Date.now(),
          roles: ["platform_admin_from_idp"],
          subject:
            (typeof request.headers["x-test-subject"] === "string"
              ? request.headers["x-test-subject"]
              : undefined) ??
            options.subject ??
            "subject-1",
        },
      };
    },
  );
  const enforceRecentMfa = vi.fn(
    async (
      session: AuthenticatedSession,
      reply: FastifyReply,
      maxAgeSeconds?: number,
    ) => {
      if (session.mfaVerified !== true) {
        await reply.code(403).send({ code: "MFA_REQUIRED" });
        return { ok: false as const };
      }
      const now = Date.now();
      if (
        maxAgeSeconds !== undefined &&
        (typeof session.mfaVerifiedAt !== "number" ||
          session.mfaVerifiedAt > now ||
          now - session.mfaVerifiedAt > maxAgeSeconds * 1_000)
      ) {
        await reply.code(403).send({ code: "MFA_RECENT_REQUIRED" });
        return { ok: false as const };
      }
      return { ok: true as const };
    },
  );
  const app = Fastify({ logger: false });
  registerPlatformRoutes(app, {
    accessGuard: {
      authenticate,
      enforceRecentMfa,
    } as unknown as RequestAccessGuard,
    console: {
      acquire,
      authorize,
      destroy: vi.fn(),
      list,
    } as unknown as PlatformConsole,
    mfaMaxAgeSeconds: 300,
  });
  return {
    acquire,
    app,
    authenticate,
    authorize,
    enforceRecentMfa,
    list,
  };
}

describe("rotas do console global", () => {
  it("exige sessão antes de consultar a capability", async () => {
    const context = setup({ authenticated: false });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(context.authorize).not.toHaveBeenCalled();
    expect(context.enforceRecentMfa).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("oculta o recurso sem grant antes de exigir MFA", async () => {
    const denied = setup({ accessAllowed: false, mfaVerified: false });
    const response = await denied.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "PLATFORM_RESOURCE_NOT_FOUND",
    });
    expect(denied.authenticate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
    );
    expect(denied.authorize).toHaveBeenCalledOnce();
    expect(denied.enforceRecentMfa).not.toHaveBeenCalled();
    expect(denied.acquire).not.toHaveBeenCalled();
    expect(denied.list).not.toHaveBeenCalled();
    await denied.app.close();
  });

  it("oculta a fila sem grant antes de MFA, ticket e limitadores", async () => {
    const denied = setup({ accessAllowed: false, mfaVerified: false });
    const response = await denied.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "PLATFORM_RESOURCE_NOT_FOUND",
    });
    expect(denied.authorize).toHaveBeenCalledOnce();
    expect(denied.enforceRecentMfa).not.toHaveBeenCalled();
    expect(denied.acquire).not.toHaveBeenCalled();
    expect(denied.list).not.toHaveBeenCalled();
    await denied.app.close();
  });

  it.each([
    ["issuer", { issuer: "" }],
    ["subject", { subject: "" }],
  ] as const)(
    "oculta o recurso quando a sessão não tem %s",
    async (_field, partial) => {
      const context = setup(partial);
      const response = await context.app.inject({
        method: "GET",
        url: "/api/platform/access",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "PLATFORM_RESOURCE_NOT_FOUND",
      });
      expect(context.authorize).not.toHaveBeenCalled();
      expect(context.enforceRecentMfa).not.toHaveBeenCalled();
      await context.app.close();
    },
  );

  it("exige MFA somente depois de confirmar o grant", async () => {
    const context = setup({ mfaVerified: false });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "MFA_REQUIRED" });
    expect(context.authorize).toHaveBeenCalledOnce();
    expect(context.enforceRecentMfa).toHaveBeenCalledOnce();
    expect(context.acquire).not.toHaveBeenCalled();
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("exige MFA da fila antes de validar ticket ou consumir limitadores", async () => {
    const context = setup({ mfaVerified: false });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "MFA_REQUIRED" });
    expect(context.authorize).toHaveBeenCalledOnce();
    expect(context.acquire).not.toHaveBeenCalled();
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("exige MFA recente somente depois de confirmar o grant", async () => {
    const context = setup({ mfaVerifiedAt: Date.now() - 301_000 });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "MFA_RECENT_REQUIRED" });
    expect(context.authorize).toHaveBeenCalledOnce();
    expect(context.acquire).not.toHaveBeenCalled();
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("autoriza o preflight sem ticket, fila ou rate limiter", async () => {
    const context = setup({});
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(context.authorize).toHaveBeenCalledOnce();
    expect(context.enforceRecentMfa).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "subject-1" }),
      expect.anything(),
      300,
    );
    expect(context.acquire).not.toHaveBeenCalled();
    expect(context.list).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("sanitiza falha da capability sem vazar identidade", async () => {
    const context = setup({
      authorizeImplementation: async () => {
        throw new Error("subject-1 database internals");
      },
    });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/access",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "PLATFORM_ACCESS_UNAVAILABLE",
    });
    expect(response.body).not.toContain("subject-1");
    expect(response.body).not.toContain("database internals");
    expect(context.enforceRecentMfa).not.toHaveBeenCalled();
    await context.app.close();
  });

  it("reautoriza a fila e oculta grant revogado após o preflight", async () => {
    const context = setup({ authorized: false });
    expect(
      (
        await context.app.inject({
          method: "GET",
          url: "/api/platform/access",
        })
      ).statusCode,
    ).toBe(204);
    const response = await context.app.inject({
      method: "GET",
      url: "/api/platform/renave-link-queue",
      headers: { "x-renave-reason-ticket": "SEC-1234" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "PLATFORM_RESOURCE_NOT_FOUND",
    });
    expect(context.authorize).toHaveBeenCalledTimes(2);
    expect(context.list).toHaveBeenCalledOnce();
    await context.app.close();
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
