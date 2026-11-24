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

async function expectAppContractRejected(): Promise<void> {
  await expect(
    assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
  ).rejects.toBeInstanceOf(RuntimeDatabaseContractError);
}

async function expectAppContractReady(): Promise<void> {
  await expect(
    assertRuntimeDatabase(appPool, { expectedRole: "renave_app" }),
  ).resolves.toBeUndefined();
}

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
        where version = '0025_operation_outbox'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0025_operation_outbox'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0025_operation_outbox'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa checksum divergente da migration de claim", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version = '0027_operation_outbox_claim_lease'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0027_operation_outbox_claim_lease'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0027_operation_outbox_claim_lease'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa checksum divergente da migration beginDispatch", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version = '0029_operation_begin_dispatch'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0029_operation_begin_dispatch'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0029_operation_begin_dispatch'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa checksum divergente da migration de recovery", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version = '0031_operation_recover_expired_send'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0031_operation_recover_expired_send'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0031_operation_recover_expired_send'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa checksum divergente da migration de conclusão SEND", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version = '0033_operation_complete_send'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum = $1
        where version = '0033_operation_complete_send'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum = $1
          where version = '0033_operation_complete_send'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa RLS desabilitada nas tabelas do outbox", async () => {
    await adminPool.query(
      "alter table renave.operation_outbox disable row level security",
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "alter table renave.operation_outbox enable row level security",
      );
    }
    await expectAppContractReady();
  });

  it("recusa tabela sem FORCE RLS", async () => {
    await adminPool.query(
      "alter table renave.operation_transition no force row level security",
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "alter table renave.operation_transition force row level security",
      );
    }
    await expectAppContractReady();
  });

  it("recusa tabela UNLOGGED na fundação do outbox", async () => {
    await adminPool.query("alter table renave.operation_outbox set unlogged");
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query("alter table renave.operation_outbox set logged");
    }
    await expectAppContractReady();
  });

  it("recusa policy permissiva adicional na mesma tabela", async () => {
    await adminPool.query(
      `create policy operation_permissive_probe on renave.operation
       using (true) with check (true)`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "drop policy operation_permissive_probe on renave.operation",
      );
    }
    await expectAppContractReady();
  });

  it("recusa policy que mantém dependência mas abre isolamento com OR", async () => {
    await adminPool.query(
      `alter policy operation_isolation on renave.operation
       using (
         tenant_id = (select renave.current_tenant_id())
         or renave.current_tenant_id() is not null
       )
       with check (
         tenant_id = (select renave.current_tenant_id())
         or renave.current_tenant_id() is not null
       )`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `alter policy operation_isolation on renave.operation
         using (tenant_id = (select renave.current_tenant_id()))
         with check (tenant_id = (select renave.current_tenant_id()))`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa índice essencial adulterado", async () => {
    await adminPool.query("drop index renave.operation_outbox_ready_idx");
    await adminPool.query(
      `create index operation_outbox_ready_idx
       on renave.operation_outbox (
         tenant_id, event_type, created_at, available_at, id
       )
       where delivery_status in ('READY', 'LEASED')`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query("drop index renave.operation_outbox_ready_idx");
      await adminPool.query(
        `create index operation_outbox_ready_idx
         on renave.operation_outbox (
           tenant_id, event_type, available_at, created_at, id
         ) where delivery_status = 'READY'`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa índice único homônimo sem a constraint correspondente", async () => {
    await adminPool.query(
      `alter table renave.operation_outbox
       drop constraint operation_outbox_event_key`,
    );
    await adminPool.query(
      `create unique index operation_outbox_event_key
       on renave.operation_outbox (tenant_id, operation_id, event_type)`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query("drop index renave.operation_outbox_event_key");
      await adminPool.query(
        `alter table renave.operation_outbox
         add constraint operation_outbox_event_key
         unique (tenant_id, operation_id, event_type)`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa índice de lease expirado com predicado aberto", async () => {
    await adminPool.query(
      "drop index renave.operation_outbox_expired_lease_idx",
    );
    await adminPool.query(
      `create index operation_outbox_expired_lease_idx
       on renave.operation_outbox (
         tenant_id, event_type, lease_expires_at, created_at, id
       ) where delivery_status in ('READY', 'LEASED')`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "drop index renave.operation_outbox_expired_lease_idx",
      );
      await adminPool.query(
        `create index operation_outbox_expired_lease_idx
         on renave.operation_outbox (
           tenant_id, event_type, lease_expires_at, created_at, id
         ) where delivery_status = 'LEASED'`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa índice de token sem unicidade global enquanto ativo", async () => {
    await adminPool.query("drop index renave.operation_outbox_lease_token_key");
    await adminPool.query(
      `create index operation_outbox_lease_token_key
       on renave.operation_outbox (lease_token)
       where lease_token is not null`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "drop index renave.operation_outbox_lease_token_key",
      );
      await adminPool.query(
        `create unique index operation_outbox_lease_token_key
         on renave.operation_outbox (lease_token)
         where lease_token is not null`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa trigger protetor desabilitado", async () => {
    await adminPool.query(
      "alter table renave.operation disable trigger operation_guard",
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "alter table renave.operation enable trigger operation_guard",
      );
    }
    await expectAppContractReady();
  });

  it("recusa trigger neutralizado por WHEN false", async () => {
    await adminPool.query("drop trigger operation_guard on renave.operation");
    await adminPool.query(
      `create trigger operation_guard
       before insert or update on renave.operation
       for each row when (false)
       execute function renave.operation_guard()`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query("drop trigger operation_guard on renave.operation");
      await adminPool.query(
        `create trigger operation_guard
         before insert or update on renave.operation
         for each row execute function renave.operation_guard()`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa trigger UPDATE restrito a uma coluna", async () => {
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_triggerdef(triggers.oid, false) as definition
         from pg_catalog.pg_trigger triggers
        where triggers.tgrelid = 'renave.operation_outbox'::regclass
          and triggers.tgname = 'operation_outbox_guard'`,
    );
    await adminPool.query(
      "drop trigger operation_outbox_guard on renave.operation_outbox",
    );
    await adminPool.query(
      `create trigger operation_outbox_guard
       before update of delivery_status on renave.operation_outbox
       for each row execute function renave.operation_outbox_guard()`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "drop trigger operation_outbox_guard on renave.operation_outbox",
      );
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();
  });

  it("recusa função essencial com owner inadequado", async () => {
    await adminPool.query(
      "alter function renave.operation_guard() owner to renave_app",
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "alter function renave.operation_guard() owner to renave_migrator",
      );
    }
    await expectAppContractReady();
  });

  it("recusa troca de corpo que preserva metadados da função", async () => {
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_functiondef(
         'renave.operation_guard()'::regprocedure
       ) as definition`,
    );
    await adminPool.query(
      `create or replace function renave.operation_guard()
       returns trigger
       language plpgsql
       set search_path = pg_catalog
       as $$
       begin
         return new;
       end;
       $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();
  });

  it("recusa função de claim adulterada ou sem SECURITY DEFINER", async () => {
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_functiondef(
         'renave.claim_operation_send_leases(uuid,integer)'::regprocedure
       ) as definition`,
    );
    await adminPool.query(
      `create or replace function renave.claim_operation_send_leases(
         p_lease_owner uuid, p_limit integer
       )
       returns table (
         outbox_id uuid, operation_id uuid, event_type text,
         attempt_count integer, lease_token uuid,
         lease_expires_at timestamptz
       )
       language plpgsql
       security definer
       set search_path = pg_catalog
       as $$
       begin
         return;
       end;
       $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();

    await adminPool.query(
      `alter function renave.claim_operation_send_leases(uuid, integer)
       security invoker`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `alter function renave.claim_operation_send_leases(uuid, integer)
         security definer`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa privilégio direto inesperado nas tabelas outbox", async () => {
    await adminPool.query("grant select on renave.operation to renave_app");
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        "revoke select on renave.operation from renave_app",
      );
    }
    await expectAppContractReady();
  });

  it("recusa grant por coluna em conteúdo cifrado", async () => {
    await adminPool.query(
      `grant select (request_ciphertext) on renave.operation
       to renave_app`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke select (request_ciphertext) on renave.operation
         from renave_app`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa execução inesperada das funções outbox", async () => {
    await adminPool.query(
      `grant execute on function renave.get_operation_summary(uuid)
       to renave_identity_app`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function renave.get_operation_summary(uuid)
         from renave_identity_app`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa grant a qualquer papel não enumerado nas funções de lease", async () => {
    await adminPool.query("create role operation_lease_acl_probe nologin");
    await adminPool.query(
      `grant execute on function
         renave.claim_operation_send_leases(uuid, integer)
       to operation_lease_acl_probe`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave.claim_operation_send_leases(uuid, integer)
         from operation_lease_acl_probe`,
      );
      await adminPool.query("drop role operation_lease_acl_probe");
    }
    await expectAppContractReady();
  });

  it("recusa beginDispatch adulterado ou sem SECURITY DEFINER", async () => {
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_functiondef(
         'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'::regprocedure
       ) as definition`,
    );
    await adminPool.query(
      `create or replace function renave.begin_operation_send_dispatch(
         p_outbox_id uuid, p_lease_owner uuid, p_lease_token uuid
       )
       returns table (
         outbox_id uuid, operation_id uuid, tenant_id uuid,
         establishment_id uuid, correlation_id uuid, kind text,
         mutation_family text, operation_version bigint,
         sent_at timestamptz, attempt_count integer, lease_owner uuid,
         lease_token uuid, lease_expires_at timestamptz,
         idempotency_key_digest bytea, vehicle_key_digest bytea,
         actor_subject_hash bytea, request_sha256 bytea,
         request_size integer, request_schema_version integer,
         request_key_id text, request_nonce bytea,
         request_auth_tag bytea, request_ciphertext bytea
       )
       language plpgsql
       security definer
       set search_path = pg_catalog
       as $$
       begin
         return;
       end;
       $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();

    await adminPool.query(
      `alter function renave.begin_operation_send_dispatch(uuid,uuid,uuid)
       security invoker`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `alter function renave.begin_operation_send_dispatch(uuid,uuid,uuid)
         security definer`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa grant inesperado na função beginDispatch", async () => {
    await adminPool.query("create role begin_dispatch_acl_probe nologin");
    await adminPool.query(
      `grant execute on function
         renave.begin_operation_send_dispatch(uuid,uuid,uuid)
       to begin_dispatch_acl_probe`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave.begin_operation_send_dispatch(uuid,uuid,uuid)
         from begin_dispatch_acl_probe`,
      );
      await adminPool.query("drop role begin_dispatch_acl_probe");
    }
    await expectAppContractReady();
  });

  it("recusa recovery adulterado ou sem SECURITY DEFINER", async () => {
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_functiondef(
         'renave.recover_expired_operation_sends(integer)'::regprocedure
       ) as definition`,
    );
    await adminPool.query(
      `create or replace function renave.recover_expired_operation_sends(
         p_limit integer
       )
       returns table (
         operation_id uuid, send_outbox_id uuid, reconcile_outbox_id uuid,
         operation_version bigint, recovered_at timestamptz,
         reconcile_available_at timestamptz
       )
       language plpgsql
       security definer
       set search_path = pg_catalog
       as $$
       begin
         return;
       end;
       $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();

    await adminPool.query(
      `alter function renave.recover_expired_operation_sends(integer)
       security invoker`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `alter function renave.recover_expired_operation_sends(integer)
         security definer`,
      );
    }
    await expectAppContractReady();
  });

  it("recusa grant inesperado na função de recovery", async () => {
    await adminPool.query(
      "create role expired_send_recovery_acl_probe nologin",
    );
    await adminPool.query(
      `grant execute on function
         renave.recover_expired_operation_sends(integer)
       to expired_send_recovery_acl_probe`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave.recover_expired_operation_sends(integer)
         from expired_send_recovery_acl_probe`,
      );
      await adminPool.query("drop role expired_send_recovery_acl_probe");
    }
    await expectAppContractReady();
  });

  it("recusa função de conclusão adulterada ou sem SECURITY DEFINER", async () => {
    const signature =
      "renave.complete_operation_send_confirmed(uuid,uuid,uuid,bigint,bigint,text)";
    const original = await adminPool.query<{ definition: string }>(
      `select pg_catalog.pg_get_functiondef($1::regprocedure) as definition`,
      [signature],
    );
    await adminPool.query(
      `create or replace function renave.complete_operation_send_confirmed(
         p_outbox_id uuid, p_lease_owner uuid, p_lease_token uuid,
         p_expected_operation_version bigint, p_remote_record_id bigint,
         p_remote_state text
       ) returns table (
         operation_id uuid, send_outbox_id uuid,
         operation_version bigint, completed_at timestamptz
       ) language plpgsql security definer set search_path=pg_catalog as $$
       begin return; end $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();

    await adminPool.query(`alter function ${signature} security invoker`);
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(`alter function ${signature} security definer`);
    }
    await expectAppContractReady();
  });

  it("recusa grant inesperado em qualquer conclusão SEND", async () => {
    await adminPool.query("create role send_completion_acl_probe nologin");
    await adminPool.query(
      `grant execute on function
         renave.complete_operation_send_outcome_unknown(uuid,uuid,uuid,bigint)
       to send_completion_acl_probe`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave.complete_operation_send_outcome_unknown(uuid,uuid,uuid,bigint)
         from send_completion_acl_probe`,
      );
      await adminPool.query("drop role send_completion_acl_probe");
    }
    await expectAppContractReady();
  });

  it("recusa checksum divergente da migration de lease RECONCILE", async () => {
    const original = await adminPool.query<{ checksum: string }>(
      `select checksum from renave.schema_migrations
        where version='0035_operation_reconciliation_lease'`,
    );
    await adminPool.query(
      `update renave.schema_migrations set checksum=$1
        where version='0035_operation_reconciliation_lease'`,
      ["0".repeat(64)],
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `update renave.schema_migrations set checksum=$1
          where version='0035_operation_reconciliation_lease'`,
        [original.rows[0]!.checksum],
      );
    }
    await expectAppContractReady();
  });

  it("recusa beginReconciliation adulterado ou sem SECURITY DEFINER", async () => {
    const signature =
      "renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)";
    const original = await adminPool.query<{ definition: string }>(
      "select pg_get_functiondef($1::regprocedure) as definition",
      [signature],
    );
    await adminPool.query(
      `create or replace function renave.begin_operation_reconciliation(
         p_outbox_id uuid,p_lease_owner uuid,p_lease_token uuid,
         p_expected_operation_version bigint
       ) returns table (
         outbox_id uuid,operation_id uuid,establishment_id uuid,
         correlation_id uuid,kind text,mutation_family text,
         operation_version bigint,sent_at timestamptz,attempt_count integer,
         lease_expires_at timestamptz
       ) language plpgsql security definer set search_path=pg_catalog as $$
       begin return; end $$`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(original.rows[0]!.definition);
    }
    await expectAppContractReady();
    await adminPool.query(`alter function ${signature} security invoker`);
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(`alter function ${signature} security definer`);
    }
    await expectAppContractReady();
  });

  it("recusa grant inesperado em funções RECONCILE", async () => {
    await adminPool.query("create role reconciliation_lease_acl_probe nologin");
    await adminPool.query(
      `grant execute on function
         renave.claim_operation_reconciliation_leases(uuid,integer)
       to reconciliation_lease_acl_probe`,
    );
    try {
      await expectAppContractRejected();
    } finally {
      await adminPool.query(
        `revoke execute on function
           renave.claim_operation_reconciliation_leases(uuid,integer)
         from reconciliation_lease_acl_probe`,
      );
      await adminPool.query("drop role reconciliation_lease_acl_probe");
    }
    await expectAppContractReady();
  });
});
