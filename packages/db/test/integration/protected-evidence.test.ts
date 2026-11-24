import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import { createEstablishment } from "../../src/establishments.js";
import { APP_ROLE } from "../../src/config.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const CNPJ_A = "11222333000181";
const CNPJ_B = "12ABC34501DE35";
const ACTION = "renave.vehicle.eligibility.read";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

let appPool: Pool;
let adminPool: Pool;
let migratorPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let establishmentAId: string;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  adminPool = createPool(urls.admin, { max: 2 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  tenantA = await provisionTenant(migratorPool, {
    slug: "evidence-a",
    displayName: "Evidence A",
  });
  tenantB = await provisionTenant(migratorPool, {
    slug: "evidence-b",
    displayName: "Evidence B",
  });
  establishmentAId = await withTenant(
    appPool,
    tenantA.id,
    async (client) =>
      (
        await createEstablishment(client, {
          cnpj: CNPJ_A,
          tradeName: "Loja Evidência A",
        })
      ).id,
  );
  await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: CNPJ_B,
      tradeName: "Loja Evidência B",
    }),
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), adminPool?.end(), migratorPool?.end()]);
});

describe("protected_evidence", () => {
  it("aceita a ação de estoque e recusa ação não autorizada", async () => {
    const stockEvidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withTenant(appPool, tenantA.id, (client) =>
      client.query(
        `insert into renave.protected_evidence (
           id, tenant_id, establishment_id, action,
           request_key_id, request_nonce, request_auth_tag, request_ciphertext
         ) values ($1, $2, $3, 'renave.stock.read', 'key-1', $4, $5, $6)`,
        [
          stockEvidenceId,
          tenantA.id,
          establishmentAId,
          Buffer.alloc(12, 1),
          Buffer.alloc(16, 2),
          Buffer.from([3]),
        ],
      ),
    );

    await expect(
      withTenant(appPool, tenantA.id, async (client) => {
        const { rows } = await client.query(
          "select action, status from renave.protected_evidence where id = $1",
          [stockEvidenceId],
        );
        return rows;
      }),
    ).resolves.toEqual([{ action: "renave.stock.read", status: "pending" }]);

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `insert into renave.protected_evidence (
             id, tenant_id, establishment_id, action,
             request_key_id, request_nonce, request_auth_tag, request_ciphertext
           ) values ($1, $2, $3, 'renave.stock.export', 'key-1', $4, $5, $6)`,
          [
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tenantA.id,
            establishmentAId,
            Buffer.alloc(12, 1),
            Buffer.alloc(16, 2),
            Buffer.from([3]),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("isola por tenant e permite somente a transição pendente para concluída", async () => {
    await withTenant(appPool, tenantA.id, async (client) => {
      await client.query(
        `insert into renave.protected_evidence (
           id, tenant_id, establishment_id, action,
           request_key_id, request_nonce, request_auth_tag, request_ciphertext
         ) values ($1, $2, $3, $4, 'key-1', $5, $6, $7)`,
        [
          EVIDENCE_ID,
          tenantA.id,
          establishmentAId,
          ACTION,
          Buffer.alloc(12, 1),
          Buffer.alloc(16, 2),
          Buffer.from([3, 4, 5]),
        ],
      );
    });

    await expect(
      withTenant(appPool, tenantB.id, async (client) => {
        const { rows } = await client.query(
          "select id from renave.protected_evidence where id = $1",
          [EVIDENCE_ID],
        );
        return rows;
      }),
    ).resolves.toEqual([]);

    await withTenant(appPool, tenantA.id, async (client) => {
      const finalized = await client.query(
        `update renave.protected_evidence
            set status = 'completed', response_key_id = 'key-1',
                response_nonce = $2, response_auth_tag = $3,
                response_ciphertext = $4
          where id = $1
        returning status`,
        [
          EVIDENCE_ID,
          Buffer.alloc(12, 6),
          Buffer.alloc(16, 7),
          Buffer.from([8, 9]),
        ],
      );
      expect(finalized.rows[0]).toMatchObject({ status: "completed" });
    });
    const finalizedMetadata = await adminPool.query<{ finalized_at: Date }>(
      "select finalized_at from renave.protected_evidence where id = $1",
      [EVIDENCE_ID],
    );
    expect(finalizedMetadata.rows[0]?.finalized_at).toBeInstanceOf(Date);
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "update renave.protected_evidence set status = 'failed', failure_code = 'LATE_FAILURE' where id = $1",
          [EVIDENCE_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query("delete from renave.protected_evidence where id = $1", [
          EVIDENCE_ID,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("não revela evidência sem tenant ativo", async () => {
    const { rows } = await appPool.query(
      "select id from renave.protected_evidence where id = $1",
      [EVIDENCE_ID],
    );
    expect(rows).toEqual([]);
    await expect(
      appPool.query(
        `insert into renave.protected_evidence (
           id, tenant_id, establishment_id, action,
           request_key_id, request_nonce, request_auth_tag, request_ciphertext
         ) values ($1, $2, $3, $4, 'key-1', $5, $6, $7)`,
        [
          "44444444-4444-4444-8444-444444444444",
          tenantA.id,
          establishmentAId,
          ACTION,
          Buffer.alloc(12, 1),
          Buffer.alloc(16, 2),
          Buffer.from([3]),
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("recusa adulteração do request e resolve finalizações concorrentes uma única vez", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    await withTenant(appPool, tenantA.id, (client) =>
      client.query(
        `insert into renave.protected_evidence (
           id, tenant_id, establishment_id, action,
           request_key_id, request_nonce, request_auth_tag, request_ciphertext
         ) values ($1, $2, $3, $4, 'key-1', $5, $6, $7)`,
        [
          id,
          tenantA.id,
          establishmentAId,
          ACTION,
          Buffer.alloc(12, 1),
          Buffer.alloc(16, 2),
          Buffer.from([3]),
        ],
      ),
    );

    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "update renave.protected_evidence set request_ciphertext = $2 where id = $1",
          [id, Buffer.from([99])],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const outcomes = await Promise.allSettled([
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `update renave.protected_evidence
              set status = 'completed', response_key_id = 'key-1',
                  response_nonce = $2, response_auth_tag = $3,
                  response_ciphertext = $4
            where id = $1 and status = 'pending' returning id`,
          [id, Buffer.alloc(12, 4), Buffer.alloc(16, 5), Buffer.from([6])],
        ),
      ),
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `update renave.protected_evidence
              set status = 'failed', failure_code = 'CONCURRENT_FAILURE'
            where id = $1 and status = 'pending' returning id`,
          [id],
        ),
      ),
    ]);
    const updatedRows = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value.rowCount ?? 0] : [],
    );
    expect(updatedRows.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("concede SELECT somente nas colunas de binding, sem DELETE ou TRUNCATE", async () => {
    const { rows } = await adminPool.query<{ column_name: string }>(
      `select column_name
         from information_schema.column_privileges
        where grantee = $1 and table_schema = 'renave'
          and table_name = 'protected_evidence'
          and privilege_type = 'SELECT'
        order by column_name`,
      [APP_ROLE],
    );
    expect(rows.map(({ column_name }) => column_name)).toEqual([
      "action",
      "establishment_id",
      "id",
      "status",
      "tenant_id",
    ]);
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          "select request_ciphertext from renave.protected_evidence where id = $1",
          [EVIDENCE_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query("truncate renave.protected_evidence"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
