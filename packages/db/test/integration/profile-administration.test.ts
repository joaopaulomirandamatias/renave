import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { grantTenantUserAccess } from "../../src/authorization.js";
import { computeCnpjCheckDigits } from "../../src/cnpj.js";
import {
  createEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  assertProfileProvisionerSession,
  assertProfileReaderSession,
  getAdminEstablishmentRenaveProfileStatus,
  getAdminOperatorRenaveProfileStatus,
  stageEstablishmentRenaveProfile,
  stageOperatorRenaveProfile,
  suspendEstablishmentRenaveProfile,
  suspendOperatorRenaveProfile,
  type KeyedDigestInput,
  type ProfileEnvelopeInput,
} from "../../src/renave-profile-administration.js";
import { createPool, withTenant } from "../../src/tenant-context.js";
import { provisionTenant, type Tenant } from "../../src/tenants.js";

const urls = inject("dbUrls");
const SUBJECT = "oidc|profile-admin-operator";

let appPool: Pool;
let adminPool: Pool;
let migratorPool: Pool;
let provisionerPool: Pool;
let readerPool: Pool;
let tenant: Tenant;
let establishment: Establishment;

function digest(label: string): Buffer {
  return createHash("sha256").update(label, "utf8").digest();
}

function keyed(label: string): KeyedDigestInput {
  return { digest: digest(label), keyId: "profile-admin-hmac-v1" };
}

function envelope(label: string, size: 128 | 512): ProfileEnvelopeInput {
  return {
    schemaVersion: 1,
    keyId: "profile-envelope-v1",
    nonce: digest(`${label}:nonce`).subarray(0, 12),
    authTag: digest(`${label}:tag`).subarray(0, 16),
    ciphertext: Buffer.alloc(size, label.charCodeAt(0)),
    aadSha256: digest(`${label}:aad`),
  };
}

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 2 });
  adminPool = createPool(urls.admin, { max: 1 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  provisionerPool = createPool(urls.profileProvisioner, { max: 4 });
  readerPool = createPool(urls.profileReader, { max: 4 });
  tenant = await provisionTenant(migratorPool, {
    displayName: "Profile administration",
    slug: "profile-administration",
  });
  const base = "941720150001";
  establishment = await withTenant(appPool, tenant.id, (client) =>
    createEstablishment(client, {
      cnpj: `${base}${computeCnpjCheckDigits(base)}`,
      tradeName: "Profile administration store",
    }),
  );
  await withTenant(migratorPool, tenant.id, (client) =>
    grantTenantUserAccess(client, SUBJECT, [
      {
        establishmentIds: [establishment.id],
        role: "renave_operator",
      },
    ]),
  );
});

afterAll(async () => {
  await Promise.all([
    appPool?.end(),
    adminPool?.end(),
    migratorPool?.end(),
    provisionerPool?.end(),
    readerPool?.end(),
  ]);
});

describe("RENAVE profile administration", () => {
  it("mantém papel mínimo sem acesso direto e valida atributos", async () => {
    await expect(
      assertProfileProvisionerSession(provisionerPool),
    ).resolves.toBeUndefined();
    await expect(
      assertProfileReaderSession(readerPool),
    ).resolves.toBeUndefined();
    await expect(assertProfileReaderSession(provisionerPool)).rejects.toThrow(
      "renave_profile_reader",
    );
    await expect(assertProfileProvisionerSession(readerPool)).rejects.toThrow(
      "renave_profile_provisioner",
    );
    await expect(
      provisionerPool.query("select * from renave.operator_identity_profile"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      provisionerPool.query(
        "select * from renave.profile_administration_ledger",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      readerPool.query("select * from renave.operator_identity_profile"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      readerPool.query(
        "select * from renave_admin.stage_operator_pending(null,null,null,null,null,null,null,null,null,null,null,null,null,null,null)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      provisionerPool.query(
        "select * from renave_admin.get_operator_status(null,null)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      readerPool.query("set role renave_profile_provisioner"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cria somente pending, serializa concorrência e faz replay exato", async () => {
    const input = {
      tenantId: tenant.id,
      subject: SUBJECT,
      profileId: randomUUID(),
      hmacKeyId: "cpf-hmac-v1",
      identityHmac: digest("operator:cpf"),
      envelope: envelope("operator", 128),
      assertion: keyed("operator:assertion"),
      changedBy: keyed("operator:actor"),
    };
    const results = await Promise.all([
      stageOperatorRenaveProfile(provisionerPool, input),
      stageOperatorRenaveProfile(provisionerPool, input),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results.every(({ status }) => status === "pending")).toBe(true);
    await expect(
      stageOperatorRenaveProfile(provisionerPool, {
        ...input,
        hmacKeyId: "cpf-hmac-v2",
      }),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      getAdminOperatorRenaveProfileStatus(readerPool, tenant.id, SUBJECT),
    ).resolves.toMatchObject({
      profileId: input.profileId,
      status: "pending",
      version: 1,
    });

    const counts = await withTenant(migratorPool, tenant.id, async (client) => {
      const result = await client.query<{
        history: string;
        ledger: string;
        verified: string;
      }>(
        `select
           (select count(*) from renave.operator_identity_profile_history) as history,
           (select count(*) from renave.profile_administration_ledger) as ledger,
           (select count(*) from renave.operator_identity_profile where status='verified') as verified`,
      );
      return result.rows[0];
    });
    expect(counts).toEqual({ history: "1", ledger: "1", verified: "0" });
  });

  it("mantém ACLs exclusivas e detecta membership entre papéis", async () => {
    const privileges = await migratorPool.query<{
      provisioner_can_status: boolean;
      reader_can_stage: boolean;
      reader_can_status: boolean;
    }>(`select
      has_function_privilege('renave_profile_provisioner',
        'renave_admin.get_operator_status(uuid,text)','EXECUTE') as provisioner_can_status,
      has_function_privilege('renave_profile_reader',
        'renave_admin.stage_operator_pending(uuid,text,uuid,text,bytea,integer,text,bytea,bytea,bytea,bytea,bytea,text,bytea,text)','EXECUTE') as reader_can_stage,
      has_function_privilege('renave_profile_reader',
        'renave_admin.get_operator_status(uuid,text)','EXECUTE') as reader_can_status`);
    expect(privileges.rows[0]).toEqual({
      provisioner_can_status: false,
      reader_can_stage: false,
      reader_can_status: true,
    });

    await adminPool.query(
      "grant renave_profile_reader to renave_profile_provisioner",
    );
    try {
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
      await expect(
        getAdminOperatorRenaveProfileStatus(readerPool, tenant.id, SUBJECT),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await adminPool.query(
        "revoke renave_profile_reader from renave_profile_provisioner",
      );
    }
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });

  it("nega CREATE e TEMP de banco e bloqueia os dois guards", async () => {
    const database = (
      await adminPool.query<{ quoted: string }>(
        "select quote_ident(current_database()) as quoted",
      )
    ).rows[0]!.quoted;
    const cases = [
      { privilege: "create", role: "renave_profile_reader" },
      { privilege: "temporary", role: "renave_profile_provisioner" },
    ] as const;

    for (const item of cases) {
      await adminPool.query(
        `grant ${item.privilege} on database ${database} to ${item.role}`,
      );
      try {
        await expect(
          appPool.query("select renave_runtime.api_contract_ready() as ready"),
        ).resolves.toMatchObject({ rows: [{ ready: false }] });
        await expect(
          getAdminOperatorRenaveProfileStatus(readerPool, tenant.id, SUBJECT),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          stageOperatorRenaveProfile(provisionerPool, {
            tenantId: tenant.id,
            subject: SUBJECT,
            profileId: randomUUID(),
            hmacKeyId: "cpf-hmac-v1",
            identityHmac: digest(`db-privilege:${item.privilege}`),
            envelope: envelope(`db-${item.privilege}`, 128),
            assertion: keyed(`db-privilege:${item.privilege}:assertion`),
            changedBy: keyed(`db-privilege:${item.privilege}:actor`),
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await adminPool.query(
          `revoke ${item.privilege} on database ${database} from ${item.role}`,
        );
      }
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
    }
  });

  it("suspende com versão esperada, replay exato e conflito sem escrita", async () => {
    const before = await getAdminOperatorRenaveProfileStatus(
      readerPool,
      tenant.id,
      SUBJECT,
    );
    const input = {
      tenantId: tenant.id,
      subject: SUBJECT,
      expectedVersion: before!.version,
      reason: keyed("operator:suspension:reason"),
      request: keyed("operator:suspension:request"),
      changedBy: keyed("operator:suspension:actor"),
    };
    await expect(
      suspendOperatorRenaveProfile(provisionerPool, input),
    ).resolves.toMatchObject({
      status: "suspended",
      version: 2,
      replayed: false,
    });
    await expect(
      suspendOperatorRenaveProfile(provisionerPool, input),
    ).resolves.toMatchObject({
      version: 2,
      replayed: true,
    });
    await expect(
      suspendOperatorRenaveProfile(provisionerPool, {
        ...input,
        request: keyed("operator:suspension:different-request"),
      }),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      suspendOperatorRenaveProfile(provisionerPool, {
        ...input,
        request: {
          ...input.request,
          keyId: "profile-admin-hmac-v2",
        },
      }),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("administra estabelecimento sem promover e preserva ledger/history", async () => {
    const stageInput = {
      tenantId: tenant.id,
      establishmentId: establishment.id,
      profileId: randomUUID(),
      hmacKeyId: "email-hmac-v1",
      emailHmac: digest("establishment:email"),
      envelope: envelope("establishment", 512),
      assertion: keyed("establishment:assertion"),
      changedBy: keyed("establishment:actor"),
    };
    const staged = await stageEstablishmentRenaveProfile(
      provisionerPool,
      stageInput,
    );
    expect(staged).toMatchObject({
      status: "pending",
      version: 1,
      replayed: false,
    });
    await expect(
      stageEstablishmentRenaveProfile(provisionerPool, {
        ...stageInput,
        hmacKeyId: "email-hmac-v2",
      }),
    ).rejects.toMatchObject({ code: "23000" });
    const suspension = {
      tenantId: tenant.id,
      establishmentId: establishment.id,
      expectedVersion: 1,
      reason: keyed("establishment:suspension:reason"),
      request: keyed("establishment:suspension:request"),
      changedBy: keyed("establishment:suspension:actor"),
    };
    await expect(
      suspendEstablishmentRenaveProfile(provisionerPool, suspension),
    ).resolves.toMatchObject({ status: "suspended", version: 2 });
    await expect(
      suspendEstablishmentRenaveProfile(provisionerPool, {
        ...suspension,
        request: {
          ...suspension.request,
          keyId: "profile-admin-hmac-v2",
        },
      }),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      getAdminEstablishmentRenaveProfileStatus(
        readerPool,
        tenant.id,
        establishment.id,
      ),
    ).resolves.toMatchObject({ status: "suspended", version: 2 });

    await expect(
      withTenant(migratorPool, tenant.id, (client) =>
        client.query(
          "update renave.profile_administration_ledger set status='revoked'",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      migratorPool.query("truncate renave.profile_administration_ledger"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("nega PUBLIC por default e rejeita função administrativa fora da allowlist", async () => {
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });

    await migratorPool.query(`
      alter default privileges for role renave_migrator
        in schema renave_admin grant execute on functions to public
    `);
    try {
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await migratorPool.query(`
        alter default privileges for role renave_migrator
          in schema renave_admin revoke execute on functions from public
      `);
    }
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });

    await migratorPool.query(`
      create function renave_admin.unexpected_probe()
      returns boolean language sql stable set search_path=pg_catalog
      as 'select true'
    `);
    try {
      const privilege = await migratorPool.query<{ allowed: boolean }>(
        `select has_function_privilege(
           'renave_profile_provisioner',
           'renave_admin.unexpected_probe()','EXECUTE'
         ) as allowed`,
      );
      expect(privilege.rows[0]?.allowed).toBe(false);
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });

      await migratorPool.query(
        "grant execute on function renave_admin.unexpected_probe() to renave_profile_provisioner",
      );
      await expect(
        appPool.query("select renave_runtime.api_contract_ready() as ready"),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
    } finally {
      await migratorPool.query("drop function renave_admin.unexpected_probe()");
    }
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });

  it("bloqueia stage, suspend e status no mesmo statement sob drift", async () => {
    await migratorPool.query(
      "grant execute on function renave_admin.assert_profile_provisioner() to renave_profile_provisioner",
    );
    try {
      const blockedCalls = [
        () =>
          getAdminOperatorRenaveProfileStatus(readerPool, tenant.id, SUBJECT),
        () =>
          getAdminEstablishmentRenaveProfileStatus(
            readerPool,
            tenant.id,
            establishment.id,
          ),
        () =>
          stageOperatorRenaveProfile(provisionerPool, {
            tenantId: tenant.id,
            subject: SUBJECT,
            profileId: randomUUID(),
            hmacKeyId: "cpf-hmac-v1",
            identityHmac: digest("drift:operator"),
            envelope: envelope("drift-operator", 128),
            assertion: keyed("drift:operator:assertion"),
            changedBy: keyed("drift:operator:actor"),
          }),
        () =>
          stageEstablishmentRenaveProfile(provisionerPool, {
            tenantId: tenant.id,
            establishmentId: establishment.id,
            profileId: randomUUID(),
            hmacKeyId: "email-hmac-v1",
            emailHmac: digest("drift:establishment"),
            envelope: envelope("drift-establishment", 512),
            assertion: keyed("drift:establishment:assertion"),
            changedBy: keyed("drift:establishment:actor"),
          }),
        () =>
          suspendOperatorRenaveProfile(provisionerPool, {
            tenantId: tenant.id,
            subject: SUBJECT,
            expectedVersion: 2,
            reason: keyed("drift:operator:reason"),
            request: keyed("drift:operator:request"),
            changedBy: keyed("drift:operator:actor"),
          }),
        () =>
          suspendEstablishmentRenaveProfile(provisionerPool, {
            tenantId: tenant.id,
            establishmentId: establishment.id,
            expectedVersion: 2,
            reason: keyed("drift:establishment:reason"),
            request: keyed("drift:establishment:request"),
            changedBy: keyed("drift:establishment:actor"),
          }),
      ];
      for (const call of blockedCalls) {
        await expect(call()).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await migratorPool.query(
        "revoke execute on function renave_admin.assert_profile_provisioner() from renave_profile_provisioner",
      );
    }
    await expect(
      appPool.query("select renave_runtime.api_contract_ready() as ready"),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
  });
});
