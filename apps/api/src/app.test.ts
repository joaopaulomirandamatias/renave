import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp(environment: NodeJS.ProcessEnv = {}) {
  const app = buildApp({ config: loadConfig(environment), logger: false });
  apps.push(app);
  return app;
}

describe("fundação da API", () => {
  it("expõe saúde sem informações sensíveis", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "seu-renave-api",
      status: "ok",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("falha fechada quando a identidade ainda não está configurada", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/auth/login",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
  });

  it.each(["/api/platform/access", "/api/platform/renave-link-queue"])(
    "oculta a rota global desabilitada em %s com o contrato 404 sanitizado",
    async (url) => {
      const response = await createApp().inject({ method: "GET", url });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "PLATFORM_RESOURCE_NOT_FOUND",
      });
    },
  );

  it("readiness reflete dependências sem revelar qual falhou", async () => {
    const app = buildApp({
      config: loadConfig(),
      logger: false,
      ready: async () => false,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/readiness" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      authMode: "disabled",
      environment: "development",
      service: "seu-renave-api",
      status: "not_ready",
    });
    expect(response.body).not.toMatch(
      /certificate|cnpj|database|expiry|fingerprint|path|serial/iu,
    );
  });

  it("recusa produção sem OIDC", () => {
    expect(() =>
      loadConfig({ APP_ENVIRONMENT: "production", AUTH_MODE: "disabled" }),
    ).toThrow("AUTH_MODE=oidc é obrigatório em produção");
  });
});
