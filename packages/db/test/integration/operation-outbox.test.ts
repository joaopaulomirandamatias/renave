import { createHash, randomUUID } from "node:crypto";

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
  requestCiphertext: Buffer;
  requestHash: Buffer;
  vehicleDigest: Buffer;
}

function operationInput(
  label: string,
  establishmentId: string,
): OperationInput {
  const requestCiphertext = Buffer.from(`ciphertext:${label}`, "utf8");
  return {
    actorHash: digest(`actor:${label}`),
    authTag: Buffer.alloc(16, 7),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyDigest: digest(`idempotency:${label}`),
    keyId: "test-key-v1",
    nonce: Buffer.alloc(12, 3),
    requestCiphertext,
    requestHash: digest(`request:${label}`),
    vehicleDigest: digest(`vehicle:${label}`),
  };
}

async function createOperation(client: PoolClient, input: OperationInput) {
  const { rows } = await client.query(
    `select * from renave.create_operation_with_outbox(
       $1, 'USED_STOCK_ENTRY', 'STOCK_ENTRY', $2, $3, $4,
       $5, 1, $6, $7, $8, $9, $10, $11
     )`,
    [
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
    const input = operationInput("concurrent", establishmentA.id);
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        withTenant(appPool, tenantA.id, (client) =>
          createOperation(client, input),
        ),
      ),
    );

    expect(new Set(results.map(({ operation_id }) => operation_id)).size).toBe(
      1,
    );
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(
      results.every(
        ({ operation_status }) => operation_status === "PENDING_SEND",
      ),
    ).toBe(true);

    const counts = await withTenant(migratorPool, tenantA.id, (client) =>
      client.query(
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
        [input.idempotencyDigest],
      ),
    );
    expect(counts.rows[0]).toEqual({
      operations: 1,
      outbox: 1,
      transitions: 1,
    });
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

  it("isola tenants e permite o mesmo digest em tenants distintos", async () => {
    const inputA = operationInput("cross-tenant", establishmentA.id);
    const inputB = { ...inputA, establishmentId: establishmentB.id };
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

  it("aplica FORCE RLS diretamente nas três tabelas", async () => {
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
          ["operation_outbox", "operation_transition"].map((table) =>
            client.query(
              `select count(*)::int as count from renave.${table} where operation_id = $1`,
              [created.operation_id],
            ),
          ),
        );
        return [operation, ...children].map(({ rows }) => rows[0].count);
      },
    );
    expect(tenantBCounts).toEqual([0, 0, 0]);
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
    ]);
    expect(withoutTenant.map(({ rows }) => rows[0].count)).toEqual([0, 0, 0]);

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
      expect(writes.map(({ rowCount }) => rowCount)).toEqual([0, 0, 0]);
    });
  });

  it("falha fechado sem tenant e com estabelecimento de outro tenant", async () => {
    const input = operationInput("missing-tenant", establishmentA.id);
    await expect(
      appPool.query(
        `select * from renave.create_operation_with_outbox(
          $1, 'USED_STOCK_ENTRY', 'STOCK_ENTRY', $2, $3, $4,
          $5, 1, $6, $7, $8, $9, $10, $11
        )`,
        [
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
         values ('operation'), ('operation_outbox'), ('operation_transition')
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
    expect(tableMatrix.rows).toHaveLength(60);
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
           ('renave.create_operation_with_outbox(uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid)'),
           ('renave.get_operation_summary(uuid)'),
           ('renave.operation_guard()'),
           ('renave.operation_outbox_guard()'),
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
    expect(functionMatrix.rows).toHaveLength(24);
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
