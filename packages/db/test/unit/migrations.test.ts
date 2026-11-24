import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMigrations, MigrationError } from "../../src/migrate.js";

describe("loadMigrations", () => {
  it("lê as migrations versionadas em ordem, com checksum estável", async () => {
    const loaded = await loadMigrations();
    const platformReaderProbeIndex = loaded.findIndex(
      ({ version }) => version === "0065_platform_reader_runtime_probe",
    );
    expect(platformReaderProbeIndex).toBeGreaterThan(-1);
    const allWithPlatformReaderProbe = loaded.slice(
      0,
      platformReaderProbeIndex + 1,
    );
    const allWithPlatformConsole = allWithPlatformReaderProbe.slice(0, -1);
    const allWithVehicleLookup = allWithPlatformConsole.slice(0, -2);
    const all = allWithVehicleLookup.slice(0, -2);
    const first = all.slice(0, -16);
    const second = (await loadMigrations()).slice(0, first.length);
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
    expect(all.at(-16)?.version).toBe("0045_identity_authentication_assurance");
    expect(all.at(-16)?.sql).toContain("authentication_context");
    expect(all.at(-16)?.sql).toContain(
      "mfa_verified_at_login boolean not null default false",
    );
    expect(all.at(-16)?.sql).toContain("authentication_context ~ '^[!-~]+$'");
    expect(all.at(-15)?.version).toBe(
      "0046_runtime_contract_identity_assurance",
    );
    expect(all.at(-15)?.sql).toContain(all.at(-16)?.checksum);
    expect(all.at(-15)?.sql).toContain(
      "reconciliation_projection_preflight_contract_ready_v0044",
    );
    expect(all.at(-14)?.version).toBe("0047_tenant_administration");
    expect(all.at(-14)?.sql).toContain("lock_current_tenant_admin");
    expect(all.at(-14)?.sql).toContain("admin_mutation_idempotency");
    expect(all.at(-13)?.version).toBe(
      "0048_runtime_contract_tenant_administration",
    );
    expect(all.at(-13)?.sql).toContain(all.at(-14)?.checksum);
    expect(all.at(-13)?.sql).toContain(
      "tenant_administration_catalog_fingerprint_v0048",
    );
    expect(all.at(-12)?.version).toBe("0049_held_local_operation");
    expect(all.at(-12)?.sql).toContain("'HELD_LOCAL'");
    expect(all.at(-12)?.sql).toContain(
      "create function renave.create_held_local_operation",
    );
    expect(all.at(-12)?.sql).toContain(
      "revoke all on function renave.create_operation_with_outbox",
    );
    expect(all.at(-12)?.sql).not.toContain(
      "insert into renave.operation_outbox",
    );
    expect(all.at(-11)?.version).toBe(
      "0050_runtime_contract_held_local_operation",
    );
    expect(all.at(-11)?.sql).toContain(all.at(-12)?.checksum);
    expect(all.at(-11)?.sql).toContain(
      "held_local_operation_catalog_fingerprint_v0050",
    );
    expect(all.at(-10)?.version).toBe("0051_verified_renave_profiles");
    expect(all.at(-10)?.sql).toContain("operator_identity_profile");
    expect(all.at(-10)?.sql).toContain("establishment_renave_profile");
    expect(all.at(-10)?.sql).toContain("reindexar");
    expect(all.at(-10)?.sql).toContain("aliases");
    expect(all.at(-10)?.sql).not.toContain("resolve_verified_renave_profiles");
    expect(all.at(-9)?.version).toBe(
      "0052_runtime_contract_verified_renave_profiles",
    );
    expect(all.at(-9)?.sql).toContain(all.at(-10)?.checksum);
    expect(all.at(-9)?.sql).toContain(
      "renave_profiles_catalog_fingerprint_v0052",
    );
    expect(all.at(-8)?.version).toBe(
      "0053_verified_renave_principal_resolution",
    );
    expect(all.at(-8)?.sql).toContain("resolve_verified_renave_principals");
    expect(all.at(-8)?.sql).toContain("pg_advisory_xact_lock(");
    expect(all.at(-8)?.sql).not.toContain("pg_advisory_xact_lock_shared");
    expect(all.at(-8)!.sql.indexOf("250025")).toBeLessThan(
      all.at(-8)!.sql.indexOf("170017"),
    );
    expect(all.at(-8)?.sql).toContain(
      "resolve_verified_renave_principals(text, uuid, bytea)",
    );
    expect(all.at(-8)?.sql).not.toMatch(
      /insert into renave\.(operation|operation_outbox)/u,
    );
    expect(all.at(-7)?.version).toBe(
      "0054_runtime_contract_verified_renave_principal_resolution",
    );
    expect(all.at(-7)?.sql).toContain(all.at(-8)?.checksum);
    expect(all.at(-7)?.sql).toContain(
      "renave_principal_resolution_catalog_fingerprint_v0054",
    );
    expect(all.at(-6)?.version).toBe("0055_stock_entry_rate_limit");
    expect(all.at(-6)?.sql).toContain("consume_stock_entry_rate_limit");
    expect(all.at(-6)?.sql).toContain(
      "matches_stock_entry_runtime_key_generation",
    );
    expect(all.at(-6)?.sql).toContain("stock_entry_runtime_key_generation");
    expect(all.at(-6)?.sql).toContain(
      "stock_entry_runtime_key_generation_reject_update_delete",
    );
    expect(all.at(-6)?.sql).toContain(
      "stock_entry_runtime_key_generation_reject_truncate",
    );
    expect(all.at(-6)?.sql).toContain("for share");
    expect(all.at(-6)?.sql).not.toMatch(
      /insert into renave_runtime\.stock_entry_runtime_key_generation/iu,
    );
    expect(all.at(-6)?.sql).toContain("global -> tenant -> actor");
    expect(all.at(-6)!.sql.indexOf("for update;")).toBeLessThan(
      all.at(-6)!.sql.indexOf("item.scope = 'global'"),
    );
    expect(all.at(-6)!.sql.indexOf("item.scope = 'global'")).toBeLessThan(
      all.at(-6)!.sql.indexOf("limit 100"),
    );
    expect(all.at(-6)?.sql).toContain("limit 100");
    expect(all.at(-6)?.sql).not.toMatch(/grant\s+[^;]*on\s+(table|sequence)/iu);
    expect(all.at(-5)?.version).toBe(
      "0056_runtime_contract_stock_entry_rate_limit",
    );
    expect(all.at(-5)?.sql).toContain(all.at(-6)?.checksum);
    expect(all.at(-5)?.sql).toContain(
      "stock_entry_rate_limit_catalog_fingerprint_v0056",
    );
    expect(all.at(-4)?.version).toBe("0057_renave_profile_administration");
    expect(all.at(-4)?.sql).toContain("profile_administration_ledger");
    expect(all.at(-4)?.sql).toContain("stage_operator_pending");
    expect(all.at(-4)?.sql).not.toMatch(/function\s+[^\n]*(verify|promote)/iu);
    expect(all.at(-3)?.version).toBe(
      "0058_runtime_contract_profile_administration",
    );
    expect(all.at(-3)?.sql).toContain(all.at(-4)?.checksum);
    expect(all.at(-3)?.sql).toContain(
      "profile_administration_catalog_fingerprint_v0058",
    );
    expect(all.at(-2)?.version).toBe("0059_renave_profile_reader");
    expect(all.at(-2)?.sql).toContain("assert_profile_reader");
    expect(all.at(-2)?.sql).toContain("renave_profile_reader");
    expect(all.at(-1)?.version).toBe("0060_runtime_contract_profile_reader");
    expect(all.at(-1)?.sql).toContain(all.at(-2)?.checksum);
    expect(all.at(-1)?.sql).toContain(all.at(-4)?.checksum);
    expect(all.at(-1)?.sql).toContain(
      "profile_reader_catalog_fingerprint_v0060",
    );
    expect(allWithVehicleLookup.at(-2)?.version).toBe(
      "0061_vehicle_lookup_evidence",
    );
    expect(allWithVehicleLookup.at(-2)?.sql).toContain("'renave.vehicle.read'");
    expect(allWithVehicleLookup.at(-2)?.sql).not.toMatch(
      /create\s+role|alter\s+role|password\s+|provider\s*=|secret\s*=/iu,
    );
    expect(allWithVehicleLookup.at(-1)?.version).toBe(
      "0062_runtime_contract_vehicle_lookup",
    );
    expect(allWithVehicleLookup.at(-1)?.sql).toContain(
      allWithVehicleLookup.at(-2)?.checksum,
    );
    expect(allWithVehicleLookup.at(-1)?.sql).toContain(
      "vehicle_lookup_catalog_fingerprint_v0062",
    );
    expect(allWithPlatformConsole.at(-2)?.version).toBe(
      "0063_platform_operator_console",
    );
    expect(allWithPlatformConsole.at(-2)?.sql).toContain(
      "renave_platform.list_credential_link_queue",
    );
    expect(allWithPlatformConsole.at(-2)?.sql).not.toMatch(
      /grant\s+usage\s+on\s+schema\s+renave_platform/iu,
    );
    expect(allWithPlatformConsole.at(-2)?.sql).not.toMatch(
      /grant\s+execute\s+on\s+function\s+renave_platform/iu,
    );
    expect(allWithPlatformConsole.at(-1)?.version).toBe(
      "0064_runtime_contract_platform_operator_console",
    );
    expect(allWithPlatformConsole.at(-1)?.sql).toContain(
      allWithPlatformConsole.at(-2)?.checksum,
    );
    expect(allWithPlatformConsole.at(-1)?.sql).toContain(
      "platform_console_catalog_fingerprint_v0064",
    );
    expect(allWithPlatformConsole.at(-1)?.sql).toContain(
      "grant usage on schema renave_platform",
    );
    expect(allWithPlatformConsole.at(-1)?.sql).toContain(
      "grant execute on function renave_platform.grant_operator",
    );
    expect(allWithPlatformReaderProbe.at(-1)?.version).toBe(
      "0065_platform_reader_runtime_probe",
    );
    expect(allWithPlatformReaderProbe.at(-1)?.sql).toContain(
      "platform_reader_contract_ready",
    );
    expect(allWithPlatformReaderProbe.at(-1)?.sql).toContain(
      "session_user = 'renave_platform_reader'",
    );
    expect(allWithPlatformReaderProbe.at(-1)?.sql).toContain(
      "grant usage on schema renave_runtime to renave_platform_reader",
    );
    expect(loaded.at(-6)?.version).toBe("0066_identity_issuer_recent_mfa");
    expect(loaded.at(-6)?.sql).toContain("mfa_authenticated_at_ms");
    expect(loaded.at(-6)?.sql).toContain("add column issuer text");
    expect(loaded.at(-5)?.version).toBe(
      "0067_runtime_contract_identity_recent_mfa",
    );
    expect(loaded.at(-5)?.sql).toContain(loaded.at(-6)?.checksum);
    expect(loaded.at(-5)?.sql).toContain(
      allWithPlatformReaderProbe.at(-1)?.checksum,
    );
    expect(loaded.at(-5)?.sql).toContain(
      "identity_recent_mfa_catalog_fingerprint_v0067",
    );
    expect(loaded.at(-4)?.version).toBe("0068_platform_console_rate_limit");
    expect(loaded.at(-4)?.sql).toContain("acquire_platform_console_permit");
    expect(loaded.at(-4)?.sql).toContain(
      "platform_rate_catalog_fingerprint_v0068",
    );
    expect(loaded.at(-3)?.version).toBe(
      "0069_runtime_contract_platform_console_rate_limit",
    );
    expect(loaded.at(-3)?.sql).toContain(loaded.at(-4)?.checksum);
    expect(loaded.at(-3)?.sql).toContain("platform_rate_contract_ready_v0068");
    expect(loaded.at(-2)?.version).toBe("0070_credential_service_scope");
    expect(loaded.at(-2)?.sql).toContain(
      "establishment_regulatory_jurisdiction",
    );
    expect(loaded.at(-1)?.version).toBe(
      "0071_runtime_contract_credential_service_scope",
    );
    expect(loaded.at(-1)?.sql).toContain(loaded.at(-2)?.checksum);
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
