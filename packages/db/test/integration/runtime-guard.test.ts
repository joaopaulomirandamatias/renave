import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  assertRuntimeDatabase,
  RuntimeDatabaseContractError,
} from "../../src/runtime-guard.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let identityPool: Pool;
let maintenancePool: Pool;
let migratorPool: Pool;

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 1 });
  appPool = createPool(urls.app, { max: 1 });
  identityPool = createPool(urls.identity, { max: 1 });
  maintenancePool = createPool(urls.maintenance, { max: 1 });
  migratorPool = createPool(urls.migrator, { max: 1 });
});

afterAll(async () => {
  await Promise.all([
    adminPool?.end(),
    appPool?.end(),
    identityPool?.end(),
    maintenancePool?.end(),
    migratorPool?.end(),
  ]);
});

describe("guard do banco de runtime", () => {
  it("aceita somente o papel esperado com contrato completo", async () => {
    await expect(
      assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
    ).resolves.toBeUndefined();
    await expect(
      assertRuntimeDatabase(identityPool, {
        expectedRole: "renave_identity_app",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertRuntimeDatabase(maintenancePool, {
        expectedRole: "renave_maintenance_app",
      }),
    ).resolves.toBeUndefined();
  });

  it("recusa URLs trocadas sem revelar detalhes da conexão", async () => {
    const attempts = [
      assertRuntimeDatabase(appPool, {
        expectedRole: "renave_identity_app",
      }),
      assertRuntimeDatabase(identityPool, { expectedRole: "renave_app" }),
      assertRuntimeDatabase(appPool, {
        expectedRole: "renave_maintenance_app",
      }),
    ];
    const errors = await Promise.all(
      attempts.map((attempt) => attempt.catch((error: unknown) => error)),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(RuntimeDatabaseContractError);
      expect(String(error)).not.toMatch(/postgres|password|127\.0\.0\.1/iu);
    }
  });

  it("recusa migrator e superusuário mesmo quando o contrato existe", async () => {
    await expect(
      assertRuntimeDatabase(migratorPool, { expectedRole: "renave_app" }),
    ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
    await expect(
      assertRuntimeDatabase(adminPool, { expectedRole: "renave_app" }),
    ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
  });

  it("recusa elevação por SET ROLE e ownership de objeto protegido", async () => {
    await adminPool.query(
      "create role runtime_guard_elevated nologin bypassrls",
    );
    await adminPool.query("grant runtime_guard_elevated to renave_app");
    await expect(
      assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
    ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
    await adminPool.query("revoke runtime_guard_elevated from renave_app");
    await adminPool.query("drop role runtime_guard_elevated");

    await adminPool.query(
      "create table renave_runtime.runtime_guard_owned_probe (id integer)",
    );
    await adminPool.query(
      "alter table renave_runtime.runtime_guard_owned_probe owner to renave_app",
    );
    await expect(
      assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
    ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
    await adminPool.query(
      "drop table renave_runtime.runtime_guard_owned_probe",
    );
    await expect(
      assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
    ).resolves.toBeUndefined();
  });

  it("não expõe o ledger e não concede a função a PUBLIC", async () => {
    await expect(
      appPool.query("select version from renave.schema_migrations"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("select version from renave.schema_migrations"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenancePool.query("select version from renave.schema_migrations"),
    ).rejects.toMatchObject({ code: "42501" });

    const { rows } = await adminPool.query<{
      app_can_execute: boolean;
      identity_can_execute: boolean;
      public_can_execute: boolean;
    }>(
      `select
         has_function_privilege('renave_app', 'renave_runtime.api_contract_ready()', 'execute') as app_can_execute,
         has_function_privilege('renave_identity_app', 'renave_runtime.api_contract_ready()', 'execute') as identity_can_execute,
         has_function_privilege('public', 'renave_runtime.api_contract_ready()', 'execute') as public_can_execute`,
    );
    expect(rows[0]).toEqual({
      app_can_execute: true,
      identity_can_execute: true,
      public_can_execute: false,
    });
  });

  it("isola o contrato de manutenção do contrato da API", async () => {
    await expect(
      appPool.query(
        "select renave_runtime.maintenance_contract_ready() as ready",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenancePool.query(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("recusa contrato quando um checksum do ledger diverge", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version = '0013_serpro_query_limit'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0013_serpro_query_limit'`,
      ["0".repeat(64)],
    );
    try {
      await expect(
        assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
      ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0013_serpro_query_limit'`,
        [original.rows[0]!.checksum],
      );
    }
  });
});
