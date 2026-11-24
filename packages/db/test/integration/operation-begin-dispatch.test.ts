import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayOperation,
  type CreateOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";

const urls = inject("dbUrls");

interface Fixture {
  establishment: Establishment;
  input: CreateOperationInput;
  operationId: string;
  tenant: Tenant;
}

interface LeaseClaim {
  attempt_count: number;
  lease_expires_at: Date;
  lease_token: string;
  operation_id: string;
  outbox_id: string;
}

interface DispatchRow {
  actor_subject_hash: Buffer;
  attempt_count: number;
  correlation_id: string;
  establishment_id: string;
  idempotency_key_digest: Buffer;
  kind: string;
  lease_expires_at: Date;
  lease_owner: string;
  lease_token: string;
  mutation_family: string;
  operation_id: string;
  operation_version: string;
  outbox_id: string;
  request_auth_tag: Buffer;
  request_ciphertext: Buffer;
  request_key_id: string;
  request_nonce: Buffer;
  request_schema_version: number;
  request_sha256: Buffer;
  request_size: number;
  sent_at: Date;
  tenant_id: string;
  vehicle_key_digest: Buffer;
}

interface StateRow {
  actor_subject_hash: Buffer;
  attempt_count: number;
  delivery_status: string;
  idempotency_key_digest: Buffer;
  last_error_code: string | null;
  lease_expires_at: Date;
  lease_owner: string;
  lease_token: string;
  operation_status: string;
  operation_updated_at: Date;
  operation_version: string;
  outbox_updated_at: Date;
  request_auth_tag: Buffer;
  request_ciphertext: Buffer;
  request_key_id: string;
  request_nonce: Buffer;
  request_schema_version: number;
  request_sha256: Buffer;
  request_size: number;
  sent_at: Date | null;
  sent_transition_actor_hash: Buffer | null;
  sent_transition_reason: string | null;
  sent_transition_version: string | null;
  sent_transitions: string;
  vehicle_key_digest: Buffer;
}

let adminPool: Pool;
let appPool: Pool;
let migratorPool: Pool;
let fixtureCounter = 0;

const dispatchColumns = [
  "actor_subject_hash",
  "attempt_count",
  "correlation_id",
  "establishment_id",
  "idempotency_key_digest",
  "kind",
  "lease_expires_at",
  "lease_owner",
  "lease_token",
  "mutation_family",
  "operation_id",
  "operation_version",
  "outbox_id",
  "request_auth_tag",
  "request_ciphertext",
  "request_key_id",
  "request_nonce",
  "request_schema_version",
  "request_sha256",
  "request_size",
  "sent_at",
  "tenant_id",
  "vehicle_key_digest",
].sort();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function fixture(label: string): Promise<Fixture> {
  fixtureCounter += 1;
  const tenant = await provisionTenant(migratorPool, {
    displayName: `Dispatch ${label} ${fixtureCounter}`,
    slug: `dispatch-${label}-${fixtureCounter}`,
  });
  const establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: `Dispatch ${label}`,
    }),
  );
  const input: CreateOperationInput = {
    ...operationProjectionFields(`dispatch:${label}:${fixtureCounter}`),
    actorSubjectHash: digest(`actor:${label}:${fixtureCounter}`),
    correlationId: randomUUID(),
    establishmentId: establishment.id,
    idempotencyKeyDigest: digest(`idempotency:${label}:${fixtureCounter}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 0xa3),
    requestCiphertext: Buffer.from(
      `ciphertext:${label}:${fixtureCounter}`,
      "utf8",
    ),
    requestKeyId: "dispatch-test-key",
    requestNonce: Buffer.alloc(12, 0xb4),
    requestSchemaVersion: 1,
    requestSha256: digest(`plaintext:${label}:${fixtureCounter}`),
    vehicleKeyDigest: digest(`vehicle:${label}:${fixtureCounter}`),
  };
  const created = await withTenant(migratorPool, tenant.id, (client) =>
    createOrReplayOperation(client, input),
  );
  return {
    establishment,
    input,
    operationId: created.operation.id,
    tenant,
  };
}

async function claim(target: Fixture, owner: string): Promise<LeaseClaim> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<LeaseClaim>(
      "select * from renave.claim_operation_send_leases($1, 1)",
      [owner],
    );
    return rows[0]!;
  });
}

async function beginDispatch(
  tenantId: string,
  outboxId: string,
  owner: string,
  token: string,
): Promise<DispatchRow[]> {
  return withTenant(migratorPool, tenantId, async (client) => {
    const { rows } = await client.query<DispatchRow>(
      "select * from renave.begin_operation_send_dispatch($1, $2, $3)",
      [outboxId, owner, token],
    );
    return rows;
  });
}

async function waitForDispatchLock(
  client: PoolClient,
  dispatchPid: number,
  adminPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await client.query<{ blocked_by_admin: boolean }>(
      `select $2::integer = any(
         pg_catalog.pg_blocking_pids($1::integer)
       ) as blocked_by_admin`,
      [dispatchPid, adminPid],
    );
    if (rows[0]!.blocked_by_admin) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `beginDispatch pid=${dispatchPid} não foi bloqueado pelo admin pid=${adminPid}`,
  );
}

async function proveAdministrativeSuspensionFence(
  targetKind: "tenant" | "establishment",
): Promise<void> {
  const target = await fixture(`race-${targetKind}`);
  const owner = randomUUID();
  const leased = await claim(target, owner);
  const before = await state(target, leased.outbox_id);
  const admin = await adminPool.connect();
  const dispatchClient = await migratorPool.connect();
  let adminTransaction = false;
  let dispatchTransaction = false;
  let dispatchCommitted = false;
  let dispatch: Promise<DispatchRow[]> | undefined;
  try {
    const adminPid = (
      await admin.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      )
    ).rows[0]!.pid;
    const dispatchPid = (
      await dispatchClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      )
    ).rows[0]!.pid;

    await admin.query("begin");
    adminTransaction = true;
    await dispatchClient.query("begin");
    dispatchTransaction = true;
    await dispatchClient.query("select set_config($1, $2, true)", [
      "renave.tenant_id",
      target.tenant.id.toLowerCase(),
    ]);
    await dispatchClient.query("set local statement_timeout = '8s'");

    if (targetKind === "tenant") {
      await admin.query(
        "update renave.tenant set status = 'suspended' where id = $1",
        [target.tenant.id],
      );
    } else {
      await admin.query(
        "update renave.establishment set status = 'inactive' where id = $1",
        [target.establishment.id],
      );
    }

    dispatch = dispatchClient
      .query<DispatchRow>(
        "select * from renave.begin_operation_send_dispatch($1, $2, $3)",
        [leased.outbox_id, owner, leased.lease_token],
      )
      .then(({ rows }) => rows);
    await waitForDispatchLock(admin, dispatchPid, adminPid);
    await admin.query("commit");
    adminTransaction = false;

    await expect(dispatch).resolves.toEqual([]);
    await dispatchClient.query("commit");
    dispatchTransaction = false;
    dispatchCommitted = true;
    expect(await state(target, leased.outbox_id)).toEqual(before);
  } finally {
    if (adminTransaction) await admin.query("rollback").catch(() => {});
    adminTransaction = false;
    if (dispatch !== undefined) await dispatch.catch(() => undefined);
    if (dispatchTransaction) {
      await dispatchClient.query("rollback").catch(() => {});
    }
    dispatchTransaction = false;
    admin.release();
    dispatchClient.release(dispatchCommitted ? undefined : true);
    if (targetKind === "tenant") {
      await adminPool.query(
        "update renave.tenant set status = 'active' where id = $1",
        [target.tenant.id],
      );
    } else {
      await adminPool.query(
        "update renave.establishment set status = 'active' where id = $1",
        [target.establishment.id],
      );
    }
  }
}

async function state(target: Fixture, outboxId: string): Promise<StateRow> {
  return withTenant(migratorPool, target.tenant.id, async (client) => {
    const { rows } = await client.query<StateRow>(
      `select operation.status as operation_status,
              operation.version::text as operation_version,
              operation.sent_at, operation.last_error_code,
              operation.updated_at as operation_updated_at,
              operation.idempotency_key_digest,
              operation.vehicle_key_digest,
              operation.actor_subject_hash,
              operation.request_sha256, operation.request_size,
              operation.request_schema_version, operation.request_key_id,
              operation.request_nonce, operation.request_auth_tag,
              operation.request_ciphertext,
              outbox.delivery_status, outbox.attempt_count,
              outbox.lease_owner, outbox.lease_token,
              outbox.lease_expires_at,
              outbox.updated_at as outbox_updated_at,
              (select count(*)::text
                 from renave.operation_transition transition
                where transition.tenant_id = operation.tenant_id
                  and transition.operation_id = operation.id
                  and transition.status = 'SENT') as sent_transitions
             ,(select transition.version::text
                 from renave.operation_transition transition
                where transition.tenant_id = operation.tenant_id
                  and transition.operation_id = operation.id
                  and transition.status = 'SENT') as sent_transition_version
             ,(select transition.reason_code
                 from renave.operation_transition transition
                where transition.tenant_id = operation.tenant_id
                  and transition.operation_id = operation.id
                  and transition.status = 'SENT') as sent_transition_reason
             ,(select transition.actor_hash
                 from renave.operation_transition transition
                where transition.tenant_id = operation.tenant_id
                  and transition.operation_id = operation.id
                  and transition.status = 'SENT') as sent_transition_actor_hash
         from renave.operation operation
         join renave.operation_outbox outbox
           on outbox.tenant_id = operation.tenant_id
          and outbox.operation_id = operation.id
        where operation.id = $1 and outbox.id = $2`,
      [target.operationId, outboxId],
    );
    return rows[0]!;
  });
}

beforeAll(() => {
  adminPool = createPool(urls.admin, { max: 1 });
  appPool = createPool(urls.app, { max: 8 });
  migratorPool = createPool(urls.migrator, { max: 32 });
});

afterAll(async () => {
  await Promise.all([adminPool?.end(), appPool?.end(), migratorPool?.end()]);
});

describe("operation begin dispatch", () => {
  it("grava o fence e só então devolve o envelope cifrado", async () => {
    const target = await fixture("success");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    const rows = await beginDispatch(
      target.tenant.id,
      leased.outbox_id,
      owner,
      leased.lease_token,
    );

    expect(rows).toHaveLength(1);
    const dispatched = rows[0]!;
    expect(Object.keys(dispatched).sort()).toEqual(dispatchColumns);
    expect(dispatched).toMatchObject({
      attempt_count: leased.attempt_count,
      correlation_id: target.input.correlationId.toLowerCase(),
      establishment_id: target.establishment.id,
      kind: "USED_STOCK_ENTRY",
      lease_owner: owner,
      lease_token: leased.lease_token,
      mutation_family: "STOCK_ENTRY",
      operation_id: target.operationId,
      operation_version: "2",
      outbox_id: leased.outbox_id,
      request_key_id: target.input.requestKeyId,
      request_schema_version: 1,
      request_size: target.input.requestCiphertext.byteLength,
      tenant_id: target.tenant.id,
    });
    expect(dispatched.lease_expires_at.getTime()).toBeGreaterThan(
      leased.lease_expires_at.getTime(),
    );
    expect(
      dispatched.lease_expires_at.getTime() - dispatched.sent_at.getTime(),
    ).toBe(300_000);
    expect(dispatched.sent_at).toBeInstanceOf(Date);
    expect(dispatched.actor_subject_hash).toEqual(
      target.input.actorSubjectHash,
    );
    expect(dispatched.idempotency_key_digest).toEqual(
      target.input.idempotencyKeyDigest,
    );
    expect(dispatched.vehicle_key_digest).toEqual(
      target.input.vehicleKeyDigest,
    );
    expect(dispatched.request_sha256).toEqual(target.input.requestSha256);
    expect(dispatched.request_nonce).toEqual(target.input.requestNonce);
    expect(dispatched.request_auth_tag).toEqual(target.input.requestAuthTag);
    expect(dispatched.request_ciphertext).toEqual(
      target.input.requestCiphertext,
    );
    expect(JSON.stringify(dispatched)).not.toMatch(
      /plaintext:|cpf|placa|renavam|email/iu,
    );

    const stored = await state(target, leased.outbox_id);
    expect(stored).toMatchObject({
      attempt_count: leased.attempt_count,
      delivery_status: "LEASED",
      lease_owner: owner,
      lease_token: leased.lease_token,
      operation_status: "SENT",
      operation_version: "2",
      sent_transition_reason: "DISPATCH_BEGUN",
      sent_transition_version: "2",
      sent_transitions: "1",
    });
    expect(stored.last_error_code).toBeNull();
    expect(stored.sent_at?.getTime()).toBe(dispatched.sent_at.getTime());
    expect(stored.operation_updated_at.getTime()).toBe(
      dispatched.sent_at.getTime(),
    );
    expect(stored.outbox_updated_at.getTime()).toBe(
      dispatched.sent_at.getTime(),
    );
    expect(stored.lease_expires_at.getTime()).toBe(
      dispatched.lease_expires_at.getTime(),
    );
    expect(stored.sent_transition_actor_hash).toEqual(
      target.input.actorSubjectHash,
    );
    for (const field of [
      "actor_subject_hash",
      "idempotency_key_digest",
      "vehicle_key_digest",
      "request_sha256",
      "request_nonce",
      "request_auth_tag",
      "request_ciphertext",
      "request_key_id",
      "request_schema_version",
      "request_size",
    ] as const) {
      expect(dispatched[field]).toEqual(stored[field]);
    }

    const afterFirstDispatch = await state(target, leased.outbox_id);
    await expect(
      beginDispatch(
        target.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).resolves.toEqual([]);
    expect(await state(target, leased.outbox_id)).toEqual(afterFirstDispatch);

    const controls = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => {
        const renewed = await client.query<{ result: boolean }>(
          "select renave.renew_operation_send_lease($1,$2,$3) as result",
          [leased.outbox_id, owner, leased.lease_token],
        );
        const released = await client.query<{ result: boolean }>(
          "select renave.release_operation_send_lease($1,$2,$3,0) as result",
          [leased.outbox_id, owner, leased.lease_token],
        );
        return {
          released: released.rows[0]!.result,
          renewed: renewed.rows[0]!.result,
        };
      },
    );
    expect(controls).toEqual({ released: false, renewed: false });

    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [leased.outbox_id],
      ),
    );
    const noReclaim = await withTenant(
      migratorPool,
      target.tenant.id,
      (client) =>
        client.query("select * from renave.claim_operation_send_leases($1,1)", [
          randomUUID(),
        ]),
    );
    expect(noReclaim.rows).toEqual([]);
  });

  it("concede o mesmo dispatch exatamente uma vez sob concorrência", async () => {
    const target = await fixture("concurrency");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    const attempts = await Promise.all(
      Array.from({ length: 24 }, () =>
        beginDispatch(
          target.tenant.id,
          leased.outbox_id,
          owner,
          leased.lease_token,
        ),
      ),
    );
    expect(attempts.flat()).toHaveLength(1);
    expect(await state(target, leased.outbox_id)).toMatchObject({
      attempt_count: 1,
      operation_status: "SENT",
      operation_version: "2",
      sent_transitions: "1",
    });
  });

  it("recusa fences divergentes, lease expirada e outro tenant sem mudar estado", async () => {
    const target = await fixture("fencing");
    const other = await fixture("fencing-other");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    const before = await state(target, leased.outbox_id);

    await expect(
      beginDispatch(
        target.tenant.id,
        leased.outbox_id,
        randomUUID(),
        leased.lease_token,
      ),
    ).resolves.toEqual([]);
    await expect(
      beginDispatch(target.tenant.id, leased.outbox_id, owner, randomUUID()),
    ).resolves.toEqual([]);
    await expect(
      beginDispatch(
        other.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).resolves.toEqual([]);
    expect(await state(target, leased.outbox_id)).toEqual(before);

    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [leased.outbox_id],
      ),
    );
    const expired = await state(target, leased.outbox_id);
    await expect(
      beginDispatch(
        target.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).resolves.toEqual([]);
    expect(await state(target, leased.outbox_id)).toEqual(expired);
  });

  it("recusa outbox READY ou RECONCILE sem expor envelope", async () => {
    const target = await fixture("event-state");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    await withTenant(migratorPool, target.tenant.id, (client) =>
      client.query(
        `update renave.operation_outbox
            set delivery_status = 'READY', lease_owner = null,
                lease_token = null, lease_expires_at = null
          where id = $1`,
        [leased.outbox_id],
      ),
    );
    const ready = await state(target, leased.outbox_id);
    await expect(
      beginDispatch(
        target.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).resolves.toEqual([]);
    expect(await state(target, leased.outbox_id)).toEqual(ready);

    const reconcileOwner = randomUUID();
    const reconcileToken = randomUUID();
    const reconcile = await withTenant(
      migratorPool,
      target.tenant.id,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into renave.operation_outbox (
             tenant_id, operation_id, event_type, delivery_status,
             attempt_count, lease_owner, lease_token, lease_expires_at
           ) values ($1, $2, 'RECONCILE', 'LEASED', 1, $3, $4,
                     clock_timestamp() + interval '5 minutes')
           returning id`,
          [
            target.tenant.id,
            target.operationId,
            reconcileOwner,
            reconcileToken,
          ],
        );
        return rows[0]!.id;
      },
    );
    const beforeReconcile = await state(target, reconcile);
    await expect(
      beginDispatch(
        target.tenant.id,
        reconcile,
        reconcileOwner,
        reconcileToken,
      ),
    ).resolves.toEqual([]);
    expect(await state(target, reconcile)).toEqual(beforeReconcile);
  });

  it("recusa tenant ou estabelecimento inativo e preserva o lease", async () => {
    for (const targetKind of ["tenant", "establishment"] as const) {
      const target = await fixture(`inactive-${targetKind}`);
      const owner = randomUUID();
      const leased = await claim(target, owner);
      const before = await state(target, leased.outbox_id);
      try {
        await withTenant(migratorPool, target.tenant.id, (client) =>
          targetKind === "tenant"
            ? client.query("update renave.tenant set status='suspended'")
            : client.query(
                "update renave.establishment set status='inactive' where id=$1",
                [target.establishment.id],
              ),
        );
        await expect(
          beginDispatch(
            target.tenant.id,
            leased.outbox_id,
            owner,
            leased.lease_token,
          ),
        ).resolves.toEqual([]);
        expect(await state(target, leased.outbox_id)).toEqual(before);
      } finally {
        await withTenant(migratorPool, target.tenant.id, (client) =>
          targetKind === "tenant"
            ? client.query("update renave.tenant set status='active'")
            : client.query(
                "update renave.establishment set status='active' where id=$1",
                [target.establishment.id],
              ),
        );
      }
    }
  });

  it("aguarda suspensão concorrente do tenant e recusa o dispatch", async () => {
    await proveAdministrativeSuspensionFence("tenant");
  });

  it("aguarda inativação concorrente do estabelecimento e recusa o dispatch", async () => {
    await proveAdministrativeSuspensionFence("establishment");
  });

  it("rollback externo restaura operação, transition e lease", async () => {
    const target = await fixture("rollback");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    const before = await state(target, leased.outbox_id);
    await expect(
      withTenant(migratorPool, target.tenant.id, async (client) => {
        const result = await client.query(
          "select * from renave.begin_operation_send_dispatch($1,$2,$3)",
          [leased.outbox_id, owner, leased.lease_token],
        );
        expect(result.rows).toHaveLength(1);
        throw new Error("rollback intencional");
      }),
    ).rejects.toThrow("rollback intencional");
    expect(await state(target, leased.outbox_id)).toEqual(before);
    await expect(
      beginDispatch(
        target.tenant.id,
        leased.outbox_id,
        owner,
        leased.lease_token,
      ),
    ).resolves.toHaveLength(1);
  });

  it("falha interna na transition reverte também a operação e o lease", async () => {
    const target = await fixture("internal-rollback");
    const owner = randomUUID();
    const leased = await claim(target, owner);
    const before = await state(target, leased.outbox_id);
    await adminPool.query(
      `create function renave.reject_dispatch_transition_probe()
       returns trigger language plpgsql set search_path = pg_catalog as $$
       begin
         if new.reason_code = 'DISPATCH_BEGUN' then
           raise exception 'probe';
         end if;
         return new;
       end $$`,
    );
    await adminPool.query(
      `create trigger reject_dispatch_transition_probe
       before insert on renave.operation_transition
       for each row execute function renave.reject_dispatch_transition_probe()`,
    );
    try {
      await expect(
        beginDispatch(
          target.tenant.id,
          leased.outbox_id,
          owner,
          leased.lease_token,
        ),
      ).rejects.toThrow();
    } finally {
      await adminPool.query(
        "drop trigger reject_dispatch_transition_probe on renave.operation_transition",
      );
      await adminPool.query(
        "drop function renave.reject_dispatch_transition_probe()",
      );
    }
    expect(await state(target, leased.outbox_id)).toEqual(before);
  });

  it("permanece owner-only e sem grant para papéis de runtime", async () => {
    const { rows } = await adminPool.query<{
      app_execute: boolean;
      identity_execute: boolean;
      maintenance_execute: boolean;
      migrator_execute: boolean;
      public_execute: boolean;
    }>(
      `select
         has_function_privilege('renave_app',
           'renave.begin_operation_send_dispatch(uuid,uuid,uuid)', 'execute') as app_execute,
         has_function_privilege('renave_identity_app',
           'renave.begin_operation_send_dispatch(uuid,uuid,uuid)', 'execute') as identity_execute,
         has_function_privilege('renave_maintenance_app',
           'renave.begin_operation_send_dispatch(uuid,uuid,uuid)', 'execute') as maintenance_execute,
         has_function_privilege('renave_migrator',
           'renave.begin_operation_send_dispatch(uuid,uuid,uuid)', 'execute') as migrator_execute,
         has_function_privilege('public',
           'renave.begin_operation_send_dispatch(uuid,uuid,uuid)', 'execute') as public_execute`,
    );
    expect(rows[0]).toEqual({
      app_execute: false,
      identity_execute: false,
      maintenance_execute: false,
      migrator_execute: true,
      public_execute: false,
    });
  });
});
