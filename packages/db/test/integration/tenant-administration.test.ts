import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  inject,
} from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
import {
  getCredentialLink,
  listCredentialLinkHistory,
} from "../../src/credential-links.js";
import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import { listAuditEvents, verifyAuditChain } from "../../src/audit-events.js";
import {
  PostgresTenantAdminRateLimiter,
  type TenantAdminRateLimitResult,
} from "../../src/tenant-admin-rate-limiter.js";
import {
  PostgresTenantAdministration,
  TenantAdminAccessDeniedError,
  TenantAdminCnpjConflictError,
  TenantAdminIdempotencyConflictError,
  TenantAdminStorageError,
  type CreateAdminEstablishmentInput,
} from "../../src/tenant-administration.js";
import {
  createPool,
  withTenant,
  type TenantClient,
} from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const SUBJECT = "oidc|tenant-administration-test";

let appPool: Pool;
let identityPool: Pool;
let migratorPool: Pool;
let tenant: Tenant;
let tenantB: Tenant;
let repository: PostgresTenantAdministration;
let limiter: PostgresTenantAdminRateLimiter;

function validCnpj(index: number): string {
  const base = `99123456${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

function idempotencyKey(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function input(
  index: number,
  overrides: Partial<CreateAdminEstablishmentInput> = {},
): CreateAdminEstablishmentInput {
  const cnpj = validCnpj(index);
  return {
    actorIp: "203.0.113.10",
    actorSubject: SUBJECT,
    cnpj,
    idempotencyKey: idempotencyKey(index),
    traceId: `tenant-admin-${index}`,
    tradeName: `Loja ${index}`,
    ...overrides,
  };
}

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 16 });
  identityPool = createPool(urls.identity, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 4 });
  repository = new PostgresTenantAdministration(Buffer.alloc(32, 11));
  limiter = new PostgresTenantAdminRateLimiter(appPool, Buffer.alloc(32, 9));
  tenant = await provisionTenant(migratorPool, {
    displayName: "Tenant Administration",
    slug: "tenant-administration",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Tenant Administration B",
    slug: "tenant-administration-b",
  });
  await withTenant(migratorPool, tenant.id, (client) =>
    grantTenantUserAccess(client, SUBJECT, [{ role: "tenant_admin" }]),
  );
  await withTenant(migratorPool, tenantB.id, (client) =>
    grantTenantUserAccess(client, SUBJECT, [{ role: "tenant_admin" }]),
  );
});

beforeEach(async () => {
  await migratorPool.query(
    "delete from renave_runtime.tenant_admin_rate_bucket",
  );
  await migratorPool.query(
    `update renave_runtime.tenant_admin_rate_policy
        set global_capacity = 100,
            global_refill_per_second = 0.000001,
            tenant_capacity = 30,
            tenant_refill_per_second = 0.000001,
            actor_capacity = 10,
            actor_refill_per_second = 0.000001`,
  );
});

afterAll(async () => {
  repository?.destroy();
  limiter?.destroy();
  await Promise.all([appPool?.end(), identityPool?.end(), migratorPool?.end()]);
});

describe("administração transacional de estabelecimentos", () => {
  it("cria, audita, não inventa vínculo e reproduz a mesma resposta", async () => {
    const request = input(1);
    const created = await withTenant(appPool, tenant.id, (client) =>
      repository.create(client, request),
    );
    const replayed = await withTenant(appPool, tenant.id, (client) =>
      repository.create(client, request),
    );

    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({
      credentialLinkStatus: "not_started",
      establishment: { id: created.establishment.id, cnpj: request.cnpj },
      replayed: true,
    });
    const state = await withTenant(appPool, tenant.id, async (client) => ({
      audit: await listAuditEvents(client),
      chainValid: await verifyAuditChain(client),
      history: await listCredentialLinkHistory(
        client,
        created.establishment.id,
      ),
      link: await getCredentialLink(client, created.establishment.id),
    }));
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action: "tenant.establishment.create",
      actorSubject: SUBJECT,
      establishmentId: created.establishment.id,
      outcome: "succeeded",
    });
    expect(state.audit[0]?.cnpjSent).toBeNull();
    expect(state.chainValid).toBe(true);
    expect(state.link).toBeNull();
    expect(state.history).toEqual([]);
  });

  it("recusa reutilizar a chave com payload diferente", async () => {
    const original = input(2);
    await withTenant(appPool, tenant.id, (client) =>
      repository.create(client, original),
    );

    await expect(
      withTenant(appPool, tenant.id, (client) =>
        repository.create(client, {
          ...original,
          tradeName: "Outro nome",
        }),
      ),
    ).rejects.toBeInstanceOf(TenantAdminIdempotencyConflictError);
  });

  it("serializa replays idempotentes concorrentes", async () => {
    const request = input(6);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(appPool, tenant.id, (client) =>
          repository.create(client, request),
        ),
      ),
    );

    expect(new Set(results.map((result) => result.establishment.id)).size).toBe(
      1,
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(9);
    const establishmentId = results[0]!.establishment.id;
    const events = await withTenant(appPool, tenant.id, listAuditEvents);
    expect(
      events.filter((event) => event.establishmentId === establishmentId),
    ).toHaveLength(1);
  });

  it("permite o mesmo CNPJ e chave em tenants distintos sem cruzar auditoria", async () => {
    const request = input(7);
    const [createdA, createdB] = await Promise.all([
      withTenant(appPool, tenant.id, (client) =>
        repository.create(client, request),
      ),
      withTenant(appPool, tenantB.id, (client) =>
        repository.create(client, request),
      ),
    ]);

    expect(createdA.establishment.id).not.toBe(createdB.establishment.id);
    const [eventsA, eventsB] = await Promise.all([
      withTenant(appPool, tenant.id, listAuditEvents),
      withTenant(appPool, tenantB.id, listAuditEvents),
    ]);
    expect(
      eventsA.some(
        (event) => event.establishmentId === createdB.establishment.id,
      ),
    ).toBe(false);
    expect(
      eventsB.some(
        (event) => event.establishmentId === createdA.establishment.id,
      ),
    ).toBe(false);
    await expect(
      withTenant(appPool, tenantB.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("serializa CNPJ duplicado sob concorrência e audita uma única criação", async () => {
    const sharedCnpj = validCnpj(3);
    const before = await withTenant(appPool, tenant.id, (client) =>
      listAuditEvents(client),
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        withTenant(appPool, tenant.id, (client) =>
          repository.create(
            client,
            input(30 + index, {
              cnpj: sharedCnpj,
              tradeName: "Loja concorrente",
            }),
          ),
        ),
      ),
    );

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(rejected).toHaveLength(9);
    expect(
      rejected.every(
        (attempt) => attempt.reason instanceof TenantAdminCnpjConflictError,
      ),
    ).toBe(true);
    const after = await withTenant(appPool, tenant.id, (client) =>
      listAuditEvents(client),
    );
    expect(after).toHaveLength(before.length + 1);
    await expect(
      withTenant(appPool, tenant.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("reverte estabelecimento e idempotência quando a auditoria falha", async () => {
    const request = input(4);
    const claimsBefore = await withTenant(
      appPool,
      tenant.id,
      async (client) => {
        const result = await client.query<{ count: number }>(
          `select count(*)::integer as count
           from renave.admin_mutation_idempotency`,
        );
        return result.rows[0]!.count;
      },
    );
    await expect(
      withTenant(appPool, tenant.id, (client) => {
        const failingClient = {
          query: (async (text: unknown, values?: readonly unknown[]) => {
            if (
              typeof text === "string" &&
              text.includes("insert into renave.audit_event")
            ) {
              throw new Error("audit failure injected by test");
            }
            return client.query(text as never, values as never);
          }) as TenantClient["query"],
        } as TenantClient;
        return repository.create(failingClient, request);
      }),
    ).rejects.toBeInstanceOf(TenantAdminStorageError);

    const persisted = await withTenant(appPool, tenant.id, async (client) => {
      const establishments = await client.query<{ count: number }>(
        "select count(*)::integer as count from renave.establishment where cnpj = $1",
        [request.cnpj],
      );
      const claims = await client.query<{ count: number }>(
        `select count(*)::integer as count
           from renave.admin_mutation_idempotency`,
      );
      return {
        claims: claims.rows[0]?.count,
        establishments: establishments.rows[0]?.count,
      };
    });
    expect(persisted).toEqual({
      claims: claimsBefore,
      establishments: 0,
    });
  });

  it("revalida o grant imediatamente antes da mutação", async () => {
    await withTenant(migratorPool, tenant.id, (client) =>
      client.query(
        "delete from renave.tenant_role_grant where subject = $1 and role = 'tenant_admin'",
        [SUBJECT],
      ),
    );
    try {
      await expect(
        withTenant(appPool, tenant.id, (client) =>
          repository.create(client, input(5)),
        ),
      ).rejects.toBeInstanceOf(TenantAdminAccessDeniedError);
    } finally {
      await withTenant(migratorPool, tenant.id, (client) =>
        grantTenantUserAccess(client, SUBJECT, [{ role: "tenant_admin" }]),
      );
    }
  });
});

describe("limite administrativo distribuído", () => {
  it("remove buckets não globais inativos em lote durante o consumo", async () => {
    await migratorPool.query(
      `insert into renave_runtime.tenant_admin_rate_bucket (
         scope, scope_key, available_units, last_refill_at, last_seen_at
       ) values
         ('tenant', $1, 1, clock_timestamp() - interval '49 hours',
          clock_timestamp() - interval '49 hours'),
         ('actor', $2, 1, clock_timestamp() - interval '49 hours',
          clock_timestamp() - interval '49 hours')`,
      [Buffer.alloc(32, 41), Buffer.alloc(32, 42)],
    );

    await limiter.consume({ subject: SUBJECT, tenantId: tenant.id });

    const stale = await migratorPool.query<{ count: number }>(
      `select count(*)::integer as count
         from renave_runtime.tenant_admin_rate_bucket
        where scope <> 'global'
          and last_seen_at < clock_timestamp() - interval '48 hours'`,
    );
    expect(stale.rows[0]?.count).toBe(0);
  });

  it("consome a capacidade do ator atomicamente sob concorrência", async () => {
    await migratorPool.query(
      `update renave_runtime.tenant_admin_rate_policy
          set global_capacity = 100, tenant_capacity = 100, actor_capacity = 3`,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.consume({ subject: SUBJECT, tenantId: tenant.id }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    const limited = results.filter(
      (
        result,
      ): result is Extract<TenantAdminRateLimitResult, { allowed: false }> =>
        !result.allowed,
    );
    expect(limited).toHaveLength(9);
    expect(limited.every((result) => result.scope === "actor")).toBe(true);
    expect(limited.every((result) => result.retryAfterSeconds >= 1)).toBe(true);
  });

  it("expõe somente a função ao papel de negócio", async () => {
    await expect(
      appPool.query("select * from renave_runtime.tenant_admin_rate_bucket"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query(
        "select * from renave_runtime.consume_tenant_admin_rate_limit($1, $2)",
        [Buffer.alloc(32), Buffer.alloc(32, 1)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
