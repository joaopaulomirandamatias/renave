import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { bootstrapRoles } from "../../src/bootstrap.js";
import {
  APP_ROLE,
  CREDENTIAL_SCOPE_PROVISIONER_ROLE,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  MIGRATOR_ROLE,
  OPERATION_PROMOTER_ROLE,
  OPERATION_WORKER_ROLE,
  PLATFORM_PROVISIONER_ROLE,
  PLATFORM_READER_ROLE,
  PROFILE_PROVISIONER_ROLE,
  PROFILE_READER_ROLE,
  isLoopbackUrl,
  withCredentials,
} from "../../src/config.js";
import { LOCAL_DEFAULTS } from "../../src/local-defaults.js";
import { runMigrations } from "../../src/migrate.js";

export interface DbUrls {
  admin: string;
  migrator: string;
  app: string;
  credentialScopeProvisioner: string;
  identity: string;
  maintenance: string;
  operationWorker: string;
  operationPromoter: string;
  profileProvisioner: string;
  profileReader: string;
  platformProvisioner: string;
  platformReader: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

// Valores fixos e NÃO secretos: os papéis são globais ao cluster, então senhas
// aleatórias por execução disputariam entre execuções simultâneas. Seguro
// porque o setup recusa qualquer host fora de loopback.
const TEST_MIGRATOR_PASSWORD = "renave_migrator_it";
const TEST_APP_PASSWORD = "renave_app_it";
const TEST_CREDENTIAL_SCOPE_PROVISIONER_PASSWORD =
  "renave_credential_scope_provisioner_it";
const TEST_IDENTITY_APP_PASSWORD = "renave_identity_app_it";
const TEST_MAINTENANCE_APP_PASSWORD = "renave_maintenance_app_it";
const TEST_OPERATION_WORKER_PASSWORD = "renave_operation_worker_it";
const TEST_OPERATION_PROMOTER_PASSWORD = "renave_operation_promoter_it";
const TEST_PROFILE_PROVISIONER_PASSWORD = "renave_profile_provisioner_it";
const TEST_PROFILE_READER_PASSWORD = "renave_profile_reader_it";
const TEST_PLATFORM_PROVISIONER_PASSWORD = "renave_platform_provisioner_it";
const TEST_PLATFORM_READER_PASSWORD = "renave_platform_reader_it";

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const base = process.env["DATABASE_ADMIN_URL"] ?? LOCAL_DEFAULTS.adminUrl;
  if (!isLoopbackUrl(base)) {
    throw new Error(
      "Testes de integração criam bancos e papéis: só rodam contra Postgres em loopback (pnpm db:up).",
    );
  }
  const maintenanceUrl = withDatabase(base, "postgres");
  const database = `renave_it_${randomBytes(6).toString("hex")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl });
  try {
    await maintenance.connect();
  } catch (error) {
    throw new Error(
      `Postgres indisponível em ${new URL(base).host}. Suba com \`pnpm db:up\`. Causa: ${String(error)}`,
    );
  }
  await maintenance.query(`create database ${database}`);
  await maintenance.end();

  const admin = withDatabase(base, database);
  await bootstrapRoles({
    adminUrl: admin,
    migratorPassword: TEST_MIGRATOR_PASSWORD,
    appPassword: TEST_APP_PASSWORD,
    credentialScopeProvisionerPassword:
      TEST_CREDENTIAL_SCOPE_PROVISIONER_PASSWORD,
    identityAppPassword: TEST_IDENTITY_APP_PASSWORD,
    maintenanceAppPassword: TEST_MAINTENANCE_APP_PASSWORD,
    operationWorkerPassword: TEST_OPERATION_WORKER_PASSWORD,
    operationPromoterPassword: TEST_OPERATION_PROMOTER_PASSWORD,
    profileProvisionerPassword: TEST_PROFILE_PROVISIONER_PASSWORD,
    profileReaderPassword: TEST_PROFILE_READER_PASSWORD,
    platformProvisionerPassword: TEST_PLATFORM_PROVISIONER_PASSWORD,
    platformReaderPassword: TEST_PLATFORM_READER_PASSWORD,
  });
  const migrator = withCredentials(
    admin,
    MIGRATOR_ROLE,
    TEST_MIGRATOR_PASSWORD,
  );
  const app = withCredentials(admin, APP_ROLE, TEST_APP_PASSWORD);
  const credentialScopeProvisioner = withCredentials(
    admin,
    CREDENTIAL_SCOPE_PROVISIONER_ROLE,
    TEST_CREDENTIAL_SCOPE_PROVISIONER_PASSWORD,
  );
  const identity = withCredentials(
    admin,
    IDENTITY_APP_ROLE,
    TEST_IDENTITY_APP_PASSWORD,
  );
  const maintenanceApp = withCredentials(
    admin,
    MAINTENANCE_APP_ROLE,
    TEST_MAINTENANCE_APP_PASSWORD,
  );
  const operationWorker = withCredentials(
    admin,
    OPERATION_WORKER_ROLE,
    TEST_OPERATION_WORKER_PASSWORD,
  );
  const operationPromoter = withCredentials(
    admin,
    OPERATION_PROMOTER_ROLE,
    TEST_OPERATION_PROMOTER_PASSWORD,
  );
  const profileProvisioner = withCredentials(
    admin,
    PROFILE_PROVISIONER_ROLE,
    TEST_PROFILE_PROVISIONER_PASSWORD,
  );
  const profileReader = withCredentials(
    admin,
    PROFILE_READER_ROLE,
    TEST_PROFILE_READER_PASSWORD,
  );
  const platformProvisioner = withCredentials(
    admin,
    PLATFORM_PROVISIONER_ROLE,
    TEST_PLATFORM_PROVISIONER_PASSWORD,
  );
  const platformReader = withCredentials(
    admin,
    PLATFORM_READER_ROLE,
    TEST_PLATFORM_READER_PASSWORD,
  );
  await runMigrations(migrator);

  project.provide("dbUrls", {
    admin,
    migrator,
    app,
    credentialScopeProvisioner,
    identity,
    maintenance: maintenanceApp,
    operationWorker,
    operationPromoter,
    profileProvisioner,
    profileReader,
    platformProvisioner,
    platformReader,
  });

  return async () => {
    const cleanup = new Client({ connectionString: maintenanceUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${database} with (force)`);
    await cleanup.end();
  };
}
