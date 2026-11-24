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
    expect(first.at(-11)?.version).toBe("0024_runtime_contract_stock_query");
    expect(first.at(-10)?.version).toBe("0025_operation_outbox");
    expect(first.at(-9)?.version).toBe(
      "0026_runtime_contract_operation_outbox",
    );
    expect(first.at(-8)?.version).toBe("0027_operation_outbox_claim_lease");
    expect(first.at(-7)?.version).toBe("0028_runtime_contract_operation_claim");
    expect(first.at(-6)?.version).toBe("0029_operation_begin_dispatch");
    expect(first.at(-5)?.version).toBe("0030_runtime_contract_begin_dispatch");
    expect(first.at(-4)?.version).toBe("0031_operation_recover_expired_send");
    expect(first.at(-3)?.version).toBe(
      "0032_runtime_contract_expired_send_recovery",
    );
    expect(first.at(-2)?.version).toBe("0033_operation_complete_send");
    expect(first.at(-1)?.version).toBe("0034_runtime_contract_send_completion");
    expect(first.map((m) => m.checksum)).toEqual(second.map((m) => m.checksum));
    expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.at(-1)?.sql).toContain(first.at(-2)?.checksum);
    expect(first.at(-1)?.sql).toContain(first.at(-3)?.checksum);
    expect(first.at(-3)?.sql).toContain(
      "'0031_operation_recover_expired_send'",
    );
    expect(first.at(-8)?.sql).toContain("for update of outbox skip locked");
    expect(first.at(-6)?.sql).toContain("for update");
    expect(first.at(-6)?.sql.match(/for share/gu)).toHaveLength(2);
    expect(first.at(-6)?.sql).toContain(
      "outbox -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-6)?.sql).toContain("DISPATCH_BEGUN");
    expect(first.at(-4)?.sql).toContain(
      "SEND outbox -> RECONCILE outbox existente -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-4)?.sql).toContain("SEND_LEASE_EXPIRED");
    expect(first.at(-4)?.sql).not.toContain("operation.*");
    expect(first.at(-4)?.sql).not.toMatch(
      /request_(ciphertext|nonce|auth_tag|sha256|key_id)/u,
    );
    expect(first.at(-3)?.sql).toContain("begin_dispatch_contract_ready_v0030");
    expect(first.at(-2)?.sql).toContain(
      "SEND -> RECONCILE -> operação -> tenant -> estabelecimento",
    );
    expect(first.at(-2)?.sql).toContain("RENAVE_MUTATION_OUTCOME_UNKNOWN");
    expect(first.at(-2)?.sql).not.toContain("operation.*");
    expect(first.at(-2)?.sql).not.toMatch(
      /request_(ciphertext|nonce|auth_tag|sha256|key_id)/u,
    );
    expect(first.at(-1)?.sql).toContain(
      "expired_send_recovery_contract_ready_v0032",
    );
    expect(first.at(-1)?.sql).toContain("pg_catalog.sha256");
    expect(first.at(-8)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-6)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-4)?.sql).not.toMatch(/grant\s+execute/iu);
    expect(first.at(-2)?.sql).not.toMatch(/grant\s+execute/iu);
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
