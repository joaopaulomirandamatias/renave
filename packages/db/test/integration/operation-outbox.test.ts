import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;
let establishmentB: Establishment;

function digest(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

interface OperationInput {
  actorHash: Buffer;
  authTag: Buffer;
  correlationId: string;
  establishmentId: string;
  idempotencyDigest: Buffer;
  keyId: string;
  nonce: Buffer;
  operationId: string;
  projectionAuthTag: Buffer;
  projectionCiphertext: Buffer;
  projectionKeyId: string;
  projectionNonce: Buffer;
  requestCiphertext: Buffer;
  requestHash: Buffer;
  vehicleDigest: Buffer;
}

function operationInput(
  label: string,
  establishmentId: string,
): OperationInput {
  const requestCiphertext = Buffer.from(`ciphertext:${label}`, "utf8");
  const projectionCiphertext = Buffer.from(`projection:${label}`, "utf8");
  return {
    actorHash: digest(`actor:${label}`),
    authTag: Buffer.alloc(16, 7),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyDigest: digest(`idempotency:${label}`),
    keyId: "test-key-v1",
    nonce: Buffer.alloc(12, 3),
    operationId: randomUUID(),
    projectionAuthTag: randomBytes(16),
    projectionCiphertext,
    projectionKeyId: "projection-test-key-v1",
    projectionNonce: randomBytes(12),
    requestCiphertext,
    requestHash: digest(`request:${label}`),
    vehicleDigest: digest(`vehicle:${label}`),
  };
}

async function createOperation(client: PoolClient, input: OperationInput) {
  const { rows } = await client.query(
    `select * from renave.create_operation_with_outbox(
       $1, $2, 'USED_STOCK_ENTRY', 'STOCK_ENTRY', $3, $4, $5,
       $6, 1, $7, $8, $9, $10, $11, $12,
       'STOCK_ENTRY_RECONCILIATION', 1, 1, $13, $14, $15, $16, $17
     )`,
    [
      input.operationId,
      input.establishmentId,
      input.idempotencyDigest,
      input.vehicleDigest,
      input.requestHash,
      input.requestCiphertext.byteLength,
      input.keyId,
      input.nonce,
      input.authTag,
      input.requestCiphertext,
      input.actorHash,
      input.correlationId,
      input.projectionCiphertext.byteLength,
      input.projectionKeyId,
      input.projectionNonce,
      input.projectionAuthTag,
      input.projectionCiphertext,
    ],
  );
  return rows[0] as {
    operation_created_at: Date;
    operation_id: string;
    operation_status: string;
    replayed: boolean;
  };
}

async function transitionOperation(
  client: PoolClient,
  operationId: string,
  status:
    | "SENT"
    | "REJECTED"
    | "PENDING_RECONCILIATION"
    | "CONFIRMED"
    | "MANUAL_REVIEW",
): Promise<void> {
  const current = await client.query<{
    actor_subject_hash: Buffer;
    status: string;
    version: string;
  }>(
    `select actor_subject_hash, status, version
       from renave.operation where id = $1 for update`,
    [operationId],
  );
  const before = current.rows[0];
  if (!before) throw new Error("Operação de teste ausente");
  const version = Number(before.version) + 1;
  await client.query(
    `update renave.operation
        set status = $2,
            version = $3,
            updated_at = pg_catalog.clock_timestamp(),
            sent_at = case when $2 = 'SENT' then pg_catalog.clock_timestamp() else sent_at end,
            finalized_at = case when $2 in ('REJECTED', 'CONFIRMED') then pg_catalog.clock_timestamp() else finalized_at end
      where id = $1`,
    [operationId, status, version],
  );
  await client.query(
    `insert into renave.operation_transition (
       tenant_id, operation_id, version, previous_status, status,
       reason_code, actor_hash
     ) values (
       renave.current_tenant_id(), $1, $2, $3, $4, 'TEST_TRANSITION', $5
     )`,
    [operationId, version, before.status, status, before.actor_subject_hash],
  );
}

beforeAll(async () => {
  adminPool = createPool(urls.admin, { max: 1 });
  appPool = createPool(urls.app, { max: 16 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Operation Outbox A",
    slug: "operation-outbox-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Operation Outbox B",
    slug: "operation-outbox-b",
  });
  establishmentA = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Operation A",
    }),
  );
  establishmentB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Operation B",
    }),
  );
});

afterAll(async () => {
  await Promise.all([adminPool?.end(), appPool?.end(), migratorPool?.end()]);
});

describe("fundação operation/outbox", () => {
  it("converge 60 criações concorrentes na mesma operação e outbox", async () => {
    const commonIdempotency = digest("idempotency:concurrent-distinct");
    const commonRequestHash = digest("request:concurrent-distinct");
    const commonVehicle = digest("vehicle:concurrent-distinct");
    const inputs = Array.from({ length: 60 }, (_, index) => ({
      ...operationInput(`concurrent-distinct:${index}`, establishmentA.id),
      authTag: randomBytes(16),
      idempotencyDigest: commonIdempotency,
      nonce: randomBytes(12),
      requestCiphertext: randomBytes(32),
      requestHash: commonRequestHash,
      vehicleDigest: commonVehicle,
    }));
    expect(new Set(inputs.map(({ operationId }) => operationId)).size).toBe(60);
    expect(
      new Set(inputs.map(({ nonce }) => nonce.toString("hex"))),
    ).toHaveProperty("size", 60);
    expect(
      new Set(
        inputs.map(({ projectionNonce }) => projectionNonce.toString("hex")),
      ),
    ).toHaveProperty("size", 60);
    expect(
      new Set(
        inputs.map(({ requestCiphertext }) =>
          requestCiphertext.toString("hex"),
        ),
      ),
    ).toHaveProperty("size", 60);
    const results = await Promise.all(
      inputs.map((input) =>
        withTenant(appPool, tenantA.id, (client) =>
          createOperation(client, input),
        ),
      ),
    );

    const winnerIndexes = results.flatMap((result, index) =>
      result.replayed ? [] : [index],
    );
    expect(winnerIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0]!;
    const winner = inputs[winnerIndex]!;
    expect(results[winnerIndex]!.operation_id).toBe(winner.operationId);
    expect(new Set(results.map(({ operation_id }) => operation_id))).toEqual(
      new Set([winner.operationId]),
    );
    expect(
      results.every(
        ({ operation_status }) => operation_status === "PENDING_SEND",
      ),
    ).toBe(true);

    const counts = await withTenant(
      migratorPool,
      tenantA.id,
      async (client) => {
        const result = await client.query(
          `select
           (select count(*)::int from renave.operation
             where idempotency_key_digest = $1) as operations,
           (select count(*)::int from renave.operation_outbox outbox
             join renave.operation operation
               on operation.tenant_id = outbox.tenant_id
              and operation.id = outbox.operation_id
            where operation.idempotency_key_digest = $1) as outbox,
           (select count(*)::int from renave.operation_transition transition
             join renave.operation operation
               on operation.tenant_id = transition.tenant_id
              and operation.id = transition.operation_id
            where operation.idempotency_key_digest = $1) as transitions`,
          [commonIdempotency],
        );
        const persisted = await client.query<{
          operation_id: string;
          projection_auth_tag: Buffer;
          projection_ciphertext: Buffer;
          projection_key_id: string;
          projection_nonce: Buffer;
          request_auth_tag: Buffer;
          request_ciphertext: Buffer;
          request_key_id: string;
          request_nonce: Buffer;
        }>(
          `select operation.id as operation_id, operation.request_auth_tag,
                operation.request_ciphertext, operation.request_key_id,
                operation.request_nonce, projection.projection_auth_tag,
                projection.projection_ciphertext, projection.projection_key_id,
                projection.projection_nonce
           from renave.operation operation
           join renave.operation_reconciliation_projection projection
             on projection.tenant_id = operation.tenant_id
            and projection.operation_id = operation.id
          where operation.idempotency_key_digest = $1`,
          [commonIdempotency],
        );
        const candidates = await client.query<{ id: string }>(
          "select id from renave.operation where id = any($1::uuid[]) order by id",
          [inputs.map(({ operationId }) => operationId)],
        );
        return { candidates, persisted, result };
      },
    );
    expect(counts.result.rows[0]).toEqual({
      operations: 1,
      outbox: 1,
      transitions: 1,
    });
    expect(counts.candidates.rows).toEqual([{ id: winner.operationId }]);
    expect(counts.persisted.rows).toHaveLength(1);
    const stored = counts.persisted.rows[0]!;
    expect(stored.operation_id).toBe(winner.operationId);
    expect(stored.request_key_id).toBe(winner.keyId);
    expect(stored.request_nonce.equals(winner.nonce)).toBe(true);
    expect(stored.request_auth_tag.equals(winner.authTag)).toBe(true);
    expect(stored.request_ciphertext.equals(winner.requestCiphertext)).toBe(
      true,
    );
    expect(stored.projection_key_id).toBe(winner.projectionKeyId);
    expect(stored.projection_nonce.equals(winner.projectionNonce)).toBe(true);
    expect(stored.projection_auth_tag.equals(winner.projectionAuthTag)).toBe(
      true,
    );
    expect(
      stored.projection_ciphertext.equals(winner.projectionCiphertext),
    ).toBe(true);
  });

  it("recusa a mesma chave quando os buffers diferem exatamente um byte", async () => {
    const original = operationInput("payload-conflict", establishmentA.id);
    original.requestCiphertext = Buffer.from([1, 2, 3, 4]);
    original.requestHash = createHash("sha256")
      .update(original.requestCiphertext)
      .digest();
    await withTenant(appPool, tenantA.id, (client) =>
      createOperation(client, original),
    );
    const changedCiphertext = Buffer.from(original.requestCiphertext);
    changedCiphertext[changedCiphertext.length - 1]! ^= 1;
    const changed = {
      ...original,
      requestCiphertext: changedCiphertext,
      requestHash: createHash("sha256").update(changedCiphertext).digest(),
    };

    expect(
      original.requestCiphertext.reduce(
        (differences, byte, index) =>
          differences + (byte === changedCiphertext[index] ? 0 : 1),
        0,
      ),
    ).toBe(1);

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, changed),
      ),
    ).rejects.toMatchObject({ code: "23000" });

    const counts = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        `select
           (select count(*)::int from renave.operation
             where idempotency_key_digest = $1) as operations,
           (select count(*)::int from renave.operation_outbox outbox
             join renave.operation operation
               on operation.tenant_id = outbox.tenant_id
              and operation.id = outbox.operation_id
            where operation.idempotency_key_digest = $1) as outbox`,
        [original.idempotencyDigest],
      ),
    );
    expect(counts.rows[0]).toEqual({ operations: 1, outbox: 1 });
  });

  it("reverte operação e projeção quando o outbox falha e permite retry", async () => {
    const input = operationInput("atomic-outbox-failure", establishmentA.id);
    await migratorPool.query(`
      create function renave.test_fail_operation_outbox_insert()
      returns trigger language plpgsql set search_path=pg_catalog as $$
      begin
        raise exception 'falha injetada no outbox';
      end $$;
      create trigger test_fail_operation_outbox_insert
        before insert on renave.operation_outbox
        for each row execute function renave.test_fail_operation_outbox_insert();
    `);
    try {
      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          createOperation(client, input),
        ),
      ).rejects.toThrow();

      const rolledBack = await withTenant(migratorPool, tenantA.id, (client) =>
        client.query<{
          operation_count: number;
          outbox_count: number;
          projection_count: number;
          transition_count: number;
        }>(
          `select
               (select count(*)::int from renave.operation
                 where id = $1) as operation_count,
               (select count(*)::int
                  from renave.operation_reconciliation_projection
                 where operation_id = $1) as projection_count,
               (select count(*)::int from renave.operation_outbox
                 where operation_id = $1) as outbox_count,
               (select count(*)::int from renave.operation_transition
                 where operation_id = $1) as transition_count`,
          [input.operationId],
        ),
      );
      expect(rolledBack.rows[0]).toEqual({
        operation_count: 0,
        outbox_count: 0,
        projection_count: 0,
        transition_count: 0,
      });
    } finally {
      await migratorPool.query(`
        drop trigger if exists test_fail_operation_outbox_insert
          on renave.operation_outbox;
        drop function if exists renave.test_fail_operation_outbox_insert();
      `);
    }

    const retry = await withTenant(appPool, tenantA.id, (client) =>
      createOperation(client, input),
    );
    expect(retry).toMatchObject({
      operation_id: input.operationId,
      replayed: false,
    });
  });

  it("isola tenants e permite o mesmo digest em tenants distintos", async () => {
    const inputA = operationInput("cross-tenant", establishmentA.id);
    const inputB = {
      ...inputA,
      establishmentId: establishmentB.id,
      operationId: randomUUID(),
      projectionNonce: randomBytes(12),
    };
    const [createdA, createdB] = await Promise.all([
      withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, inputA),
      ),
      withTenant(appPool, tenantB.id, (client) =>
        createOperation(client, inputB),
      ),
    ]);
    expect(createdA.operation_id).not.toBe(createdB.operation_id);

    const hidden = await withTenant(appPool, tenantB.id, (client) =>
      client.query("select * from renave.get_operation_summary($1)", [
        createdA.operation_id,
      ]),
    );
    expect(hidden.rows).toEqual([]);
  });

  it("aplica FORCE RLS inclusive à projeção e limpa tenant no mesmo backend", async () => {
    const created = await withTenant(appPool, tenantA.id, (client) =>
      createOperation(
        client,
        operationInput("rls-behavior", establishmentA.id),
      ),
    );
    // `operation` usa `id`, ao contrário das duas tabelas filhas.
    const ownOperation = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        "select count(*)::int as count from renave.operation where id = $1",
        [created.operation_id],
      ),
    );
    expect(ownOperation.rows[0].count).toBe(1);
    const tenantBCounts = await withTenant(
      migratorPool,
      tenantB.id,
      async (client) => {
        const operation = await client.query(
          "select count(*)::int as count from renave.operation where id = $1",
          [created.operation_id],
        );
        const children = await Promise.all(
          [
            "operation_outbox",
            "operation_transition",
            "operation_reconciliation_projection",
          ].map((table) =>
            client.query(
              `select count(*)::int as count from renave.${table} where operation_id = $1`,
              [created.operation_id],
            ),
          ),
        );
        return [operation, ...children].map(({ rows }) => rows[0].count);
      },
    );
    expect(tenantBCounts).toEqual([0, 0, 0, 0]);
    const withoutTenant = await Promise.all([
      migratorPool.query(
        "select count(*)::int as count from renave.operation where id = $1",
        [created.operation_id],
      ),
      migratorPool.query(
        "select count(*)::int as count from renave.operation_outbox where operation_id = $1",
        [created.operation_id],
      ),
      migratorPool.query(
        "select count(*)::int as count from renave.operation_transition where operation_id = $1",
        [created.operation_id],
      ),
      migratorPool.query(
        "select count(*)::int as count from renave.operation_reconciliation_projection where operation_id = $1",
        [created.operation_id],
      ),
    ]);
    expect(withoutTenant.map(({ rows }) => rows[0].count)).toEqual([
      0, 0, 0, 0,
    ]);

    await withTenant(migratorPool, tenantB.id, async (client) => {
      const writes = [];
      writes.push(
        await client.query(
          "update renave.operation set last_error_code = 'ATTACK', version = version + 1 where id = $1",
          [created.operation_id],
        ),
      );
      writes.push(
        await client.query(
          "update renave.operation_outbox set available_at = available_at where operation_id = $1",
          [created.operation_id],
        ),
      );
      writes.push(
        await client.query(
          "update renave.operation_transition set reason_code = 'ATTACK' where operation_id = $1",
          [created.operation_id],
        ),
      );
      writes.push(
        await client.query(
          "update renave.operation_reconciliation_projection set projection_key_id = projection_key_id where operation_id = $1",
          [created.operation_id],
        ),
      );
      expect(writes.map(({ rowCount }) => rowCount)).toEqual([0, 0, 0, 0]);
    });

    const reused = await migratorPool.connect();
    try {
      const pid = await reused.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      await reused.query("begin");
      await reused.query("select set_config('renave.tenant_id',$1,true)", [
        tenantA.id,
      ]);
      const visibleA = await reused.query<{ count: number }>(
        `select count(*)::int as count
           from renave.operation_reconciliation_projection
          where operation_id = $1`,
        [created.operation_id],
      );
      await reused.query("commit");
      await reused.query("begin");
      await reused.query("select set_config('renave.tenant_id',$1,true)", [
        tenantB.id,
      ]);
      const visibleB = await reused.query<{ count: number; pid: number }>(
        `select count(*)::int as count, pg_backend_pid() as pid
           from renave.operation_reconciliation_projection
          where operation_id = $1`,
        [created.operation_id],
      );
      await reused.query("commit");
      expect(visibleA.rows[0]?.count).toBe(1);
      expect(visibleB.rows[0]).toEqual({ count: 0, pid: pid.rows[0]?.pid });
    } finally {
      reused.release();
    }
  });

  it("falha fechado sem tenant e com estabelecimento de outro tenant", async () => {
    const input = operationInput("missing-tenant", establishmentA.id);
    await expect(
      appPool.query(
        `select * from renave.create_operation_with_outbox(
          $1, $2, 'USED_STOCK_ENTRY', 'STOCK_ENTRY', $3, $4, $5,
          $6, 1, $7, $8, $9, $10, $11, $12,
          'STOCK_ENTRY_RECONCILIATION', 1, 1, $13, $14, $15, $16, $17
        )`,
        [
          input.operationId,
          input.establishmentId,
          input.idempotencyDigest,
          input.vehicleDigest,
          input.requestHash,
          input.requestCiphertext.byteLength,
          input.keyId,
          input.nonce,
          input.authTag,
          input.requestCiphertext,
          input.actorHash,
          input.correlationId,
          input.projectionCiphertext.byteLength,
          input.projectionKeyId,
          input.projectionNonce,
          input.projectionAuthTag,
          input.projectionCiphertext,
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOperation(
          client,
          operationInput("foreign-establishment", establishmentB.id),
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("bloqueia tenant suspenso e key id fora do formato fechado", async () => {
    await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
        "update renave.tenant set status = 'suspended' where id = $1",
        [tenantA.id],
      ),
    );
    try {
      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          createOperation(
            client,
            operationInput("suspended-tenant", establishmentA.id),
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "update renave.tenant set status = 'active' where id = $1",
          [tenantA.id],
        ),
      );
    }

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, {
          ...operationInput("invalid-key-id", establishmentA.id),
          keyId: "../secret",
        }),
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it.each([
    ["PENDING_SEND", []],
    ["SENT", ["SENT"]],
    ["PENDING_RECONCILIATION", ["SENT", "PENDING_RECONCILIATION"]],
    ["MANUAL_REVIEW", ["SENT", "PENDING_RECONCILIATION", "MANUAL_REVIEW"]],
  ] as const)(
    "bloqueia segunda chave enquanto a operação está %s",
    async (status, path) => {
      const first = operationInput(`active-${status}`, establishmentA.id);
      const created = await withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, first),
      );
      await withTenant(migratorPool, tenantA.id, async (client) => {
        for (const next of path) {
          await transitionOperation(client, created.operation_id, next);
        }
      });
      const second = {
        ...operationInput(`active-${status}-second`, establishmentA.id),
        vehicleDigest: first.vehicleDigest,
      };

      await expect(
        withTenant(appPool, tenantA.id, (client) =>
          createOperation(client, second),
        ),
      ).rejects.toMatchObject({ code: "23000" });
    },
  );

  it.each(["CONFIRMED", "REJECTED"] as const)(
    "libera nova operação após estado terminal %s",
    async (status) => {
      const first = operationInput(`terminal-${status}`, establishmentA.id);
      const created = await withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, first),
      );
      await withTenant(migratorPool, tenantA.id, async (client) => {
        await transitionOperation(client, created.operation_id, "SENT");
        await transitionOperation(client, created.operation_id, status);
      });
      const second = await withTenant(appPool, tenantA.id, (client) =>
        createOperation(client, {
          ...operationInput(`terminal-${status}-second`, establishmentA.id),
          vehicleDigest: first.vehicleDigest,
        }),
      );

      expect(second.operation_id).not.toBe(created.operation_id);
      expect(second.operation_status).toBe("PENDING_SEND");
    },
  );

  it("força RLS e concede somente funções sanitizadas à aplicação", async () => {
    const rls = await adminPool.query(
      `select count(*)::int as table_count,
              pg_catalog.bool_and(c.relrowsecurity and c.relforcerowsecurity) as force_rls
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave'
          and c.relname in ('operation', 'operation_outbox', 'operation_transition')`,
    );
    expect(rls.rows[0]).toEqual({ force_rls: true, table_count: 3 });

    const tableMatrix = await adminPool.query<{
      granted: boolean;
      privilege_name: string;
      role_name: string;
      table_name: string;
    }>(
      `with roles(role_name) as (
         values ('renave_app'), ('renave_identity_app'),
                ('renave_maintenance_app'), ('public')
       ), tables(table_name) as (
         values ('operation'), ('operation_outbox'), ('operation_transition'),
                ('operation_reconciliation_projection')
       ), privileges(privilege_name) as (
         values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')
       )
       select role_name, table_name, privilege_name,
              pg_catalog.has_table_privilege(
                role_name,
                pg_catalog.format('renave.%I', table_name),
                privilege_name
              ) as granted
         from roles cross join tables cross join privileges
        order by role_name, table_name, privilege_name`,
    );
    expect(tableMatrix.rows).toHaveLength(80);
    expect(tableMatrix.rows.every(({ granted }) => granted === false)).toBe(
      true,
    );

    const functionMatrix = await adminPool.query<{
      function_name: string;
      granted: boolean;
      role_name: string;
    }>(
      `with roles(role_name) as (
         values ('renave_app'), ('renave_identity_app'),
                ('renave_maintenance_app'), ('public')
       ), functions(function_name) as (
         values
           ('renave.create_operation_with_outbox(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'),
           ('renave.get_operation_summary(uuid)'),
           ('renave.operation_guard()'),
           ('renave.operation_outbox_guard()'),
           ('renave.operation_reconciliation_projection_reject_change()'),
           ('renave.operation_transition_reject_change()'),
           ('renave.operation_storage_reject_removal()')
       )
       select role_name, function_name,
              pg_catalog.has_function_privilege(
                role_name, function_name, 'execute'
              ) as granted
         from roles cross join functions
        order by role_name, function_name`,
    );
    expect(functionMatrix.rows).toHaveLength(28);
    for (const row of functionMatrix.rows) {
      expect(row.granted).toBe(
        row.role_name === "renave_app" &&
          (row.function_name.startsWith(
            "renave.create_operation_with_outbox",
          ) ||
            row.function_name === "renave.get_operation_summary(uuid)"),
      );
    }
  });

  it("triggers protegem payload e histórico inclusive contra o migrator", async () => {
    const input = operationInput("immutable", establishmentA.id);
    const operation = await withTenant(appPool, tenantA.id, (client) =>
      createOperation(client, input),
    );

    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "update renave.operation set request_ciphertext = $2, version = version + 1 where id = $1",
          [operation.operation_id, Buffer.from("tampered")],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query("delete from renave.operation where id = $1", [
          operation.operation_id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query("truncate renave.operation cascade"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "delete from renave.operation_transition where operation_id = $1",
          [operation.operation_id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query("truncate renave.operation_outbox"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "update renave.operation_transition set reason_code = 'TAMPERED' where operation_id = $1",
          [operation.operation_id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "update renave.operation_outbox set event_type = 'RECONCILE' where operation_id = $1",
          [operation.operation_id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "delete from renave.operation_outbox where operation_id = $1",
          [operation.operation_id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query("truncate renave.operation_transition"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query("truncate renave.operation"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
