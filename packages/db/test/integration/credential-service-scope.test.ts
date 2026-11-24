import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import { transitionCredentialLink } from "../../src/credential-links.js";
import {
  getCredentialServiceScope,
  transitionCredentialServiceScope,
  transitionEstablishmentRegulatoryJurisdiction,
} from "../../src/credential-service-scopes.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  createOrReplayHeldLocalOperation,
  OperationCredentialLinkNotEnabledError,
  type CreateHeldLocalOperationInput,
} from "../../src/operations.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";
import { operationProjectionFields } from "../helpers/operation-projection.js";
import {
  type OperationAuthorizationSnapshot,
  seedVerifiedOperationPrincipals,
} from "../helpers/operation-authorization.js";

const urls = inject("dbUrls");
let admin: Pool;
let app: Pool;
let migrator: Pool;
let provisioner: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let storeA: Establishment;
let storeB: Establishment;
let storeRace: Establishment;
const authorizationByEstablishment = new Map<
  string,
  OperationAuthorizationSnapshot
>();

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

function cnpj(index: number): string {
  const base = `86240719${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

function decision(establishmentId: string, suffix: string) {
  return {
    changedByDigest: digest(`actor:${suffix}`),
    decisionTicketDigest: digest(`ticket:${suffix}`),
    establishmentId,
    evidenceDigest: digest(`evidence:${suffix}`),
  };
}

function operationInput(
  establishmentId: string,
  label: string,
): CreateHeldLocalOperationInput {
  const authorization = authorizationByEstablishment.get(establishmentId);
  if (!authorization)
    throw new Error("missing operation authorization fixture");
  return {
    ...operationProjectionFields(`scope:${label}`),
    ...authorization,
    actorSubjectHash: digest(`actor:${label}`),
    correlationId: randomUUID(),
    establishmentId,
    idempotencyKeyDigest: digest(`idempotency:${label}`),
    kind: "USED_STOCK_ENTRY",
    mutationFamily: "STOCK_ENTRY",
    requestAuthTag: Buffer.alloc(16, 1),
    requestCiphertext: Buffer.from(`cipher:${label}`),
    requestKeyId: "scope-test-v1",
    requestNonce: Buffer.alloc(12, 2),
    requestSchemaVersion: 1,
    requestSha256: digest(`request:${label}`),
    vehicleKeyDigest: digest(`vehicle:${label}`),
  };
}

beforeAll(async () => {
  admin = createPool(urls.admin, { max: 2 });
  app = createPool(urls.app, { max: 4 });
  migrator = createPool(urls.migrator, { max: 3 });
  provisioner = createPool(urls.credentialScopeProvisioner, { max: 3 });
  tenantA = await provisionTenant(migrator, {
    displayName: "Credential Scope A",
    slug: "credential-scope-a",
  });
  tenantB = await provisionTenant(migrator, {
    displayName: "Credential Scope B",
    slug: "credential-scope-b",
  });
  storeA = await withTenant(app, tenantA.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(1), tradeName: "Scope A" }),
  );
  storeB = await withTenant(app, tenantB.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(2), tradeName: "Scope B" }),
  );
  storeRace = await withTenant(app, tenantA.id, (client) =>
    createEstablishment(client, { cnpj: cnpj(3), tradeName: "Scope Race" }),
  );
  for (const [establishment, label] of [
    [storeA, "scope-a"],
    [storeRace, "scope-race"],
  ] as const) {
    const snapshot = await withTenant(migrator, tenantA.id, (client) =>
      seedVerifiedOperationPrincipals(client, {
        establishmentId: establishment.id,
        label,
      }),
    );
    authorizationByEstablishment.set(establishment.id, snapshot);
  }
  await withTenant(app, tenantA.id, async (client) => {
    const common = {
      changedBySubject: "oidc|scope-test",
      establishmentId: storeA.id,
      source: "manual" as const,
    };
    await transitionCredentialLink(client, { ...common, status: "pending" });
    await transitionCredentialLink(client, { ...common, status: "confirmed" });
    await transitionCredentialLink(client, { ...common, status: "enabled" });
    const raceCommon = { ...common, establishmentId: storeRace.id };
    await transitionCredentialLink(client, {
      ...raceCommon,
      status: "pending",
    });
    await transitionCredentialLink(client, {
      ...raceCommon,
      status: "confirmed",
    });
    await transitionCredentialLink(client, {
      ...raceCommon,
      status: "enabled",
    });
  });
  const now = Date.now();
  await withTenant(provisioner, tenantA.id, async (client) => {
    const common = decision(storeRace.id, "race-seed");
    await transitionEstablishmentRegulatoryJurisdiction(client, {
      ...common,
      expiresAt: new Date(now + 3_600_000),
      jurisdictionUf: "PA",
      status: "verified",
      validFrom: new Date(now - 60_000),
    });
    await transitionCredentialServiceScope(client, {
      ...common,
      expiresAt: new Date(now + 3_600_000),
      jurisdictionUf: "PA",
      serviceNature: "establishment",
      status: "enabled",
      validFrom: new Date(now - 60_000),
    });
  });
});

afterAll(async () => {
  await Promise.all([
    admin.end(),
    app.end(),
    migrator.end(),
    provisioner.end(),
  ]);
});

describe("credential service scope", () => {
  it("começa vazio, isola tenants e não transforma preflight em autorização", async () => {
    await expect(
      withTenant(app, tenantA.id, (client) =>
        getCredentialServiceScope(client, storeA.id, "establishment"),
      ),
    ).resolves.toBeNull();
    await expect(
      withTenant(app, tenantB.id, (client) =>
        getCredentialServiceScope(client, storeA.id, "establishment"),
      ),
    ).resolves.toBeNull();
  });

  it("exige natureza, UF e validade exatas e falha com duas UFs", async () => {
    const now = Date.now();
    await withTenant(provisioner, tenantA.id, async (client) => {
      await transitionEstablishmentRegulatoryJurisdiction(client, {
        ...decision(storeA.id, "pa"),
        expiresAt: new Date(now + 3_600_000),
        jurisdictionUf: "PA",
        status: "verified",
        validFrom: new Date(now - 60_000),
      });
      await transitionCredentialServiceScope(client, {
        ...decision(storeA.id, "ite"),
        expiresAt: new Date(now + 3_600_000),
        jurisdictionUf: "PA",
        serviceNature: "ite",
        status: "enabled",
        validFrom: new Date(now - 60_000),
      });
      await transitionCredentialServiceScope(client, {
        ...decision(storeA.id, "expired"),
        expiresAt: new Date(now - 60_000),
        jurisdictionUf: "PA",
        serviceNature: "establishment",
        status: "enabled",
        validFrom: new Date(now - 3_600_000),
      });
    });
    await expect(
      withTenant(app, tenantA.id, (client) =>
        getCredentialServiceScope(client, storeA.id, "ite"),
      ),
    ).resolves.toMatchObject({
      jurisdictionUf: "PA",
      status: "enabled",
    });
    await expect(
      withTenant(app, tenantA.id, (client) =>
        getCredentialServiceScope(client, storeA.id, "establishment"),
      ),
    ).resolves.toBeNull();

    await withTenant(provisioner, tenantA.id, (client) =>
      transitionEstablishmentRegulatoryJurisdiction(client, {
        ...decision(storeA.id, "sp"),
        expiresAt: new Date(now + 3_600_000),
        jurisdictionUf: "SP",
        status: "verified",
        validFrom: new Date(now - 60_000),
      }),
    );
    await expect(
      withTenant(app, tenantA.id, (client) =>
        getCredentialServiceScope(client, storeA.id, "ite"),
      ),
    ).resolves.toBeNull();
  });

  it("nega operação sem escopo e não grava operação, outbox ou evidência", async () => {
    const before = await withTenant(migrator, tenantA.id, (client) =>
      client.query(`select
        (select count(*)::int from renave.operation) operations,
        (select count(*)::int from renave.operation_outbox) outbox,
        (select count(*)::int from renave.protected_evidence) evidence`),
    );
    await expect(
      withTenant(app, tenantA.id, (client) =>
        createOrReplayHeldLocalOperation(
          client,
          operationInput(storeA.id, "deny"),
        ),
      ),
    ).rejects.toBeInstanceOf(OperationCredentialLinkNotEnabledError);
    const after = await withTenant(migrator, tenantA.id, (client) =>
      client.query(`select
        (select count(*)::int from renave.operation) operations,
        (select count(*)::int from renave.operation_outbox) outbox,
        (select count(*)::int from renave.protected_evidence) evidence`),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("fecha DML, histórico e transições para o runtime", async () => {
    await expect(
      app.query("select * from renave.credential_service_scope_history"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("update renave.credential_service_scope set status='enabled'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query(
        "select renave_admin.transition_credential_service_scope(null,null,null,null,null,null,null,null,null)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("mantém histórico append-only e recusa UF desconhecida", async () => {
    await expect(
      withTenant(provisioner, tenantA.id, (client) =>
        client.query(
          `select renave_admin.transition_establishment_regulatory_jurisdiction(
        $1,'XX','verified',clock_timestamp(),clock_timestamp()+interval '1 hour',
        $2,$3,$4)`,
          [storeA.id, digest("x"), digest("y"), digest("z")],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenant(migrator, tenantA.id, (client) =>
        client.query(
          "delete from renave.establishment_regulatory_jurisdiction_history",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("serializa suspensão concorrente com criação e nega sem escrita", async () => {
    const offline = await provisioner.connect();
    try {
      await offline.query("begin");
      await offline.query(
        "select pg_catalog.set_config('renave.tenant_id',$1,true)",
        [tenantA.id],
      );
      await offline.query(
        `select renave_admin.transition_credential_service_scope(
          $1,'establishment','PA','suspended',clock_timestamp(),
          clock_timestamp()+interval '1 hour',$2,$3,$4)`,
        [storeRace.id, digest("race-e"), digest("race-t"), digest("race-a")],
      );
      const creation = withTenant(app, tenantA.id, (client) =>
        createOrReplayHeldLocalOperation(
          client,
          operationInput(storeRace.id, "race-suspend"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const waiting = await admin.query<{ count: number }>(
        `select count(*)::int count from pg_stat_activity
          where wait_event_type='Lock' and query like
            '%create_held_local_operation%'`,
      );
      expect(waiting.rows[0]?.count).toBeGreaterThan(0);
      await offline.query("commit");
      await expect(creation).rejects.toBeInstanceOf(
        OperationCredentialLinkNotEnabledError,
      );
      const counts = await withTenant(migrator, tenantA.id, (client) =>
        client.query<{ evidence: number; operations: number; outbox: number }>(
          `select
            (select count(*)::int from renave.operation
              where establishment_id=$1) operations,
            (select count(*)::int from renave.operation_outbox outbox
              join renave.operation operation on operation.id=outbox.operation_id
              where operation.establishment_id=$1) outbox,
            (select count(*)::int from renave.protected_evidence
              where establishment_id=$1) evidence`,
          [storeRace.id],
        ),
      );
      expect(counts.rows[0]).toEqual({ evidence: 0, operations: 0, outbox: 0 });
    } finally {
      await offline.query("rollback").catch(() => undefined);
      offline.release();
    }
  });

  it("contrato detecta policy aberta, grant extra, BYPASSRLS e checksum", async () => {
    await expect(
      admin.query("select renave_runtime.api_contract_ready() ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
    const probes = [
      "alter policy credential_service_scope_isolation on renave.credential_service_scope using (true) with check (true)",
      "create policy credential_service_scope_extra on renave.credential_service_scope for select using (true)",
      "alter table renave.credential_service_scope_history disable trigger credential_service_scope_history_append_only",
      "grant execute on function renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea) to renave_app",
      "alter role renave_credential_scope_provisioner bypassrls",
      "update renave.schema_migrations set checksum=repeat('0',64) where version='0070_credential_service_scope'",
    ];
    for (const sql of probes) {
      const client = await admin.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        const result = await client.query<{ ready: boolean }>(
          "select renave_runtime.api_contract_ready() ready",
        );
        expect(result.rows[0]?.ready, sql).toBe(false);
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
  });
});
