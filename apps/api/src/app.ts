import type { IdentityService } from "@seu-renave/identity";
import Fastify, { type FastifyInstance } from "fastify";

import { redactedLogPaths, stripQuery } from "./auth/redaction.js";
import {
  registerAuthRoutes,
  type LoginRateLimiter,
  type SessionLookupGate,
} from "./auth/routes.js";
import type { AppConfig } from "./config.js";
import {
  registerRenaveRoutes,
  type SerproQueryLimiter,
  type StockQueryUseCase,
} from "./renave/routes.js";
import type { EligibilityUseCase } from "./renave/use-case.js";
import type { RenaveLinkStatusUseCase } from "./renave/link-status-use-case.js";
import type { RenaveLinkPreflightUseCase } from "./renave/preflight-use-case.js";
import { registerTenantRoutes, type TenantDirectory } from "./tenant/routes.js";

export interface BuildAppOptions {
  config: AppConfig;
  /**
   * Serviço de identidade (porta). Obrigatório com `AUTH_MODE=oidc`; em testes
   * recebe um IdP falso, em produção vem de `composeIdentity`.
   */
  identity?: IdentityService;
  /** Limitador distribuído do login público. Obrigatório em produção OIDC. */
  loginRateLimiter?: LoginRateLimiter;
  /** Gate local que preserva o pool contra consultas de sessão concorrentes. */
  sessionLookupGate?: SessionLookupGate;
  /** Consulta RENAVE já composta; ausente mantém a integração bloqueada. */
  eligibility?: EligibilityUseCase;
  /** Leitura autorizada do estado local do vínculo RENAVE. */
  linkStatus?: RenaveLinkStatusUseCase;
  /** Verificação read-only do vínculo CNPJ/certificado em homologação. */
  preflight?: RenaveLinkPreflightUseCase;
  /** Limite distribuído obrigatório quando a consulta RENAVE está composta. */
  serproQueryLimiter?: SerproQueryLimiter;
  /** Consulta pontual e minimizada de estoque por placa. */
  stockQuery?: StockQueryUseCase;
  /** Diretório global mínimo; ausente mantém descoberta de tenants bloqueada. */
  tenantDirectory?: TenantDirectory;
  /** Probe das dependências já compostas pelo runtime. */
  ready?: () => Promise<boolean>;
  logger?: boolean;
  /** Destino dos logs (testes de redação). */
  logStream?: NodeJS.WritableStream;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  if (options.config.authMode === "oidc" && !options.identity) {
    // Falha fechada: nunca subir em modo OIDC sem um serviço de identidade.
    throw new Error("AUTH_MODE=oidc exige um serviço de identidade");
  }
  if (
    options.config.appEnvironment !== "development" &&
    options.config.authMode === "oidc" &&
    !options.loginRateLimiter
  ) {
    throw new Error(
      "OIDC fora de desenvolvimento exige rate limit distribuído",
    );
  }
  if (
    options.config.appEnvironment !== "development" &&
    options.config.authMode === "oidc" &&
    !options.sessionLookupGate
  ) {
    throw new Error(
      "OIDC fora de desenvolvimento exige gate de consulta de sessão",
    );
  }
  if (
    (options.eligibility || options.preflight || options.stockQuery) &&
    !options.serproQueryLimiter
  ) {
    throw new Error("Consulta RENAVE exige limitador distribuído");
  }

  const app = Fastify({
    trustProxy:
      options.config.proxyTrust.mode === "trusted-proxy"
        ? [...options.config.proxyTrust.cidrs]
        : false,
    logger:
      options.logger === false
        ? false
        : {
            redact: { paths: redactedLogPaths, remove: true },
            serializers: {
              req(request) {
                return {
                  method: request.method,
                  url: stripQuery(request.url),
                };
              },
            },
            ...(options.logStream ? { stream: options.logStream } : {}),
          },
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    return payload;
  });

  app.get("/health", async () => ({ service: "seu-renave-api", status: "ok" }));

  app.get("/readiness", async (_request, reply) => {
    const ready = options.ready ? await options.ready() : true;
    return reply.code(ready ? 200 : 503).send({
      authMode: options.config.authMode,
      environment: options.config.appEnvironment,
      service: "seu-renave-api",
      status: ready ? "ready" : "not_ready",
    });
  });

  registerAuthRoutes(app, {
    config: options.config,
    identity: options.identity,
    ...(options.loginRateLimiter
      ? { loginRateLimiter: options.loginRateLimiter }
      : {}),
    ...(options.sessionLookupGate
      ? { sessionLookupGate: options.sessionLookupGate }
      : {}),
  });
  if (options.identity) {
    registerTenantRoutes(app, {
      config: options.config,
      identity: options.identity,
      ...(options.sessionLookupGate
        ? { sessionLookupGate: options.sessionLookupGate }
        : {}),
      ...(options.tenantDirectory
        ? { directory: options.tenantDirectory }
        : {}),
    });
    registerRenaveRoutes(app, {
      config: options.config,
      identity: options.identity,
      ...(options.eligibility ? { eligibility: options.eligibility } : {}),
      ...(options.linkStatus ? { linkStatus: options.linkStatus } : {}),
      ...(options.preflight ? { preflight: options.preflight } : {}),
      ...(options.stockQuery ? { stockQuery: options.stockQuery } : {}),
      ...(options.sessionLookupGate
        ? { sessionLookupGate: options.sessionLookupGate }
        : {}),
      ...(options.serproQueryLimiter
        ? { queryLimiter: options.serproQueryLimiter }
        : {}),
    });
  }

  return app;
}
