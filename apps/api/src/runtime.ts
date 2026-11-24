import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";

import {
  APP_ROLE,
  assertRuntimeDatabase,
  decodeLoginRateHmacKeyBase64,
  decodeSerproQueryHmacKeyBase64,
  IDENTITY_APP_ROLE,
  PostgresIdentitySessionStore,
  PostgresLoginRateLimiter,
  PostgresSerproQueryLimiter,
} from "@seu-renave/db";
import {
  decodeEvidenceKeyBase64,
  EvidenceCipher,
} from "@seu-renave/protected-evidence";
import {
  createHomologationPemMtlsClient,
  HttpRenaveTransport,
  RenaveConnector,
  type HomologationMtlsClient,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import { composeIdentity } from "./auth/compose.js";
import type { LoginRateLimiter } from "./auth/routes.js";
import type { SessionLookupGate } from "./auth/routes.js";
import { LocalSessionLookupGate } from "./auth/session-lookup-gate.js";
import type { AppConfig } from "./config.js";
import { createRuntimePool } from "./database.js";
import { PostgresVehicleEligibilityUseCase } from "./renave/use-case.js";
import { PostgresRenaveLinkStatusUseCase } from "./renave/link-status-use-case.js";
import { PostgresRenaveLinkPreflightUseCase } from "./renave/preflight-use-case.js";
import type { SerproQueryLimiter } from "./renave/routes.js";
import { createPostgresTenantDirectory } from "./tenant/directory.js";
import type { TenantDirectory } from "./tenant/routes.js";

export interface AppRuntime {
  close(): Promise<void>;
  ready(): Promise<boolean>;
  eligibility?: PostgresVehicleEligibilityUseCase;
  linkStatus?: PostgresRenaveLinkStatusUseCase;
  preflight?: PostgresRenaveLinkPreflightUseCase;
  identity?: ReturnType<typeof composeIdentity>;
  loginRateLimiter?: LoginRateLimiter;
  sessionLookupGate?: SessionLookupGate;
  serproQueryLimiter?: SerproQueryLimiter;
  tenantDirectory?: TenantDirectory;
}

export async function createRuntime(config: AppConfig): Promise<AppRuntime> {
  const pools: Pool[] = [];
  const runtimeDatabases: Array<{
    expectedRole: typeof APP_ROLE | typeof IDENTITY_APP_ROLE;
    pool: Pool;
  }> = [];
  let degraded = false;
  let mtls: HomologationMtlsClient | undefined;
  function registerPool(pool: Pool): Pool {
    pools.push(pool);
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
    const loginRateLimiter =
      identityPool && config.loginRateLimitHmacKeyBase64
        ? new PostgresLoginRateLimiter(
            identityPool,
            decodeLoginRateHmacKeyBase64(config.loginRateLimitHmacKeyBase64),
          )
        : undefined;
    const sessionLookupGate = identity
      ? new LocalSessionLookupGate(config.sessionLookupMaxConcurrency)
      : undefined;

    const businessPool = config.databaseUrl
      ? registerPool(
          await createRuntimePool({
            applicationName: "seu-renave-api-business",
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
    const serproQueryLimiter =
      businessPool && config.serproQueryLimitHmacKeyBase64
        ? new PostgresSerproQueryLimiter(
            businessPool,
            decodeSerproQueryHmacKeyBase64(
              config.serproQueryLimitHmacKeyBase64,
            ),
          )
        : undefined;
    const tenantDirectory: TenantDirectory | undefined = businessPool
      ? createPostgresTenantDirectory(businessPool)
      : undefined;
    const linkStatus = businessPool
      ? new PostgresRenaveLinkStatusUseCase(businessPool)
      : undefined;

    let eligibility: PostgresVehicleEligibilityUseCase | undefined;
    let preflight: PostgresRenaveLinkPreflightUseCase | undefined;
    if (config.renave) {
      const [ca, cert, key] = await Promise.all([
        readFile(config.renave.caFile, "utf8"),
        readFile(config.renave.certificateFile, "utf8"),
        readFile(config.renave.keyFile, "utf8"),
      ]);
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
      const cipher = new EvidenceCipher({
        activeKeyId: config.renave.evidenceKeyId,
        keys: new Map([
          [
            config.renave.evidenceKeyId,
            decodeEvidenceKeyBase64(config.renave.evidenceKeyBase64),
          ],
        ]),
      });
      const connector = new RenaveConnector(
        new HttpRenaveTransport({
          environment: "homologation",
          request: mtls.request,
        }),
      );
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
    }

    return {
      ...(eligibility ? { eligibility } : {}),
      ...(preflight ? { preflight } : {}),
      ...(identity ? { identity } : {}),
      ...(linkStatus ? { linkStatus } : {}),
      ...(loginRateLimiter ? { loginRateLimiter } : {}),
      ...(sessionLookupGate ? { sessionLookupGate } : {}),
      ...(serproQueryLimiter ? { serproQueryLimiter } : {}),
      ...(tenantDirectory ? { tenantDirectory } : {}),
      async ready() {
        try {
          await Promise.all(
            runtimeDatabases.map(({ expectedRole, pool }) =>
              assertRuntimeDatabase(pool, { expectedRole }),
            ),
          );
          degraded = false;
        } catch {
          degraded = true;
        }
        return !degraded;
      },
      async close() {
        mtls?.close();
        await Promise.all(pools.map((pool) => pool.end()));
      },
    };
  } catch (error) {
    mtls?.close();
    await Promise.allSettled(pools.map((pool) => pool.end()));
    throw error;
  }
}
