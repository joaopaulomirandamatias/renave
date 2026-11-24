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
    expect(first.at(-3)?.version).toBe("0024_runtime_contract_stock_query");
    expect(first.at(-2)?.version).toBe("0025_operation_outbox");
    expect(first.at(-1)?.version).toBe(
      "0026_runtime_contract_operation_outbox",
    );
    expect(first.map((m) => m.checksum)).toEqual(second.map((m) => m.checksum));
    expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.at(-1)?.sql).toContain(first.at(-2)?.checksum);
    expect(first.at(-1)?.sql).toContain("'0025_operation_outbox'");
    expect(first.at(-1)?.sql).toContain("pg_catalog.pg_get_expr");
    expect(first.at(-1)?.sql).toContain("pg_catalog.pg_get_indexdef");
    expect(first.at(-1)?.sql).toContain("objects.relpersistence = 'p'");
    expect(first.at(-1)?.sql).toContain("triggers.tgqual is null");
    expect(first.at(-1)?.sql).toContain("triggers.tgattr = ''::int2vector");
    expect(first.at(-1)?.sql).toContain("pg_catalog.sha256");
    expect(first.at(-1)?.sql).toContain("pg_catalog.has_any_column_privilege");
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
