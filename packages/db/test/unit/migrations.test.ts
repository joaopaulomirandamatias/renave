import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMigrations, MigrationError } from "../../src/migrate.js";

describe("loadMigrations", () => {
  it("lê as migrations versionadas em ordem, com checksum estável", async () => {
    const first = await loadMigrations();
    const second = await loadMigrations();
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]?.version).toBe("0001_tenant_establishment");
    expect(first.at(-21)?.version).toBe("0024_runtime_contract_stock_query");
    expect(first.at(-20)?.version).toBe("0025_operation_outbox");
    expect(first.at(-19)?.version).toBe(
      "0026_runtime_contract_operation_outbox",
    );
    expect(first.at(-18)?.version).toBe("0027_operation_outbox_claim_lease");
    expect(first.at(-17)?.version).toBe(
      "0028_runtime_contract_operation_claim",
    );
    expect(first.at(-16)?.version).toBe("0029_operation_begin_dispatch");
    expect(first.at(-15)?.version).toBe("0030_runtime_contract_begin_dispatch");
    expect(first.at(-14)?.version).toBe("0031_operation_recover_expired_send");
    expect(first.at(-13)?.version).toBe(
      "0032_runtime_contract_expired_send_recovery",
    );
    expect(first.at(-12)?.version).toBe("0033_operation_complete_send");
    expect(first.at(-11)?.version).toBe(
      "0034_runtime_contract_send_completion",
    );
    expect(first.at(-10)?.version).toBe("0035_operation_reconciliation_lease");
    expect(first.at(-9)?.version).toBe(
      "0036_runtime_contract_reconciliation_lease",
    );
    expect(first.at(-8)?.version).toBe(
      "0037_operation_reconciliation_projection",
    );
    expect(first.at(-7)?.version).toBe(
      "0038_runtime_contract_operation_reconciliation_projection",
    );
    expect(first.at(-6)?.version).toBe(
      "0039_operation_reconciliation_completion",
    );
    expect(first.at(-5)?.version).toBe(
      "0040_runtime_contract_operation_reconciliation_completion",
    );
    expect(first.map((m) => m.checksum)).toEqual(second.map((m) => m.checksum));
    expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.at(-5)?.sql).toContain(first.at(-6)?.checksum);
    expect(first.at(-5)?.sql).toContain(first.at(-7)?.checksum);
    expect(first.at(-13)?.sql).toContain(
      "'0031_operation_recover_expired_send'",
    );
    expect(first.at(-18)?.sql).toContain("for update of outbox skip locked");
    expect(first.at(-16)?.sql).toContain("for update");
    expect(first.at(-16)?.sql.match(/for share/gu)).toHaveLength(2);
    expect(first.at(-16)?.sql).toContain(
      "outbox -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-16)?.sql).toContain("DISPATCH_BEGUN");
    expect(first.at(-14)?.sql).toContain(
      "SEND outbox -> RECONCILE outbox existente -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-14)?.sql).toContain("SEND_LEASE_EXPIRED");
    expect(first.at(-14)?.sql).not.toContain("operation.*");
    expect(first.at(-14)?.sql).not.toMatch(
      /request_(ciphertext|nonce|auth_tag|sha256|key_id)/u,
    );
    expect(first.at(-13)?.sql).toContain("begin_dispatch_contract_ready_v0030");
    expect(first.at(-12)?.sql).toContain(
      "SEND -> RECONCILE -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-12)?.sql).toContain("RENAVE_MUTATION_OUTCOME_UNKNOWN");
    expect(first.at(-12)?.sql).not.toContain("operation.*");
    expect(first.at(-12)?.sql).not.toMatch(
      /request_(ciphertext|nonce|auth_tag|sha256|key_id)/u,
    );
    expect(first.at(-11)?.sql).toContain(
      "expired_send_recovery_contract_ready_v0032",
    );
    expect(first.at(-9)?.sql).toContain("pg_catalog.sha256");
    expect(first.at(-10)?.sql).toContain(
      "RECONCILE -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-10)?.sql).toContain("for update of reconcile skip locked");
    expect(first.at(-10)?.sql).not.toMatch(
      /request_(ciphertext|nonce|auth_tag|sha256|key_id)|operation\.\*/u,
    );
    expect(first.at(-10)?.sql).not.toMatch(/create\s+(unique\s+)?index/iu);
    expect(first.at(-9)?.sql).toContain("send_completion_contract_ready_v0034");
    expect(first.at(-18)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-16)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-14)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-12)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-10)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-8)?.sql).toContain("backfill legado indisponível");
    const projectionTable = first
      .at(-8)
      ?.sql.match(
        /create table renave\.operation_reconciliation_projection \([\s\S]*?\n\);/u,
      )?.[0];
    expect(projectionTable).not.toContain("source_request_sha256");
    expect(first.at(-8)?.sql).not.toContain("operation.*");
    expect(first.at(-8)?.sql).toContain("for share");
    expect(first.at(-7)?.sql).toContain(
      "reconciliation_lease_contract_ready_v0036",
    );
    expect(first.at(-6)?.sql).toContain("establishment_cnpj text");
    expect(first.at(-6)?.sql).toContain("renave_operation_worker");
    expect(first.at(-6)?.sql).not.toMatch(/request_ciphertext|operation\.\*/u);
    expect(first.at(-5)?.sql).toContain("operation_worker_contract_ready");
    expect(first.at(-4)?.version).toBe(
      "0041_reconciliation_worker_capabilities",
    );
    expect(first.at(-4)?.sql).toContain(
      "list_pending_operation_reconciliation_projection_key_ids",
    );
    expect(first.at(-4)?.sql).not.toMatch(
      /grant\s+[^;]*on\s+(table|sequence)/iu,
    );
    expect(first.at(-3)?.version).toBe(
      "0042_runtime_contract_reconciliation_worker_capabilities",
    );
    expect(first.at(-3)?.sql).toContain(first.at(-4)?.checksum);
    expect(first.at(-3)?.sql).toContain("select pg_catalog.count(*) = 10");
    expect(first.at(-2)?.version).toBe(
      "0043_reconciliation_projection_preflight",
    );
    expect(first.at(-2)?.sql).toContain(
      "distinct on (projection.projection_key_id)",
    );
    expect(first.at(-2)?.sql).not.toMatch(/create\s+(unique\s+)?index/iu);
    expect(first.at(-2)?.sql).not.toMatch(
      /lease_owner|lease_token|establishment_cnpj/iu,
    );
    expect(first.at(-1)?.version).toBe(
      "0044_runtime_contract_reconciliation_projection_preflight",
    );
    expect(first.at(-1)?.sql).toContain(first.at(-2)?.checksum);
    expect(first.at(-1)?.sql).toContain(first.at(-3)?.checksum);
    expect(first.at(-1)?.sql).toContain("select pg_catalog.count(*) = 11");
  });

  it("recusa lacuna na sequência e nome fora do padrão", async () => {
    const gap = await mkdtemp(join(tmpdir(), "renave-mig-"));
    await writeFile(join(gap, "0002_x.sql"), "select 1;");
    await expect(loadMigrations(gap)).rejects.toThrow(MigrationError);

    const bad = await mkdtemp(join(tmpdir(), "renave-mig-"));
    await writeFile(join(bad, "init.sql"), "select 1;");
    await expect(loadMigrations(bad)).rejects.toThrow(MigrationError);
  });

  it("nenhuma migration contém papéis com senha ou segredos", async () => {
    for (const migration of await loadMigrations()) {
      expect(migration.sql).not.toMatch(/create\s+role|password/i);
    }
  });
});
