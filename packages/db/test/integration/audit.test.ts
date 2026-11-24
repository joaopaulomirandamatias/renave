import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import {
  appendAuditEvent,
  listAuditEvents,
  verifyAuditChain,
} from "../../src/audit-events.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CERTIFICATE_HASH = "c".repeat(64);

let appPool: Pool;
let migratorPool: Pool;
let adminPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentA: Establishment;
let establishmentB: Establishment;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  adminPool = createPool(urls.admin, { max: 1 });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Audit Tenant A",
    slug: "audit-tenant-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Audit Tenant B",
    slug: "audit-tenant-b",
  });
  establishmentA = await withTenant(appPool, tenantA.id, (client) =>
    createEstablishment(client, {
      cnpj: "11.222.333/0001-81",
      tradeName: "Audit A",
    }),
  );
  establishmentB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "12ABC34501DE35",
      tradeName: "Audit B",
    }),
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end(), adminPool?.end()]);
});

function appendFor(
  tenant: Tenant,
  establishment: Establishment,
  action: string,
) {
  return withTenant(appPool, tenant.id, (client) =>
    appendAuditEvent(client, {
      action,
      actorIp: "127.0.0.1",
      actorSubject: "operator:test",
      certificateThumbprintSha256: CERTIFICATE_HASH,
      cnpjConfirmed: establishment.cnpj,
      cnpjSent: establishment.cnpj,
      establishmentId: establishment.id,
      integratorCnpjConfirmed: "69418503000188",
      outcome: "succeeded",
      payloadReference: "worm://audit/test",
      requestSha256: HASH_A,
      responseSha256: HASH_B,
      traceId: crypto.randomUUID(),
    }),
  );
}

describe("trilha de auditoria", () => {
  it("encadeia eventos e valida a cadeia do tenant", async () => {
    const first = await appendFor(
      tenantA,
      establishmentA,
      "renave.identity.confirmed",
    );
    const second = await appendFor(
      tenantA,
      establishmentA,
      "renave.eligibility.succeeded",
    );

    expect(first.previousHash).toBe("0".repeat(64));
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.previousHash).toBe(first.eventHash);
    await expect(
      withTenant(appPool, tenantA.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("isola leitura e cadeia entre tenants", async () => {
    const eventB = await appendFor(
      tenantB,
      establishmentB,
      "renave.identity.confirmed",
    );
    const eventsA = await withTenant(appPool, tenantA.id, listAuditEvents);
    const eventsB = await withTenant(appPool, tenantB.id, listAuditEvents);

    expect(eventsA.every((event) => event.tenantId === tenantA.id)).toBe(true);
    expect(eventsA.some((event) => event.id === eventB.id)).toBe(false);
    expect(eventsB.map((event) => event.id)).toEqual([eventB.id]);
    await expect(
      withTenant(appPool, tenantB.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("serializa inserções concorrentes sem bifurcar a cadeia", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendFor(tenantA, establishmentA, `renave.concurrent.event-${index}`),
      ),
    );

    const events = await withTenant(appPool, tenantA.id, listAuditEvents);
    const concurrent = events.filter((event) =>
      event.action.startsWith("renave.concurrent."),
    );
    expect(concurrent).toHaveLength(20);
    expect(new Set(concurrent.map((event) => event.previousHash)).size).toBe(
      20,
    );
    await expect(
      withTenant(appPool, tenantA.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("mantém o hash estável quando o timezone da sessão muda", async () => {
    await withTenant(appPool, tenantA.id, async (client) => {
      await client.query("set local time zone 'UTC'");
      await appendAuditEvent(client, {
        action: "renave.timezone.checked",
        actorIp: "127.0.0.1",
        actorSubject: "operator:test",
        certificateThumbprintSha256: CERTIFICATE_HASH,
        cnpjConfirmed: establishmentA.cnpj,
        cnpjSent: establishmentA.cnpj,
        establishmentId: establishmentA.id,
        integratorCnpjConfirmed: "69418503000188",
        outcome: "succeeded",
        payloadReference: "worm://audit/timezone",
        requestSha256: HASH_A,
      });
    });
    await expect(
      withTenant(appPool, tenantA.id, async (client) => {
        await client.query("set local time zone 'America/Belem'");
        return verifyAuditChain(client);
      }),
    ).resolves.toBe(true);
  });

  it("recusa sucesso RENAVE sem evidências obrigatórias", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `insert into renave.audit_event (
             tenant_id, establishment_id, actor_subject, actor_ip, action, outcome
           ) values (renave.current_tenant_id(), $1, 'operator:test', '127.0.0.1',
                     'renave.invalid.succeeded', 'succeeded')`,
          [establishmentA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("recusa UPDATE e DELETE pelo papel da aplicação", async () => {
    const event = await appendFor(
      tenantA,
      establishmentA,
      "renave.append-only.checked",
    );
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "update renave.audit_event set outcome = 'rejected' where id = $1",
          [event.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query("delete from renave.audit_event where id = $1", [
          event.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("trigger append-only também bloqueia o próprio dono da tabela", async () => {
    const event = await appendFor(
      tenantA,
      establishmentA,
      "renave.owner-guard.checked",
    );
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query(
          "update renave.audit_event set outcome = 'rejected' where id = $1",
          [event.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(migratorPool, tenantA.id, (client) =>
        client.query("delete from renave.audit_event where id = $1", [
          event.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("detecta adulteração mesmo quando feita pelo administrador", async () => {
    const event = await appendFor(
      tenantA,
      establishmentA,
      "renave.tamper.checked",
    );
    try {
      await adminPool.query(
        "alter table renave.audit_event disable trigger audit_event_append_only",
      );
      await adminPool.query(
        "update renave.audit_event set event_hash = $2 where id = $1",
        [event.id, "f".repeat(64)],
      );
      await expect(
        withTenant(appPool, tenantA.id, verifyAuditChain),
      ).resolves.toBe(false);
    } finally {
      await adminPool.query(
        "update renave.audit_event set event_hash = $2 where id = $1",
        [event.id, event.eventHash],
      );
      await adminPool.query(
        "alter table renave.audit_event enable trigger audit_event_append_only",
      );
    }
    await expect(
      withTenant(appPool, tenantA.id, verifyAuditChain),
    ).resolves.toBe(true);
  });

  it("detecta exclusão administrativa do último evento", async () => {
    const event = await appendFor(
      tenantA,
      establishmentA,
      "renave.truncation.checked",
    );
    try {
      await adminPool.query(
        "alter table renave.audit_event disable trigger audit_event_append_only",
      );
      await adminPool.query("delete from renave.audit_event where id = $1", [
        event.id,
      ]);
    } finally {
      await adminPool.query(
        "alter table renave.audit_event enable trigger audit_event_append_only",
      );
    }
    await expect(
      withTenant(appPool, tenantA.id, verifyAuditChain),
    ).resolves.toBe(false);
  });
});
