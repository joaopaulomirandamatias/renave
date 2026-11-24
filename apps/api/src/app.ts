import type { IdentityService } from "@seu-renave/identity";
import Fastify, { type FastifyInstance } from "fastify";

import { redactedLogPaths, stripQuery } from "./auth/redaction.js";
import {
  createRequestAccessGuard,
  type TenantActionRunner,
} from "./auth/request-access-guard.js";
import {
  registerAuthRoutes,
  type LoginRateLimiter,
  type SessionLookupGate,
} from "./auth/routes.js";
import type { AppConfig } from "./config.js";
import type { PlatformConsole } from "./platform/console.js";
import { registerPlatformRoutes } from "./platform/routes.js";
import {
  registerRenaveRoutes,
  type SerproQueryLimiter,
  type StockQueryUseCase,
  type VehicleLookupUseCase,
} from "./renave/routes.js";
import type { EligibilityUseCase } from "./renave/use-case.js";
import type { RenaveLinkStatusUseCase } from "./renave/link-status-use-case.js";
import type { RenaveLinkPreflightUseCase } from "./renave/preflight-use-case.js";
import type { RenaveReadinessUseCase } from "./renave/readiness-use-case.js";
import {
  registerStockEntryOperationRoute,
  type Clock,
  type StockEntryMutationRateLimiter,
  type StockEntryOperationUseCase,
} from "./renave/stock-entry-operations.js";
import type {
  TenantEstablishmentAdministration,
  TenantMutationRateLimiter,
} from "./tenant/admin-establishments.js";
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
  /** Diagnóstico local e sanitizado da prontidão por estabelecimento. */
  renaveReadiness?: RenaveReadinessUseCase;
  /** Limite distribuído obrigatório quando a consulta RENAVE está composta. */
  serproQueryLimiter?: SerproQueryLimiter;
  /** Consulta pontual e minimizada de estoque por placa. */
  stockQuery?: StockQueryUseCase;
  /** Consulta sanitizada do veículo após prova de estoque confirmado. */
  vehicleLookup?: VehicleLookupUseCase;
  /**
   * Criação local retida de entrada usada; nunca envia ao SERPRO.
   * O app chama `destroy` do caso de uso no onClose. O compositor continua
   * dono dos recursos criptográficos emprestados e deve destruí-los depois de
   * fechar todos os consumidores que os compartilham.
   */
  stockEntryOperation?: StockEntryOperationUseCase;
  /** Relógio civil explícito da validação da entrada (injetável em testes). */
  stockEntryClock?: Clock;
  /** Zona IANA da data civil comercial; padrão seguro: America/Sao_Paulo. */
  stockEntryBusinessTimeZone?: string;
  /** Limite distribuído obrigatório da criação local retida. */
  stockEntryMutationRateLimiter?: StockEntryMutationRateLimiter;
  /** Diretório global mínimo; ausente mantém descoberta de tenants bloqueada. */
  tenantDirectory?: TenantDirectory;
  /** Mutação administrativa atômica; ausente mantém o POST bloqueado. */
  tenantEstablishmentAdministration?: TenantEstablishmentAdministration;
  /** Limitador distribuído das mutações administrativas. */
  tenantMutationRateLimiter?: TenantMutationRateLimiter;
  /** Autoriza e executa a mutação no mesmo contexto transacional RLS. */
  tenantActionRunner?: TenantActionRunner;
  /** Leitor global isolado; só é aceito quando a capability está configurada. */
  platformConsole?: PlatformConsole;
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
    (options.eligibility ||
      options.preflight ||
      options.stockQuery ||
      options.vehicleLookup) &&
    !options.serproQueryLimiter
  ) {
    throw new Error("Consulta RENAVE exige limitador distribuído");
  }
  if (
    options.tenantEstablishmentAdministration &&
    (!options.tenantMutationRateLimiter || !options.tenantActionRunner)
  ) {
    throw new Error(
      "Administração de estabelecimento exige runner e rate limit distribuído",
    );
  }
  if (options.stockEntryOperation && !options.stockEntryMutationRateLimiter) {
    throw new Error("Entrada de estoque exige rate limit distribuído");
  }
  if (options.config.platformConsole && !options.platformConsole) {
    throw new Error("Console global exige leitor de plataforma configurado");
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

  if (options.stockEntryOperation?.destroy) {
    app.addHook("onClose", async () => {
      options.stockEntryOperation?.destroy?.();
    });
  }

  const accessGuard = options.identity
    ? createRequestAccessGuard({
        identity: options.identity,
        secure: options.config.appEnvironment !== "development",
        ...(options.sessionLookupGate
          ? { sessionLookupGate: options.sessionLookupGate }
          : {}),
      })
    : undefined;

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
    ...(accessGuard ? { accessGuard } : {}),
    config: options.config,
    identity: options.identity,
    ...(options.loginRateLimiter
      ? { loginRateLimiter: options.loginRateLimiter }
      : {}),
  });
  if (options.identity) {
    if (!accessGuard) throw new Error("Guard de acesso não configurado");
    registerTenantRoutes(app, {
      accessGuard,
      publicOrigin: options.identity.config.publicOrigin,
      ...(options.tenantEstablishmentAdministration
        ? { administration: options.tenantEstablishmentAdministration }
        : {}),
      ...(options.tenantDirectory
        ? { directory: options.tenantDirectory }
        : {}),
      ...(options.tenantMutationRateLimiter
        ? { mutationRateLimiter: options.tenantMutationRateLimiter }
        : {}),
      ...(options.tenantActionRunner
        ? { tenantActionRunner: options.tenantActionRunner }
        : {}),
    });
    registerRenaveRoutes(app, {
      accessGuard,
      config: options.config,
      identity: options.identity,
      ...(options.eligibility ? { eligibility: options.eligibility } : {}),
      ...(options.linkStatus ? { linkStatus: options.linkStatus } : {}),
      ...(options.preflight ? { preflight: options.preflight } : {}),
      ...(options.renaveReadiness
        ? { readiness: options.renaveReadiness }
        : {}),
      ...(options.stockQuery ? { stockQuery: options.stockQuery } : {}),
      ...(options.vehicleLookup
        ? { vehicleLookup: options.vehicleLookup }
        : {}),
      ...(options.serproQueryLimiter
        ? { queryLimiter: options.serproQueryLimiter }
        : {}),
    });
    registerStockEntryOperationRoute(app, {
      accessGuard,
      publicOrigin: options.identity.config.publicOrigin,
      ...(options.stockEntryBusinessTimeZone
        ? { businessTimeZone: options.stockEntryBusinessTimeZone }
        : {}),
      ...(options.stockEntryClock ? { clock: options.stockEntryClock } : {}),
      ...(options.stockEntryMutationRateLimiter
        ? { mutationRateLimiter: options.stockEntryMutationRateLimiter }
        : {}),
      ...(options.stockEntryOperation
        ? { operation: options.stockEntryOperation }
        : {}),
    });
    if (options.config.platformConsole && options.platformConsole) {
      registerPlatformRoutes(app, {
        accessGuard,
        console: options.platformConsole,
        mfaMaxAgeSeconds: options.config.platformConsole.mfaMaxAgeSeconds,
      });
    }
  }

  return app;
}
