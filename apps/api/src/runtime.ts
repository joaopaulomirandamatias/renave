import { X509Certificate } from "node:crypto";

import {
  APP_ROLE,
  assertStockEntryRuntimeKeyGeneration,
  assertRuntimeDatabase,
  decodeLoginRateHmacKeyBase64,
  decodeSerproQueryHmacKeyBase64,
  decodeTenantAdminHmacKeyBase64,
  IDENTITY_APP_ROLE,
  PLATFORM_READER_ROLE,
  PostgresIdentitySessionStore,
  PostgresLoginRateLimiter,
  PostgresSerproQueryLimiter,
  PostgresTenantAdminRateLimiter,
} from "@seu-renave/db/api-runtime";
import {
  decodeEvidenceKeyBase64,
  EvidenceCipher,
} from "@seu-renave/protected-evidence";
import {
  createHomologationRenaveReadOnlyRequest,
  createHomologationPemMtlsClient,
  HttpRenaveReadOnlyTransport,
  RenaveQueryConnector,
  RenaveVehicleLookupConnector,
  type HomologationMtlsClient,
  type MtlsCertificateTemporalStatus,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import { composeIdentity } from "./auth/compose.js";
import { createTenantActionRunner } from "./auth/request-access-guard.js";
import type { TenantActionRunner } from "./auth/request-access-guard.js";
import type { LoginRateLimiter } from "./auth/routes.js";
import type { SessionLookupGate } from "./auth/routes.js";
import { LocalSessionLookupGate } from "./auth/session-lookup-gate.js";
import type { AppConfig } from "./config.js";
import { createRuntimePool } from "./database.js";
import {
  decodePlatformOperatorHmacKeyBase64,
  PostgresPlatformConsole,
  type PlatformConsole,
} from "./platform/console.js";
import { PostgresVehicleEligibilityUseCase } from "./renave/use-case.js";
import { PostgresRenaveLinkStatusUseCase } from "./renave/link-status-use-case.js";
import { readRenaveMtlsMaterial } from "./renave/mtls-material.js";
import { PostgresRenaveLinkPreflightUseCase } from "./renave/preflight-use-case.js";
import { PostgresRenaveReadinessUseCase } from "./renave/readiness-use-case.js";
import type { SerproQueryLimiter } from "./renave/routes.js";
import { PostgresStockQueryUseCase } from "./renave/stock-query-use-case.js";
import { PostgresVehicleLookupUseCase } from "./renave/vehicle-lookup-use-case.js";
import {
  composeStockEntryRuntime,
  type StockEntryRuntimeComposition,
} from "./renave/stock-entry-runtime.js";
import {
  destroyStockEntrySecretBundle,
  readStockEntrySecretBundle,
} from "./renave/stock-entry-secret-bundle.js";
import type {
  StockEntryMutationRateLimiter,
  StockEntryOperationUseCase,
} from "./renave/stock-entry-operations.js";
import {
  composeStockExitRuntime,
  type StockExitRuntimeComposition,
} from "./renave/stock-exit-runtime.js";
import type {
  StockExitMutationRateLimiter,
  StockExitOperationUseCase,
} from "./renave/stock-exit-operations.js";
import { createPostgresTenantDirectory } from "./tenant/directory.js";
import type {
  TenantEstablishmentAdministration,
  TenantMutationRateLimiter,
} from "./tenant/admin-establishments.js";
import { PostgresTenantEstablishmentAdministration } from "./tenant/postgres-administration.js";
import type { TenantDirectory } from "./tenant/routes.js";

export interface AppRuntime {
  close(): Promise<void>;
  certificateTemporalStatus?: () => MtlsCertificateTemporalStatus;
  ready(): Promise<boolean>;
  eligibility?: PostgresVehicleEligibilityUseCase;
  linkStatus?: PostgresRenaveLinkStatusUseCase;
  preflight?: PostgresRenaveLinkPreflightUseCase;
  renaveReadiness?: PostgresRenaveReadinessUseCase;
  identity?: ReturnType<typeof composeIdentity>;
  loginRateLimiter?: LoginRateLimiter;
  sessionLookupGate?: SessionLookupGate;
  serproQueryLimiter?: SerproQueryLimiter;
  stockQuery?: PostgresStockQueryUseCase;
  vehicleLookup?: PostgresVehicleLookupUseCase;
  stockEntryMutationRateLimiter?: StockEntryMutationRateLimiter;
  stockEntryOperation?: StockEntryOperationUseCase;
  stockExitMutationRateLimiter?: StockExitMutationRateLimiter;
  stockExitOperation?: StockExitOperationUseCase;
  tenantDirectory?: TenantDirectory;
  tenantEstablishmentAdministration?: TenantEstablishmentAdministration;
  tenantMutationRateLimiter?: TenantMutationRateLimiter;
  tenantActionRunner?: TenantActionRunner;
  platformConsole?: PlatformConsole;
}

export function areRuntimeDependenciesReady(input: {
  databasesReady: boolean;
  mtls?: Pick<HomologationMtlsClient, "isCertificateValidAt">;
  now?: Date;
}): boolean {
  return (
    input.databasesReady &&
    (input.mtls?.isCertificateValidAt(input.now ?? new Date()) ?? true)
  );
}

type RuntimeCleanupTask = () => Promise<void> | void;

export interface RuntimeCleanupCoordinator {
  close(): Promise<boolean>;
  registerPool(task: RuntimeCleanupTask): void;
  registerResource(task: RuntimeCleanupTask): void;
}

export function createRuntimeCleanupCoordinator(): RuntimeCleanupCoordinator {
  const resources: RuntimeCleanupTask[] = [];
  const pools: RuntimeCleanupTask[] = [];
  let closePromise: Promise<boolean> | undefined;

  function register(tasks: RuntimeCleanupTask[], task: RuntimeCleanupTask) {
    if (closePromise) {
      throw new Error("Runtime já está sendo encerrado");
    }
    tasks.push(task);
  }

  return {
    close() {
      closePromise ??= (async () => {
        let failed = false;

        for (const task of [...resources].reverse()) {
          try {
            await task();
          } catch {
            failed = true;
          }
        }

        const poolResults = await Promise.allSettled(
          pools.map(async (task) => task()),
        );
        return (
          failed || poolResults.some((result) => result.status === "rejected")
        );
      })();
      return closePromise;
    },
    registerPool(task) {
      register(pools, task);
    },
    registerResource(task) {
      register(resources, task);
    },
  };
}

export async function closeRuntimeResources(
  cleanup: Pick<RuntimeCleanupCoordinator, "close">,
  reportFailure: boolean,
): Promise<void> {
  if ((await cleanup.close()) && reportFailure) {
    throw new Error("Falha ao encerrar runtime");
  }
}

export async function rollbackRuntimeResources(
  cleanup: Pick<RuntimeCleanupCoordinator, "close">,
  originalError: unknown,
): Promise<never> {
  await closeRuntimeResources(cleanup, false);
  throw originalError;
}

export async function createRuntime(config: AppConfig): Promise<AppRuntime> {
  const cleanup = createRuntimeCleanupCoordinator();
  const runtimeDatabases: Array<{
    expectedRole:
      typeof APP_ROLE | typeof IDENTITY_APP_ROLE | typeof PLATFORM_READER_ROLE;
    pool: Pool;
  }> = [];
  let degraded = false;
  let mtls: HomologationMtlsClient | undefined;
  let tenantAdminLimiter: PostgresTenantAdminRateLimiter | undefined;
  let tenantAdministration:
    PostgresTenantEstablishmentAdministration | undefined;
  let stockEntryComposition: StockEntryRuntimeComposition | undefined;
  let stockExitComposition: StockExitRuntimeComposition | undefined;
  function registerPool(pool: Pool): Pool {
    cleanup.registerPool(() => pool.end());
    pool.on("error", () => {
      degraded = true;
    });
    return pool;
  }
  try {
    let identity: ReturnType<typeof composeIdentity> | undefined;
    let identityPool: Pool | undefined;
    if (config.authMode === "oidc") {
      if (
        config.sessionStore === "postgres" ||
        config.loginRateLimitHmacKeyBase64
      ) {
        identityPool = registerPool(
          await createRuntimePool({
            applicationName: "seu-renave-api-identity",
            ...(config.identityDatabaseTlsCa
              ? { ca: config.identityDatabaseTlsCa }
              : {}),
            caFile: config.identityDatabaseTlsCaFile,
            connectionString: config.identityDatabaseUrl!,
            max: 8,
          }),
        );
        await assertRuntimeDatabase(identityPool, {
          expectedRole: IDENTITY_APP_ROLE,
        });
        runtimeDatabases.push({
          expectedRole: IDENTITY_APP_ROLE,
          pool: identityPool,
        });
      }
      if (config.sessionStore === "postgres") {
        identity = composeIdentity(config, {
          store: new PostgresIdentitySessionStore(identityPool!),
        });
      } else {
        identity = composeIdentity(config);
      }
    }
    let loginRateLimiter: PostgresLoginRateLimiter | undefined;
    if (identityPool && config.loginRateLimitHmacKeyBase64) {
      const key = decodeLoginRateHmacKeyBase64(
        config.loginRateLimitHmacKeyBase64,
      );
      try {
        loginRateLimiter = new PostgresLoginRateLimiter(identityPool, key);
        cleanup.registerResource(() => loginRateLimiter!.destroy());
      } finally {
        key.fill(0);
      }
    }
    const sessionLookupGate = identity
      ? new LocalSessionLookupGate(config.sessionLookupMaxConcurrency)
      : undefined;

    const businessPool = config.databaseUrl
      ? registerPool(
          await createRuntimePool({
            applicationName: "seu-renave-api-business",
            ...(config.databaseTlsCa ? { ca: config.databaseTlsCa } : {}),
            caFile: config.databaseTlsCaFile,
            connectionString: config.databaseUrl,
            max: 16,
          }),
        )
      : undefined;
    if (businessPool) {
      await assertRuntimeDatabase(businessPool, { expectedRole: APP_ROLE });
      runtimeDatabases.push({ expectedRole: APP_ROLE, pool: businessPool });
    }
    let platformConsole: PostgresPlatformConsole | undefined;
    if (config.platformConsole) {
      const platformPool = registerPool(
        await createRuntimePool({
          applicationName: "seu-renave-api-platform-reader",
          ...(config.platformConsole.databaseTlsCa
            ? { ca: config.platformConsole.databaseTlsCa }
            : {}),
          caFile: config.platformConsole.databaseTlsCaFile,
          connectionString: config.platformConsole.databaseUrl,
          max: 4,
        }),
      );
      await assertRuntimeDatabase(platformPool, {
        expectedRole: PLATFORM_READER_ROLE,
      });
      runtimeDatabases.push({
        expectedRole: PLATFORM_READER_ROLE,
        pool: platformPool,
      });
      const key = decodePlatformOperatorHmacKeyBase64(
        config.platformConsole.hmacKeyBase64,
      );
      try {
        platformConsole = new PostgresPlatformConsole(platformPool, key);
        cleanup.registerResource(() => platformConsole!.destroy());
      } finally {
        key.fill(0);
      }
    }
    let serproQueryLimiter: PostgresSerproQueryLimiter | undefined;
    if (businessPool && config.serproQueryLimitHmacKeyBase64) {
      const key = decodeSerproQueryHmacKeyBase64(
        config.serproQueryLimitHmacKeyBase64,
      );
      try {
        serproQueryLimiter = new PostgresSerproQueryLimiter(businessPool, key);
        cleanup.registerResource(() => serproQueryLimiter!.destroy());
      } finally {
        key.fill(0);
      }
    }
    const tenantDirectory: TenantDirectory | undefined = businessPool
      ? createPostgresTenantDirectory(businessPool)
      : undefined;
    const tenantActionRunner = businessPool
      ? createTenantActionRunner(businessPool)
      : undefined;
    let tenantMutationRateLimiter: TenantMutationRateLimiter | undefined;
    if (businessPool && config.tenantAdminHmacKeyBase64) {
      const key = decodeTenantAdminHmacKeyBase64(
        config.tenantAdminHmacKeyBase64,
      );
      try {
        tenantAdminLimiter = new PostgresTenantAdminRateLimiter(
          businessPool,
          key,
        );
        cleanup.registerResource(() => tenantAdminLimiter!.destroy());
        tenantAdministration = new PostgresTenantEstablishmentAdministration(
          key,
        );
        cleanup.registerResource(() => tenantAdministration!.destroy());
      } finally {
        key.fill(0);
      }
      tenantMutationRateLimiter = {
        acquire: (input) => tenantAdminLimiter!.consume(input),
      };
    }
    const linkStatus = businessPool
      ? new PostgresRenaveLinkStatusUseCase(businessPool)
      : undefined;
    if (config.stockEntryLocalEnabled) {
      if (!businessPool || !tenantActionRunner) {
        throw new Error("A entrada de estoque local está indisponível");
      }
      const bundle = await readStockEntrySecretBundle();
      try {
        await assertStockEntryRuntimeKeyGeneration(businessPool, {
          fingerprint: bundle.digests.fingerprint,
          generationId: bundle.digests.generationId,
        });
        stockEntryComposition = composeStockEntryRuntime({
          bundle,
          pool: businessPool,
          runner: tenantActionRunner,
        });
        cleanup.registerResource(() => stockEntryComposition!.destroy());
      } catch (error) {
        destroyStockEntrySecretBundle(bundle);
        throw error;
      }
    }

    let eligibility: PostgresVehicleEligibilityUseCase | undefined;
    let preflight: PostgresRenaveLinkPreflightUseCase | undefined;
    let stockQuery: PostgresStockQueryUseCase | undefined;
    let vehicleLookup: PostgresVehicleLookupUseCase | undefined;
    if (config.renave) {
      const { ca, cert, key } =
        config.renave.mtls.kind === "material"
          ? {
              ca: config.renave.mtls.ca,
              cert: config.renave.mtls.certificate,
              key: config.renave.mtls.key,
            }
          : await readRenaveMtlsMaterial({
              caFile: config.renave.mtls.caFile,
              certificateFile: config.renave.mtls.certificateFile,
              keyFile: config.renave.mtls.keyFile,
            });
      const certificateThumbprintSha256 = new X509Certificate(
        cert,
      ).fingerprint256
        .replaceAll(":", "")
        .toLowerCase();
      if (!businessPool) {
        throw new Error("A integração RENAVE exige DATABASE_URL");
      }
      mtls = createHomologationPemMtlsClient("homologation", {
        ca,
        cert,
        key,
        ...(config.renave.keyPassphrase === undefined
          ? {}
          : { passphrase: config.renave.keyPassphrase }),
      });
      cleanup.registerResource(() => mtls!.close());
      const evidenceKeys = new Map<string, Buffer>();
      let cipher: EvidenceCipher;
      try {
        for (const entry of config.renave.evidenceKeyring.keys) {
          evidenceKeys.set(
            entry.keyId,
            decodeEvidenceKeyBase64(entry.keyBase64),
          );
        }
        cipher = new EvidenceCipher({
          activeKeyId: config.renave.evidenceKeyring.activeKeyId,
          keys: evidenceKeys,
        });
        cleanup.registerResource(() => cipher.destroy());
      } finally {
        for (const value of evidenceKeys.values()) value.fill(0);
      }
      const transport = new HttpRenaveReadOnlyTransport({
        environment: "homologation",
        request: createHomologationRenaveReadOnlyRequest(
          "homologation",
          mtls.request,
        ),
      });
      const connector = new RenaveQueryConnector(transport);
      const vehicleConnector = new RenaveVehicleLookupConnector(transport);
      eligibility = new PostgresVehicleEligibilityUseCase({
        certificateThumbprintSha256,
        cipher,
        connector,
        integratorCnpj: config.renave.integratorCnpj,
        pool: businessPool,
      });
      preflight = new PostgresRenaveLinkPreflightUseCase({
        certificateThumbprintSha256,
        cipher,
        connector,
        integratorCnpj: config.renave.integratorCnpj,
        pool: businessPool,
      });
      stockQuery = new PostgresStockQueryUseCase({
        certificateThumbprintSha256,
        cipher,
        connector,
        integratorCnpj: config.renave.integratorCnpj,
        pool: businessPool,
      });
      vehicleLookup = new PostgresVehicleLookupUseCase({
        certificateThumbprintSha256,
        cipher,
        integratorCnpj: config.renave.integratorCnpj,
        pool: businessPool,
        stockConnector: connector,
        vehicleConnector,
      });
    }
    if (config.stockExitLocalEnabled) {
      if (
        !businessPool ||
        !tenantActionRunner ||
        !stockQuery ||
        !serproQueryLimiter ||
        !mtls
      ) {
        throw new Error("A saída de estoque local está indisponível");
      }
      const bundle = await readStockEntrySecretBundle();
      try {
        await assertStockEntryRuntimeKeyGeneration(businessPool, {
          fingerprint: bundle.digests.fingerprint,
          generationId: bundle.digests.generationId,
        });
        stockExitComposition = composeStockExitRuntime({
          bundle,
          certificate: mtls,
          mfaMaxAgeSeconds: config.stockExitMfaMaxAgeSeconds,
          pool: businessPool,
          queryLimiter: serproQueryLimiter,
          runner: tenantActionRunner,
          stockQuery,
        });
        cleanup.registerResource(() => stockExitComposition!.destroy());
        if (!(await stockExitComposition.ready())) {
          throw new Error(
            "A saída de estoque local exige catálogo municipal vigente",
          );
        }
      } catch (error) {
        destroyStockEntrySecretBundle(bundle);
        throw error;
      }
    }
    const renaveReadiness = businessPool
      ? new PostgresRenaveReadinessUseCase({
          ...(mtls
            ? {
                certificateTemporalStatus: () =>
                  mtls!.getCertificateTemporalStatus(),
              }
            : {}),
          integrationConfigured: Boolean(config.renave),
          pool: businessPool,
          queryLimiterConfigured: Boolean(serproQueryLimiter),
        })
      : undefined;

    return {
      ...(mtls
        ? {
            certificateTemporalStatus: () =>
              mtls!.getCertificateTemporalStatus(),
          }
        : {}),
      ...(eligibility ? { eligibility } : {}),
      ...(preflight ? { preflight } : {}),
      ...(renaveReadiness ? { renaveReadiness } : {}),
      ...(identity ? { identity } : {}),
      ...(linkStatus ? { linkStatus } : {}),
      ...(loginRateLimiter ? { loginRateLimiter } : {}),
      ...(sessionLookupGate ? { sessionLookupGate } : {}),
      ...(serproQueryLimiter ? { serproQueryLimiter } : {}),
      ...(stockQuery ? { stockQuery } : {}),
      ...(vehicleLookup ? { vehicleLookup } : {}),
      ...(stockEntryComposition
        ? {
            stockEntryMutationRateLimiter:
              stockEntryComposition.mutationRateLimiter,
            stockEntryOperation: stockEntryComposition.operation,
          }
        : {}),
      ...(stockExitComposition
        ? {
            stockExitMutationRateLimiter:
              stockExitComposition.mutationRateLimiter,
            stockExitOperation: stockExitComposition.operation,
          }
        : {}),
      ...(tenantDirectory ? { tenantDirectory } : {}),
      ...(tenantActionRunner ? { tenantActionRunner } : {}),
      ...(tenantAdministration
        ? { tenantEstablishmentAdministration: tenantAdministration }
        : {}),
      ...(tenantMutationRateLimiter ? { tenantMutationRateLimiter } : {}),
      ...(platformConsole ? { platformConsole } : {}),
      async ready() {
        let databasesReady = true;
        try {
          await Promise.all(
            runtimeDatabases.map(({ expectedRole, pool }) =>
              assertRuntimeDatabase(pool, { expectedRole }),
            ),
          );
          if (stockExitComposition && !(await stockExitComposition.ready())) {
            databasesReady = false;
          }
        } catch {
          databasesReady = false;
        }
        degraded = !areRuntimeDependenciesReady({
          databasesReady,
          ...(mtls ? { mtls } : {}),
        });
        return !degraded;
      },
      async close() {
        await closeRuntimeResources(cleanup, true);
      },
    };
  } catch (error) {
    return rollbackRuntimeResources(cleanup, error);
  }
}
