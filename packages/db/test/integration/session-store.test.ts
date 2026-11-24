import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";

import {
  APP_ROLE,
  IDENTITY_APP_ROLE,
  MIGRATOR_ROLE,
} from "../../src/config.js";
import {
  IdentitySessionStoreInputError,
  PostgresIdentitySessionStore,
} from "../../src/session-store.js";
import { createPool } from "../../src/tenant-context.js";

const urls = inject("dbUrls");
const NOW = 1_800_000_000_000;
type AttemptFixture = Parameters<
  PostgresIdentitySessionStore["saveLoginAttempt"]
>[1];
type SessionFixture = Parameters<
  PostgresIdentitySessionStore["saveSession"]
>[1];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function attempt(overrides: Partial<AttemptFixture> = {}): AttemptFixture {
  return {
    bindingHash: hash("binding-secret"),
    codeVerifier: "v".repeat(86),
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    nonceHash: hash("nonce"),
    returnTo: "/painel?origem=login",
    ...overrides,
  };
}

function session(overrides: Partial<SessionFixture> = {}): SessionFixture {
  return {
    absoluteExpiresAt: NOW + 43_200_000,
    createdAt: NOW,
    email: "operador@example.invalid",
    idleExpiresAt: NOW + 1_800_000,
    lastSeenAt: NOW,
    mfaVerifiedAtLogin: false,
    name: "Operador de Teste",
    roles: ["renave_operator"],
    subject: "oidc|session-store-test",
    ...overrides,
  };
}

let appPool: Pool;
let identityPool: Pool;
let adminPool: Pool;
let store: PostgresIdentitySessionStore;

beforeAll(() => {
  appPool = createPool(urls.app, { max: 8 });
  identityPool = createPool(urls.identity, { max: 8 });
  adminPool = createPool(urls.admin, { max: 2 });
  store = new PostgresIdentitySessionStore(identityPool);
});

afterAll(async () => {
  await Promise.all([appPool?.end(), identityPool?.end(), adminPool?.end()]);
});

describe("PostgresIdentitySessionStore", () => {
  it("consome a tentativa atomicamente uma única vez sob concorrência", async () => {
    const key = hash("state-concorrente");
    const expected = attempt();
    await store.saveLoginAttempt(key, expected);

    const consumed = await Promise.all(
      Array.from({ length: 24 }, () => store.consumeLoginAttempt(key, NOW + 1)),
    );
    const successful = consumed.filter((value) => value !== undefined);

    expect(successful).toEqual([expected]);
    await expect(
      store.consumeLoginAttempt(key, NOW + 2),
    ).resolves.toBeUndefined();
  });

  it("remove tentativa expirada sem jamais devolvê-la", async () => {
    const key = hash("state-expirado");
    await store.saveLoginAttempt(
      key,
      attempt({ createdAt: NOW - 1_000, expiresAt: NOW }),
    );

    await expect(store.consumeLoginAttempt(key, NOW)).resolves.toBeUndefined();
    const { rows } = await adminPool.query<{ count: number }>(
      `select count(*)::int as count
         from renave_identity.login_attempt where key_hash = $1`,
      [key],
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("persiste sessão, toca o prazo ocioso sem ultrapassar o absoluto e encerra idempotentemente", async () => {
    const key = hash("session-persistente");
    const expected = session();
    await store.saveSession(key, expected);

    await expect(store.getSession(key, NOW + 1)).resolves.toEqual(expected);
    await store.touchSession(key, NOW + 60_000, NOW + 1_860_000);
    await expect(store.getSession(key, NOW + 60_001)).resolves.toMatchObject({
      idleExpiresAt: NOW + 1_860_000,
      lastSeenAt: NOW + 60_000,
      subject: expected.subject,
    });

    // Uma extensão acima do teto absoluto é ignorada, não quebra nem amplia.
    await store.touchSession(
      key,
      NOW + 120_000,
      expected.absoluteExpiresAt + 1,
    );
    await expect(store.getSession(key, NOW + 120_001)).resolves.toMatchObject({
      idleExpiresAt: NOW + 1_860_000,
      lastSeenAt: NOW + 60_000,
    });

    await store.deleteSession(key);
    await store.deleteSession(key);
    await expect(store.getSession(key, NOW + 120_002)).resolves.toBeUndefined();
  });

  it("preserva somente o contexto de autenticação normalizado e mantém sessão legada sem garantia", async () => {
    const assuredKey = hash("session-mfa-assurance");
    const assured = session({
      authenticationContext: "urn:example:assurance:mfa",
      mfaVerifiedAtLogin: true,
    });
    await store.saveSession(assuredKey, assured);
    await expect(store.getSession(assuredKey, NOW + 1)).resolves.toEqual(
      assured,
    );

    const baselineKey = hash("session-baseline-assurance");
    const baseline = session();
    await adminPool.query(
      `insert into renave_identity.auth_session (
         key_hash, subject, display_name, email, roles,
         created_at_ms, last_seen_at_ms,
         idle_expires_at_ms, absolute_expires_at_ms
       ) values ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
      [
        baselineKey,
        baseline.subject,
        baseline.name,
        baseline.email,
        [...baseline.roles],
        baseline.createdAt,
        baseline.idleExpiresAt,
        baseline.absoluteExpiresAt,
      ],
    );
    await expect(store.getSession(baselineKey, NOW + 1)).resolves.toEqual(
      baseline,
    );

    const { rows } = await adminPool.query<{
      authentication_context: string | null;
      key_hash: string;
      mfa_verified_at_login: boolean;
    }>(
      `select key_hash, authentication_context, mfa_verified_at_login
         from renave_identity.auth_session
        where key_hash = any ($1::text[])
        order by key_hash`,
      [[assuredKey, baselineKey]],
    );
    expect(rows).toEqual(
      [
        {
          authentication_context: "urn:example:assurance:mfa",
          key_hash: assuredKey,
          mfa_verified_at_login: true,
        },
        {
          authentication_context: null,
          key_hash: baselineKey,
          mfa_verified_at_login: false,
        },
      ].sort((left, right) => left.key_hash.localeCompare(right.key_hash)),
    );
  });

  it("touch não ressuscita sessão expirada nem perde corrida com logout", async () => {
    const expiredKey = hash("session-expirada");
    await store.saveSession(
      expiredKey,
      session({
        absoluteExpiresAt: NOW + 10_000,
        idleExpiresAt: NOW + 1_000,
      }),
    );
    await store.touchSession(expiredKey, NOW + 1_000, NOW + 5_000);
    await expect(
      store.getSession(expiredKey, NOW + 1_000),
    ).resolves.toBeUndefined();

    const raceKey = hash("session-logout-race");
    await store.saveSession(raceKey, session());
    await Promise.all([
      store.deleteSession(raceKey),
      store.touchSession(raceKey, NOW + 1, NOW + 1_800_001),
    ]);
    await expect(store.getSession(raceKey, NOW + 2)).resolves.toBeUndefined();
  });

  it("armazena somente hashes dos identificadores entregues ao navegador", async () => {
    const rawState = "state-cookie-raw-value";
    const rawBinding = "binding-cookie-raw-value";
    const rawSession = "session-cookie-raw-value";
    const attemptKey = hash(rawState);
    const sessionKey = hash(rawSession);
    await store.saveLoginAttempt(
      attemptKey,
      attempt({ bindingHash: hash(rawBinding) }),
    );
    await store.saveSession(sessionKey, session());

    const { rows } = await adminPool.query<{ document: string }>(
      `select pg_catalog.jsonb_build_object(
         'attemptKey', a.key_hash,
         'bindingHash', a.binding_hash,
         'sessionKey', s.key_hash,
         'subject', s.subject
       )::text as document
       from renave_identity.login_attempt a
       join renave_identity.auth_session s on s.key_hash = $2
      where a.key_hash = $1`,
      [attemptKey, sessionKey],
    );
    const document = rows[0]!.document;
    expect(document).toContain(attemptKey);
    expect(document).toContain(hash(rawBinding));
    expect(document).toContain(sessionKey);
    expect(document).not.toContain(rawState);
    expect(document).not.toContain(rawBinding);
    expect(document).not.toContain(rawSession);

    const columns = await adminPool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'renave_identity'
          and column_name ~ '(cookie|token|password)'`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("remove somente expirados em lotes sem afetar registros válidos", async () => {
    const purgeNow = Date.now();
    const expiredAttemptKeys = [
      hash("expired-attempt-1"),
      hash("expired-attempt-2"),
    ];
    const validAttemptKey = hash("valid-attempt");
    for (const key of expiredAttemptKeys) {
      await store.saveLoginAttempt(
        key,
        attempt({ createdAt: purgeNow - 10_000, expiresAt: purgeNow - 1 }),
      );
    }
    await store.saveLoginAttempt(
      validAttemptKey,
      attempt({ createdAt: purgeNow, expiresAt: purgeNow + 300_000 }),
    );

    const expiredSessionKeys = [
      hash("expired-session-1"),
      hash("expired-session-2"),
    ];
    const validSessionKey = hash("valid-session");
    for (const key of expiredSessionKeys) {
      await store.saveSession(
        key,
        session({
          createdAt: purgeNow - 20_000,
          lastSeenAt: purgeNow - 10_000,
          idleExpiresAt: purgeNow - 1,
          absoluteExpiresAt: purgeNow + 10_000,
        }),
      );
    }
    await store.saveSession(
      validSessionKey,
      session({
        createdAt: purgeNow,
        lastSeenAt: purgeNow,
        idleExpiresAt: purgeNow + 1_800_000,
        absoluteExpiresAt: purgeNow + 43_200_000,
      }),
    );

    await expect(store.purgeExpiredRecords(1)).resolves.toEqual({
      loginAttemptsDeleted: 1,
      sessionsDeleted: 1,
    });
    await expect(store.purgeExpiredRecords(1)).resolves.toEqual({
      loginAttemptsDeleted: 1,
      sessionsDeleted: 1,
    });
    await expect(store.purgeExpiredRecords(1)).resolves.toEqual({
      loginAttemptsDeleted: 0,
      sessionsDeleted: 0,
    });
    await expect(
      store.consumeLoginAttempt(validAttemptKey, purgeNow),
    ).resolves.toBeDefined();
    await expect(
      store.getSession(validSessionKey, purgeNow),
    ).resolves.toBeDefined();
  });

  it("divide a purga concorrente sem remover o mesmo expirado duas vezes", async () => {
    const purgeNow = Date.now();
    const count = 20;
    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        await store.saveLoginAttempt(
          hash(`concurrent-expired-attempt-${index}`),
          attempt({ createdAt: purgeNow - 10_000, expiresAt: purgeNow - 1 }),
        );
        await store.saveSession(
          hash(`concurrent-expired-session-${index}`),
          session({
            createdAt: purgeNow - 20_000,
            lastSeenAt: purgeNow - 10_000,
            idleExpiresAt: purgeNow - 1,
            absoluteExpiresAt: purgeNow + 10_000,
          }),
        );
      }),
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () => store.purgeExpiredRecords(6)),
    );
    expect(
      results.reduce((sum, result) => sum + result.loginAttemptsDeleted, 0),
    ).toBe(count);
    expect(
      results.reduce((sum, result) => sum + result.sessionsDeleted, 0),
    ).toBe(count);
  });

  it("aplica privilégios mínimos e mantém os objetos sob o migrator", async () => {
    const { rows } = await adminPool.query(
      `select c.relname, pg_catalog.pg_get_userbyid(c.relowner) as owner
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave_identity' and c.relkind = 'r'
        order by c.relname`,
    );
    expect(rows).toEqual([
      { relname: "auth_session", owner: MIGRATOR_ROLE },
      { relname: "login_attempt", owner: MIGRATOR_ROLE },
      { relname: "login_rate_bucket", owner: MIGRATOR_ROLE },
      { relname: "login_rate_policy", owner: MIGRATOR_ROLE },
    ]);

    const privileges = await adminPool.query<{
      table_name: string;
      privilege_type: string;
    }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'renave_identity'
        order by table_name, privilege_type`,
      [IDENTITY_APP_ROLE],
    );
    expect(privileges.rows).toEqual([]);

    const routines = await adminPool.query<{
      privilege_type: string;
      routine_name: string;
    }>(
      `select routine_name, privilege_type
         from information_schema.routine_privileges
        where grantee = $1 and routine_schema = 'renave_identity'
        order by routine_name, privilege_type`,
      [IDENTITY_APP_ROLE],
    );
    expect(routines.rows).toEqual([
      { routine_name: "consume_login_attempt", privilege_type: "EXECUTE" },
      {
        routine_name: "consume_login_rate_limit",
        privilege_type: "EXECUTE",
      },
      { routine_name: "delete_auth_session", privilege_type: "EXECUTE" },
      { routine_name: "get_auth_session", privilege_type: "EXECUTE" },
      {
        routine_name: "purge_expired_identity_records",
        privilege_type: "EXECUTE",
      },
      {
        routine_name: "purge_stale_login_rate_buckets",
        privilege_type: "EXECUTE",
      },
      { routine_name: "save_auth_session", privilege_type: "EXECUTE" },
      { routine_name: "save_login_attempt", privilege_type: "EXECUTE" },
      { routine_name: "touch_auth_session", privilege_type: "EXECUTE" },
    ]);

    const publicRoutines = await adminPool.query(
      `select routine_name, privilege_type
         from information_schema.routine_privileges
        where grantee = 'PUBLIC' and routine_schema = 'renave_identity'`,
    );
    expect(publicRoutines.rows).toEqual([]);

    const appRoutines = await adminPool.query(
      `select routine_name, privilege_type
         from information_schema.routine_privileges
        where grantee = $1 and routine_schema = 'renave_identity'`,
      [APP_ROLE],
    );
    expect(appRoutines.rows).toEqual([]);

    await expect(
      identityPool.query("select * from renave_identity.login_attempt"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("select * from renave_identity.auth_session"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("truncate renave_identity.auth_session"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("create table renave_identity.intruso (id int)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("select * from renave.tenant"),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      appPool.query("select renave_identity.get_auth_session($1, $2)", [
        hash("forbidden-app-session"),
        NOW,
      ]),
    ).rejects.toMatchObject({ code: "42501" });

    const signatures = await adminPool.query<{ old_signature: string | null }>(
      `select pg_catalog.to_regprocedure(
         'renave_identity.save_auth_session(text,text,text,text,text[],bigint,bigint,bigint,bigint)'
       )::text as old_signature`,
    );
    expect(signatures.rows[0]?.old_signature).toBeNull();
  });

  it("faz a CHECK SQL recusar papéis vazios, longos e multidimensionais", async () => {
    const call = (roles: string[] | string[][]) =>
      identityPool.query(
        `select renave_identity.save_auth_session(
           $1, 'subject', null, null, $2::text[], null, false,
           $3, $3, $4, $5
         )`,
        [
          hash(`invalid-roles-${JSON.stringify(roles)}`),
          roles,
          NOW,
          NOW + 1,
          NOW + 2,
        ],
      );

    await expect(call([""])).rejects.toMatchObject({ code: "23514" });
    await expect(call(["r".repeat(129)])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(call([["a"], ["b"]])).rejects.toMatchObject({ code: "23514" });
    await expect(call([" role"])).rejects.toMatchObject({ code: "23514" });
    await expect(call(["role\nadmin"])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("faz a CHECK SQL recusar contexto de autenticação com whitespace, controle, Unicode ou excesso", async () => {
    const call = (authenticationContext: string) =>
      identityPool.query(
        `select renave_identity.save_auth_session(
           $1, 'subject', null, null, '{}'::text[], $2, false,
           $3, $3, $4, $5
         )`,
        [
          hash(`invalid-auth-context-${authenticationContext}`),
          authenticationContext,
          NOW,
          NOW + 1,
          NOW + 2,
        ],
      );

    for (const invalid of [
      " acr",
      "acr value",
      "acr\nvalue",
      "nível-mfa",
      "a".repeat(513),
    ]) {
      await expect(call(invalid)).rejects.toMatchObject({ code: "23514" });
    }

    await expect(
      identityPool.query(
        `select renave_identity.save_auth_session(
           $1, 'subject', null, null, '{}'::text[], null, true,
           $2, $2, $3, $4
         )`,
        [hash("mfa-snapshot-without-context"), NOW, NOW + 1, NOW + 2],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("recusa chaves, janelas e claims inválidos antes de consultar o banco", async () => {
    await expect(
      store.saveLoginAttempt("cookie-bruto", attempt()),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveLoginAttempt(
        hash("attempt-invalid-window"),
        attempt({ expiresAt: NOW }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveSession(
        hash("session-invalid-role"),
        session({ roles: ["r".repeat(129)] }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveSession(
        hash("session-whitespace-role"),
        session({ roles: [" role"] }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveSession(
        hash("session-invalid-auth-context"),
        session({ authenticationContext: "acr value" }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveSession(
        hash("session-invalid-mfa-snapshot"),
        session({ mfaVerifiedAtLogin: undefined as never }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
    await expect(
      store.saveSession(
        hash("session-mfa-snapshot-without-context"),
        session({ mfaVerifiedAtLogin: true }),
      ),
    ).rejects.toBeInstanceOf(IdentitySessionStoreInputError);
  });
});
