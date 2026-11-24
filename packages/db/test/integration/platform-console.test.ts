import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { createEstablishment } from "../../src/establishments.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { transitionCredentialLink } from "../../src/credential-links.js";

const urls = inject("dbUrls");
const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

let app: Pool;
let admin: Pool;
let migrator: Pool;
let reader: Pool;
let provisioner: Pool;
let tenant: Tenant;

beforeAll(async () => {
  app = createPool(urls.app, { max: 1 });
  admin = createPool(urls.admin, { max: 1 });
  migrator = createPool(urls.migrator, { max: 1 });
  reader = createPool(urls.platformReader, { max: 1 });
  provisioner = createPool(urls.platformProvisioner, { max: 1 });
  tenant = await provisionTenant(migrator, {
    displayName: "Console Global A",
    slug: `platform-console-${randomUUID().slice(0, 8)}`,
  });
});

afterAll(async () => {
  await Promise.all([
    app?.end(),
    admin?.end(),
    migrator?.end(),
    reader?.end(),
    provisioner?.end(),
  ]);
});

describe.sequential("console global da integradora", () => {
  it("mantém fingerprint esperado", async () => {
    const result = await migrator.query<{ fingerprint: string }>(
      "select renave_runtime.platform_console_catalog_fingerprint_v0064() as fingerprint",
    );
    expect(result.rows[0]?.fingerprint).toBe(
      "a5c46b031ea30cd7671348eff6243f74491c33d19bdc053a79c1b987cba39012",
    );
    await expect(
      app.query<{ ready: boolean }>(
        "select renave_runtime.api_contract_ready() as ready",
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });

  it("mantém papéis separados e nenhuma leitura direta", async () => {
    await expect(
      reader.query("select * from renave_platform.credential_link_projection"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      provisioner.query("select * from renave_platform.operator_grant"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      reader.query(
        `select renave_platform.grant_operator(
          $1,clock_timestamp(),clock_timestamp()+interval '1 hour',
          $2,$3,$4,$5)`,
        [
          digest("forbidden-reader"),
          digest("ticket"),
          digest("admin"),
          "127.0.0.1",
          digest("trace"),
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      provisioner.query(
        `select * from renave_platform.list_credential_link_queue(
          $1,$2,$3,$4,null,null,null,null,100)`,
        [
          digest("forbidden-provisioner"),
          digest("forbidden-reason"),
          "127.0.0.1",
          digest("trace"),
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const columns = await migrator.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='renave_platform'
         and table_name='credential_link_projection'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("cnpj");
  });

  it("fecha o contrato diante de EXECUTE cruzado específico", async () => {
    const signature = `renave_platform.grant_operator(
      bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)`;
    await migrator.query(`grant execute on function ${signature}
      to renave_platform_reader`);
    try {
      await expect(
        app.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await migrator.query(`revoke execute on function ${signature}
        from renave_platform_reader`);
    }
    await expect(
      app.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });

  it("projeta somente dados mínimos e aplica grant e revogação imediata", async () => {
    const establishment = await withTenant(app, tenant.id, (client) =>
      createEstablishment(client, {
        cnpj: "11.222.333/0001-81",
        tradeName: "Loja Global A",
      }),
    );
    await withTenant(app, tenant.id, (client) =>
      transitionCredentialLink(client, {
        changedBySubject: "oidc|tenant-admin",
        establishmentId: establishment.id,
        source: "manual",
        status: "pending",
      }),
    );
    const actor = digest("operator-hmac-output");
    const changedBy = digest("security-admin-hmac-output");
    const grantTicket = digest("ticket-grant");
    const trace = digest("trace-grant");
    const readReason = digest("reason-read");
    const deniedReason = digest("reason-denied");

    await provisioner.query(
      `select renave_platform.grant_operator(
        $1,clock_timestamp(),clock_timestamp()+interval '1 hour',$2,$3,$4,$5)`,
      [actor, grantTicket, changedBy, "127.0.0.1", trace],
    );
    const listed = await reader.query<{
      authorized: boolean;
      establishment_id: string | null;
      link_status: string | null;
      trade_name: string | null;
    }>(
      `select * from renave_platform.list_credential_link_queue(
        $1,$2,$3,$4,null,null,null,null,100)`,
      [actor, readReason, "127.0.0.1", digest("trace-read")],
    );
    expect(listed.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorized: true,
          establishment_id: establishment.id,
          link_status: "pending",
          trade_name: "Loja Global A",
        }),
      ]),
    );
    expect(JSON.stringify(listed.rows)).not.toContain(establishment.cnpj);

    await provisioner.query(
      "select renave_platform.revoke_operator($1,$2,$3,$4,$5)",
      [
        actor,
        digest("ticket-revoke"),
        changedBy,
        "127.0.0.1",
        digest("trace-revoke"),
      ],
    );
    await expect(
      reader.query(
        `select * from renave_platform.list_credential_link_queue(
          $1,$2,$3,$4,null,null,null,null,100)`,
        [actor, deniedReason, "127.0.0.1", digest("trace-denied")],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ authorized: false })],
    });

    const regrantTicket = digest("ticket-regrant");
    await provisioner.query(
      `select renave_platform.grant_operator(
        $1,clock_timestamp(),clock_timestamp()+interval '2 hours',$2,$3,$4,$5)`,
      [actor, regrantTicket, changedBy, "127.0.0.1", digest("trace-regrant")],
    );
    const revisions = await migrator.query<{
      action: string;
      decision_ticket_digest: Buffer;
      expires_at: Date;
      status: string;
      valid_from: Date;
    }>(
      `select action,status,valid_from,expires_at,decision_ticket_digest
       from renave_platform.operator_grant_revision
       where actor_digest=$1 order by revision`,
      [actor],
    );
    expect(
      revisions.rows.map(({ action, status }) => ({ action, status })),
    ).toEqual([
      { action: "grant", status: "active" },
      { action: "revoke", status: "revoked" },
      { action: "grant", status: "active" },
    ]);
    expect(revisions.rows[0]?.decision_ticket_digest).toEqual(grantTicket);
    expect(revisions.rows[1]?.decision_ticket_digest).toEqual(
      digest("ticket-revoke"),
    );
    expect(revisions.rows[2]?.decision_ticket_digest).toEqual(regrantTicket);
    for (const revision of revisions.rows) {
      expect(revision.expires_at.getTime()).toBeGreaterThan(
        revision.valid_from.getTime(),
      );
    }
    const readAudits = await migrator.query<{
      outcome: string;
      reason_ticket_digest: Buffer;
    }>(
      `select outcome,reason_ticket_digest from renave_platform.audit_event
       where trace_digest in ($1,$2) order by sequence`,
      [digest("trace-read"), digest("trace-denied")],
    );
    expect(readAudits.rows).toEqual([
      { outcome: "succeeded", reason_ticket_digest: readReason },
      { outcome: "rejected", reason_ticket_digest: deniedReason },
    ]);
    await expect(
      migrator.query(
        `update renave_platform.operator_grant_revision
         set status='revoked' where actor_digest=$1`,
        [actor],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      migrator.query("truncate renave_platform.operator_grant_revision"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("recusa parâmetros inválidos antes de mutação ou auditoria", async () => {
    const before = await migrator.query<{
      audit_count: string;
      grant_count: string;
      revision_count: string;
    }>(
      `select
        (select count(*)::text from renave_platform.audit_event) audit_count,
        (select count(*)::text from renave_platform.operator_grant) grant_count,
        (select count(*)::text from renave_platform.operator_grant_revision)
          revision_count`,
    );
    await expect(
      provisioner.query(
        `select renave_platform.grant_operator(
          $1,clock_timestamp(),clock_timestamp()+interval '1 hour',$2,$3,$4,$5)`,
        [
          Buffer.alloc(31),
          digest("invalid-ticket"),
          digest("invalid-admin"),
          "127.0.0.1",
          digest("invalid-trace"),
        ],
      ),
    ).rejects.toMatchObject({ code: "22023" });
    const actor = digest("invalid-read-actor");
    await provisioner.query(
      `select renave_platform.grant_operator(
        $1,clock_timestamp(),clock_timestamp()+interval '1 hour',$2,$3,$4,$5)`,
      [
        actor,
        digest("valid-ticket"),
        digest("valid-admin"),
        "127.0.0.1",
        digest("valid-trace"),
      ],
    );
    const afterValidGrant = await migrator.query<{ audit_count: string }>(
      "select count(*)::text audit_count from renave_platform.audit_event",
    );
    await expect(
      reader.query(
        `select * from renave_platform.list_credential_link_queue(
          $1,$2,$3,$4,null,null,null,null,100)`,
        [actor, Buffer.alloc(31), "127.0.0.1", digest("invalid-read-trace")],
      ),
    ).rejects.toMatchObject({ code: "22023" });
    const after = await migrator.query<{
      audit_count: string;
      grant_count: string;
      revision_count: string;
    }>(
      `select
        (select count(*)::text from renave_platform.audit_event) audit_count,
        (select count(*)::text from renave_platform.operator_grant) grant_count,
        (select count(*)::text from renave_platform.operator_grant_revision)
          revision_count`,
    );
    expect(Number(after.rows[0]!.grant_count)).toBe(
      Number(before.rows[0]!.grant_count) + 1,
    );
    expect(Number(after.rows[0]!.revision_count)).toBe(
      Number(before.rows[0]!.revision_count) + 1,
    );
    expect(after.rows[0]!.audit_count).toBe(
      afterValidGrant.rows[0]!.audit_count,
    );
  });

  it("filtra suspensos e inativos e pagina por keyset com pendentes antigos primeiro", async () => {
    const activeTenant = await provisionTenant(migrator, {
      displayName: "Console Global Filtro",
      slug: `platform-filter-${randomUUID().slice(0, 8)}`,
    });
    const suspendedTenant = await provisionTenant(migrator, {
      displayName: "Console Global Suspenso",
      slug: `platform-suspended-${randomUUID().slice(0, 8)}`,
    });
    const [older, newer, inactive] = await withTenant(
      app,
      activeTenant.id,
      async (client) => {
        const first = await createEstablishment(client, {
          cnpj: "11222333000181",
          tradeName: "Pendente Antigo",
        });
        const second = await createEstablishment(client, {
          cnpj: "12ABC34501DE35",
          tradeName: "Pendente Novo",
        });
        const third = await createEstablishment(client, {
          cnpj: "00000000000191",
          tradeName: "Estabelecimento Inativo",
        });
        return [first, second, third] as const;
      },
    );
    const suspended = await withTenant(app, suspendedTenant.id, (client) =>
      createEstablishment(client, {
        cnpj: "11222333000181",
        tradeName: "Tenant Suspenso",
      }),
    );
    for (const [targetTenant, establishment] of [
      [activeTenant, older],
      [activeTenant, newer],
      [activeTenant, inactive],
      [suspendedTenant, suspended],
    ] as const) {
      await withTenant(app, targetTenant.id, (client) =>
        transitionCredentialLink(client, {
          changedBySubject: "oidc|platform-fixture",
          establishmentId: establishment.id,
          source: "manual",
          status: "pending",
        }),
      );
    }
    await withTenant(migrator, activeTenant.id, async (client) => {
      await client.query(
        "update renave.credential_link set updated_at=$2 where establishment_id=$1",
        [older.id, "2026-01-01T00:00:00.000Z"],
      );
      await client.query(
        "update renave.credential_link set updated_at=$2 where establishment_id=$1",
        [newer.id, "2026-01-02T00:00:00.000Z"],
      );
      await client.query(
        "update renave.establishment set status='inactive' where id=$1",
        [inactive.id],
      );
    });
    await withTenant(migrator, suspendedTenant.id, (client) =>
      client.query("update renave.tenant set status='suspended' where id=$1", [
        suspendedTenant.id,
      ]),
    );

    const actor = digest("platform-filter-actor");
    await provisioner.query(
      `select renave_platform.grant_operator(
        $1,clock_timestamp(),clock_timestamp()+interval '1 hour',$2,$3,$4,$5)`,
      [
        actor,
        digest("platform-filter-ticket"),
        digest("platform-filter-admin"),
        "127.0.0.1",
        digest("platform-filter-grant"),
      ],
    );
    const listed = await reader.query<{
      authorized: boolean;
      cursor_priority: number | null;
      establishment_id: string | null;
      link_updated_at: Date | null;
      truncated: boolean;
    }>(
      `select * from renave_platform.list_credential_link_queue(
        $1,$2,$3,$4,null,null,null,null,500)`,
      [
        actor,
        digest("platform-filter-reason"),
        "127.0.0.1",
        digest("platform-filter-read"),
      ],
    );
    const ownOrder = listed.rows
      .map((row) => row.establishment_id)
      .filter((id) => id === older.id || id === newer.id);
    expect(ownOrder).toEqual([older.id, newer.id]);
    expect(listed.rows.map((row) => row.establishment_id)).not.toContain(
      inactive.id,
    );
    expect(listed.rows.map((row) => row.establishment_id)).not.toContain(
      suspended.id,
    );

    const olderRow = listed.rows.find(
      (row) => row.establishment_id === older.id,
    );
    expect(olderRow).toBeDefined();
    const afterOlder = await reader.query<{ establishment_id: string | null }>(
      `select * from renave_platform.list_credential_link_queue(
        $1,$2,$3,$4,$5,$6,$7,$8,500)`,
      [
        actor,
        digest("platform-filter-keyset-reason"),
        "127.0.0.1",
        digest("platform-filter-keyset"),
        olderRow!.cursor_priority,
        olderRow!.link_updated_at,
        activeTenant.id,
        older.id,
      ],
    );
    expect(afterOlder.rows.map((row) => row.establishment_id)).not.toContain(
      older.id,
    );
    expect(afterOlder.rows.map((row) => row.establishment_id)).toContain(
      newer.id,
    );

    const limited = await reader.query<{ truncated: boolean }>(
      `select * from renave_platform.list_credential_link_queue(
        $1,$2,$3,$4,null,null,null,null,1)`,
      [
        actor,
        digest("platform-filter-limited-reason"),
        "127.0.0.1",
        digest("platform-filter-limited"),
      ],
    );
    expect(limited.rows).toHaveLength(1);
    expect(limited.rows[0]?.truncated).toBe(true);
  });

  it("encadeia auditoria append-only e falha fechado se ela não puder persistir", async () => {
    const chainBreaks = await migrator.query<{
      action: string;
      sequence: string;
    }>(
      `select sequence::text,action from (
         select sequence,action,previous_hash,
           lag(event_hash) over (order by sequence) prior_hash
         from renave_platform.audit_event
       ) chain where prior_hash is not null and previous_hash<>prior_hash
       order by sequence`,
    );
    expect(chainBreaks.rows).toEqual([]);
    const firstEvent = await migrator.query<{ sequence: string }>(
      "select sequence::text from renave_platform.audit_event order by sequence limit 1",
    );
    expect(firstEvent.rows).toHaveLength(1);
    await expect(
      migrator.query(
        "update renave_platform.audit_event set outcome='rejected' where sequence=$1",
        [firstEvent.rows[0]!.sequence],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      migrator.query("truncate renave_platform.audit_event"),
    ).rejects.toMatchObject({ code: "42501" });

    const actor = digest("platform-fail-closed-actor");
    await provisioner.query(
      `select renave_platform.grant_operator(
        $1,clock_timestamp(),clock_timestamp()+interval '1 hour',$2,$3,$4,$5)`,
      [
        actor,
        digest("platform-fail-closed-ticket"),
        digest("platform-fail-closed-admin"),
        "127.0.0.1",
        digest("platform-fail-closed-grant"),
      ],
    );
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query("delete from renave_platform.audit_chain_head");
      await client.query(
        "set local session authorization renave_platform_reader",
      );
      await expect(
        client.query(
          `select * from renave_platform.list_credential_link_queue(
            $1,$2,$3,$4,null,null,null,null,100)`,
          [
            actor,
            digest("platform-fail-closed-reason"),
            "127.0.0.1",
            digest("platform-fail-closed-read"),
          ],
        ),
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
