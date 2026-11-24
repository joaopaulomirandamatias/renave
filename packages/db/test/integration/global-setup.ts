import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { bootstrapRoles } from "../../src/bootstrap.js";
import {
  APP_ROLE,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  MIGRATOR_ROLE,
  OPERATION_WORKER_ROLE,
  isLoopbackUrl,
  withCredentials,
} from "../../src/config.js";
import { LOCAL_DEFAULTS } from "../../src/local-defaults.js";
import { runMigrations } from "../../src/migrate.js";

export interface DbUrls {
  admin: string;
  migrator: string;
  app: string;
  identity: string;
  maintenance: string;
  operationWorker: string;
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
const TEST_IDENTITY_APP_PASSWORD = "renave_identity_app_it";
const TEST_MAINTENANCE_APP_PASSWORD = "renave_maintenance_app_it";
const TEST_OPERATION_WORKER_PASSWORD = "renave_operation_worker_it";

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
    identityAppPassword: TEST_IDENTITY_APP_PASSWORD,
    maintenanceAppPassword: TEST_MAINTENANCE_APP_PASSWORD,
    operationWorkerPassword: TEST_OPERATION_WORKER_PASSWORD,
  });
  const migrator = withCredentials(
    admin,
    MIGRATOR_ROLE,
    TEST_MIGRATOR_PASSWORD,
  );
  const app = withCredentials(admin, APP_ROLE, TEST_APP_PASSWORD);
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
  await runMigrations(migrator);

  project.provide("dbUrls", {
    admin,
    migrator,
    app,
    identity,
    maintenance: maintenanceApp,
    operationWorker,
  });

  return async () => {
    const cleanup = new Client({ connectionString: maintenanceUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${database} with (force)`);
    await cleanup.end();
  };
}
