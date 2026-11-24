import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import {
  APP_ROLE,
  IDENTITY_APP_ROLE,
  MIGRATOR_ROLE,
} from "../../src/config.js";
import {
  createEstablishment,
  getEstablishment,
  listEstablishments,
  renameEstablishment,
  type Establishment,
} from "../../src/establishments.js";
import {
  loadMigrations,
  MigrationError,
  runMigrations,
} from "../../src/migrate.js";
import {
  TenantContextError,
  createPool,
  withTenant,
} from "../../src/tenant-context.js";
import {
  getCurrentTenant,
  provisionTenant,
  type Tenant,
} from "../../src/tenants.js";

const urls = inject("dbUrls");

const CNPJ_NUMERIC_MASKED = "11.222.333/0001-81"; // numérico, com máscara
const CNPJ_ALPHA = "12ABC34501DE35"; // alfanumérico

let appPool: Pool;
let migratorPool: Pool;
let adminPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let estA: Establishment;
let estB: Establishment;

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  adminPool = createPool(urls.admin, { max: 1 });
  tenantA = await provisionTenant(migratorPool, {
    slug: "tenant-a",
    displayName: "Tenant A",
  });
  tenantB = await provisionTenant(migratorPool, {
    slug: "tenant-b",
    displayName: "Tenant B",
  });
  estA = await withTenant(appPool, tenantA.id, (c) =>
    createEstablishment(c, {
      cnpj: CNPJ_NUMERIC_MASKED,
      tradeName: "Loja A Matriz",
    }),
  );
  estB = await withTenant(appPool, tenantB.id, (c) =>
    createEstablishment(c, { cnpj: CNPJ_ALPHA, tradeName: "Loja B Matriz" }),
  );
});

afterAll(async () => {
  await Promise.all([appPool?.end(), migratorPool?.end(), adminPool?.end()]);
});

const rls = { code: "42501" }; // insufficient_privilege (inclui violação de política RLS)

describe("postura de papéis e RLS", () => {
  it("app e migrator não são superuser nem BYPASSRLS; app não cria nada", async () => {
    const { rows } = await adminPool.query(
      `select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit
         from pg_roles where rolname = any($1)`,
      [[APP_ROLE, MIGRATOR_ROLE]],
    );
    expect(rows).toHaveLength(2);
    for (const role of rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolcanlogin: true,
      });
    }
    const member = await adminPool.query(
      "select pg_has_role($1, $2, 'member') as m",
      [APP_ROLE, MIGRATOR_ROLE],
    );
    expect(member.rows[0].m).toBe(false);
    const crossMembership = await adminPool.query(
      `select
         pg_has_role($1, $2, 'member') as app_has_identity,
         pg_has_role($2, $1, 'member') as identity_has_app`,
      [APP_ROLE, IDENTITY_APP_ROLE],
    );
    expect(crossMembership.rows[0]).toEqual({
      app_has_identity: false,
      identity_has_app: false,
    });
  });

  it("todas as tabelas tenant-scoped pertencem ao migrator e forçam RLS", async () => {
    const { rows } = await adminPool.query(
      `select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave' and c.relkind = 'r'
          and c.relname in (
            'tenant', 'establishment', 'audit_event', 'audit_chain_head',
            'tenant_user', 'tenant_role_grant', 'establishment_role_scope'
          )
        order by c.relname`,
    );
    expect(rows).toEqual([
      {
        relname: "audit_chain_head",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "audit_event",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "establishment",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "establishment_role_scope",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "tenant",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "tenant_role_grant",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "tenant_user",
        owner: MIGRATOR_ROLE,
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
  });

  it("FORCE RLS vale também para o dono: sem tenant o migrator não vê nem insere", async () => {
    const seen = await migratorPool.query(
      "select count(*)::int as n from renave.establishment",
    );
    expect(seen.rows[0].n).toBe(0);
    await expect(
      migratorPool.query(
        "insert into renave.tenant (slug, display_name) values ('sem-contexto', 'X')",
      ),
    ).rejects.toMatchObject(rls);
  });

  it("app não executa DDL, não apaga, não escreve em tenant nem lê o ledger", async () => {
    await withTenant(appPool, tenantA.id, async (c) => {
      const attempts = [
        "create table renave.intruso (id int)",
        "create table public.intruso (id int)",
        "alter table renave.establishment disable row level security",
        "drop table renave.establishment",
        "truncate renave.establishment",
        "delete from renave.establishment",
        "update renave.tenant set display_name = 'x'",
        "insert into renave.tenant (slug, display_name) values ('novo', 'Novo')",
        "update renave.establishment set tenant_id = gen_random_uuid()",
        "update renave.establishment set cnpj = '00000000000191'",
        "select * from renave.schema_migrations",
        `set role ${MIGRATOR_ROLE}`,
      ];
      for (const sql of attempts) {
        await c.query("savepoint s");
        await expect(c.query(sql), sql).rejects.toMatchObject(rls);
        await c.query("rollback to savepoint s");
      }
    });
  });
});

describe("isolamento de leitura e escrita entre tenants", () => {
  it("cada tenant lê apenas os próprios estabelecimentos e o próprio tenant", async () => {
    const listA = await withTenant(appPool, tenantA.id, listEstablishments);
    const listB = await withTenant(appPool, tenantB.id, listEstablishments);
    expect(listA.map((e) => e.id)).toEqual([estA.id]);
    expect(listB.map((e) => e.id)).toEqual([estB.id]);
    expect(listA[0]).toMatchObject({
      tenantId: tenantA.id,
      cnpj: "11222333000181",
    });
    expect(listB[0]).toMatchObject({ tenantId: tenantB.id, cnpj: CNPJ_ALPHA });

    expect(
      await withTenant(appPool, tenantA.id, getCurrentTenant),
    ).toMatchObject({ id: tenantA.id });
    expect(
      await withTenant(appPool, tenantB.id, getCurrentTenant),
    ).toMatchObject({ id: tenantB.id });
  });

  it("não alcança linha de outro tenant nem por id, filtro ou join", async () => {
    expect(
      await withTenant(appPool, tenantA.id, (c) =>
        getEstablishment(c, estB.id),
      ),
    ).toBeNull();
    expect(
      await withTenant(appPool, tenantB.id, (c) =>
        getEstablishment(c, estA.id),
      ),
    ).toBeNull();
    await withTenant(appPool, tenantA.id, async (c) => {
      const byFilter = await c.query(
        "select 1 from renave.establishment where tenant_id = $1",
        [tenantB.id],
      );
      expect(byFilter.rowCount).toBe(0);
      const joined = await c.query(
        "select 1 from renave.establishment e join renave.tenant t on t.id = e.tenant_id where t.id = $1",
        [tenantB.id],
      );
      expect(joined.rowCount).toBe(0);
    });
  });

  it("escrita é isolada: INSERT para outro tenant e UPDATE de linha alheia falham sem efeito", async () => {
    await withTenant(appPool, tenantA.id, async (c) => {
      await expect(
        c.query(
          "insert into renave.establishment (tenant_id, cnpj, trade_name) values ($1, $2, 'Invasor')",
          [tenantB.id, "00.000.000/0001-91"],
        ),
      ).rejects.toMatchObject(rls);
    });
    await withTenant(appPool, tenantA.id, async (c) => {
      expect(await renameEstablishment(c, estB.id, "Sequestrado")).toBeNull();
      const direct = await c.query(
        "update renave.establishment set status = 'inactive' where tenant_id = $1",
        [tenantB.id],
      );
      expect(direct.rowCount).toBe(0);
    });
    const afterB = await withTenant(appPool, tenantB.id, (c) =>
      getEstablishment(c, estB.id),
    );
    expect(afterB).toMatchObject({
      tradeName: "Loja B Matriz",
      status: "active",
    });
  });

  it("escreve e lê dentro do próprio tenant", async () => {
    const renamed = await withTenant(appPool, tenantA.id, (c) =>
      renameEstablishment(c, estA.id, "Loja A Renomeada"),
    );
    expect(renamed).toMatchObject({
      id: estA.id,
      tradeName: "Loja A Renomeada",
    });
    estA = renamed!;
  });
});

describe("reuso do pool não vaza tenant", () => {
  it("a mesma conexão física volta sem tenant após commit, rollback e erro", async () => {
    const single = createPool(urls.app, { max: 1 });
    try {
      const pidInTenant = await withTenant(single, tenantA.id, async (c) => {
        expect((await listEstablishments(c)).length).toBe(1);
        return (await c.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
      });

      const probe = async () => {
        const { rows } = await single.query(
          `select pg_backend_pid() as pid,
                  current_setting('renave.tenant_id', true) as setting,
                  renave.current_tenant_id() as tenant,
                  (select count(*)::int from renave.establishment) as establishments,
                  (select count(*)::int from renave.tenant) as tenants`,
        );
        return rows[0];
      };

      let after = await probe();
      expect(after.pid).toBe(pidInTenant); // provadamente a mesma conexão
      expect(["", null]).toContain(after.setting);
      expect(after).toMatchObject({
        tenant: null,
        establishments: 0,
        tenants: 0,
      });

      await expect(
        withTenant(single, tenantB.id, async (c) => {
          await listEstablishments(c);
          throw new Error("falha de negócio");
        }),
      ).rejects.toThrow("falha de negócio");
      after = await probe();
      expect(after.pid).toBe(pidInTenant);
      expect(after).toMatchObject({
        tenant: null,
        establishments: 0,
        tenants: 0,
      });

      await expect(
        withTenant(single, tenantA.id, (c) =>
          c.query("select * from tabela_que_nao_existe"),
        ),
      ).rejects.toMatchObject({ code: "42P01" });
      after = await probe();
      expect(after.pid).toBe(pidInTenant);
      expect(after).toMatchObject({
        tenant: null,
        establishments: 0,
        tenants: 0,
      });
    } finally {
      await single.end();
    }
  });

  it("alternância concorrente A/B em pool pequeno nunca mistura linhas", async () => {
    const small = createPool(urls.app, { max: 2 });
    try {
      const jobs = Array.from({ length: 60 }, (_, i) => {
        const [tenant, other] =
          i % 2 === 0 ? [tenantA, tenantB] : [tenantB, tenantA];
        return withTenant(small, tenant.id, async (c) => {
          await c.query("select pg_sleep($1)", [Math.random() / 50]);
          const rows = await listEstablishments(c);
          const current = await getCurrentTenant(c);
          return { tenant, other, rows, current };
        });
      });
      for (const { tenant, other, rows, current } of await Promise.all(jobs)) {
        expect(rows).toHaveLength(1);
        expect(
          rows.every(
            (r) => r.tenantId === tenant.id && r.tenantId !== other.id,
          ),
        ).toBe(true);
        expect(current?.id).toBe(tenant.id);
      }
      const idle = await small.query(
        "select count(*)::int as n from renave.establishment",
      );
      expect(idle.rows[0].n).toBe(0);
    } finally {
      await small.end();
    }
  });
});

describe("fail closed sem tenant", () => {
  it("consulta fora de withTenant devolve zero linhas e o INSERT é recusado", async () => {
    const count = await appPool.query(
      `select (select count(*)::int from renave.establishment) as establishments,
              (select count(*)::int from renave.tenant) as tenants,
              renave.current_tenant_id() as tenant`,
    );
    expect(count.rows[0]).toEqual({
      establishments: 0,
      tenants: 0,
      tenant: null,
    });

    await expect(
      appPool.query(
        "insert into renave.establishment (tenant_id, cnpj, trade_name) values ($1, $2, 'X')",
        [tenantA.id, "00000000000191"],
      ),
    ).rejects.toMatchObject(rls);

    // tenant_id vem do contexto: sem contexto vira NULL e a linha não nasce
    await expect(
      appPool.query(
        "insert into renave.establishment (tenant_id, cnpj, trade_name) values (renave.current_tenant_id(), $1, 'X')",
        ["00000000000191"],
      ),
    ).rejects.toBeDefined();
  });

  it("valor vazio no GUC equivale a sem tenant", async () => {
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('renave.tenant_id', '', true)");
      const { rows } = await client.query(
        "select renave.current_tenant_id() as tenant, (select count(*)::int from renave.establishment) as n",
      );
      expect(rows[0]).toEqual({ tenant: null, n: 0 });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("valor malformado no GUC causa erro, não acesso", async () => {
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('renave.tenant_id', 'nao-e-uuid', true)",
      );
      await expect(
        client.query("select count(*) from renave.establishment"),
      ).rejects.toMatchObject({
        code: "22P02",
      });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("UUID desconhecido não lê nada e não consegue criar estabelecimento", async () => {
    const ghost = crypto.randomUUID();
    expect(await withTenant(appPool, ghost, listEstablishments)).toEqual([]);
    await expect(
      withTenant(appPool, ghost, (c) =>
        createEstablishment(c, {
          cnpj: "00000000000191",
          tradeName: "Fantasma",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" }); // FK: tenant inexistente
  });

  it("withTenant recusa tenant ausente ou inválido antes de tocar o banco", async () => {
    for (const bad of [
      "",
      "abc",
      "11111111-1111-1111-1111-11111111111",
      undefined,
      null,
      42,
    ]) {
      const before = appPool.totalCount;
      await expect(
        withTenant(appPool, bad as unknown as string, async () => "nunca"),
      ).rejects.toBeInstanceOf(TenantContextError);
      expect(appPool.totalCount).toBe(before);
    }
  });
});

describe("CNPJ normalizado e alfanumérico", () => {
  it("armazena sem máscara e em maiúsculas, com raiz/filial derivadas", async () => {
    expect(estA.cnpj).toBe("11222333000181");
    expect(estA).toMatchObject({ cnpjRoot: "11222333", cnpjBranch: "0001" });
    expect(estB).toMatchObject({
      cnpj: "12ABC34501DE35",
      cnpjRoot: "12ABC345",
      cnpjBranch: "01DE",
    });

    const lower = await withTenant(appPool, tenantA.id, (c) =>
      createEstablishment(c, {
        cnpj: " 12.abc.345/01de-35 ",
        tradeName: "Filial alfa",
      }),
    );
    expect(lower.cnpj).toBe("12ABC34501DE35");
  });

  it("recusa dígito verificador errado, tamanho errado e caracteres inválidos", async () => {
    for (const cnpj of [
      "11.222.333/0001-80",
      "1122233300018",
      "12ABC34501DE3A",
      "12ÀBC34501DE35",
      "00000000000000",
    ]) {
      await expect(
        withTenant(appPool, tenantA.id, (c) =>
          createEstablishment(c, { cnpj, tradeName: "Inválido" }),
        ),
        cnpj,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("é único por tenant e repetível entre tenants", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (c) =>
        createEstablishment(c, { cnpj: "11222333000181", tradeName: "Dup" }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const sameInB = await withTenant(appPool, tenantB.id, (c) =>
      createEstablishment(c, {
        cnpj: "11.222.333/0001-81",
        tradeName: "Mesmo CNPJ no tenant B",
      }),
    );
    expect(sameInB).toMatchObject({
      tenantId: tenantB.id,
      cnpj: "11222333000181",
    });
  });

  it("identidade é imutável até para o dono da linha (gatilho)", async () => {
    const guarded = createPool(urls.migrator, { max: 1 });
    try {
      await expect(
        withTenant(guarded, tenantA.id, (c) =>
          c.query(
            "update renave.establishment set cnpj = '00000000000191' where id = $1",
            [estA.id],
          ),
        ),
      ).rejects.toMatchObject({ code: "23000" });
    } finally {
      await guarded.end();
    }
  });

  it("função SQL e TypeScript concordam nos vetores de validação", async () => {
    const { isValidNormalizedCnpj } = await import("../../src/cnpj.js");
    const vectors = [
      "11222333000181",
      "12ABC34501DE35",
      "11222333000182",
      "12ABC34501DE3A",
      "00000000000000",
      "12abc34501de35",
      "123",
    ];
    for (const v of vectors) {
      const { rows } = await appPool.query(
        "select renave.cnpj_is_valid($1) as ok",
        [v],
      );
      expect(rows[0].ok, v).toBe(isValidNormalizedCnpj(v));
    }
  });
});

describe("migrations", () => {
  it("reexecução é idempotente e o ledger tem checksum", async () => {
    const result = await runMigrations(urls.migrator);
    expect(result.applied).toEqual([]);
    const expected = await loadMigrations();
    const { rows } = await migratorPool.query(
      "select version, checksum from renave.schema_migrations order by version",
    );
    expect(rows).toEqual(
      expected.map((m) => ({ version: m.version, checksum: m.checksum })),
    );
  });

  it("migration alterada após aplicada interrompe o runner", async () => {
    const { rows } = await migratorPool.query(
      "select checksum from renave.schema_migrations where version = $1",
      ["0001_tenant_establishment"],
    );
    const original = rows[0].checksum as string;
    await migratorPool.query(
      "update renave.schema_migrations set checksum = 'adulterado' where version = $1",
      ["0001_tenant_establishment"],
    );
    try {
      await expect(runMigrations(urls.migrator)).rejects.toThrow(
        MigrationError,
      );
    } finally {
      await migratorPool.query(
        "update renave.schema_migrations set checksum = $2 where version = $1",
        ["0001_tenant_establishment", original],
      );
    }
  });

  it("o papel de aplicação não consegue migrar", async () => {
    await expect(runMigrations(urls.app)).rejects.toBeDefined();
  });
});
