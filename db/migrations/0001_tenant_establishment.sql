-- 0001 — Fundação multi-tenant: tenant, establishment e isolamento por RLS.
--
-- Proveniência: padrões genéricos adaptados do projeto
-- `plataforma-harmonizacao-normativa` (mesmo proprietário) — tenant corrente
-- via set_config transacional, FORCE ROW LEVEL SECURITY e validação de CNPJ
-- alfanumérico no banco (módulo 11, valor = código ASCII − 48). Nenhum
-- dado, credencial ou código de cliente foi copiado. Ver db/README.md.
--
-- Pré-condições (feitas por `pnpm db:bootstrap`, fora das migrations):
--   * papéis `renave_migrator` (dono dos objetos; roda as migrations) e
--     `renave_app` (runtime; NOSUPERUSER, NOBYPASSRLS, não proprietário);
--   * o runner cria o esquema `renave` e o ledger `renave.schema_migrations`.
--
-- Modelo de isolamento:
--   * o tenant ativo é `renave.tenant_id`, definido com
--     `set_config('renave.tenant_id', <uuid>, true)` DENTRO de uma transação
--     (is_local = true: o valor some no COMMIT/ROLLBACK e não vaza no pool);
--   * `renave.current_tenant_id()` devolve NULL sem tenant (ou com valor
--     vazio) e as políticas comparam `tenant_id = NULL`, que nunca é
--     verdadeiro: sem tenant não há leitura nem escrita (fail closed). Um
--     valor que não é UUID faz o cast falhar (erro, também fail closed);
--   * FORCE RLS vale até para o dono das tabelas.
--
-- Rollback (documentado; o runner só avança):
--   begin;
--   drop table renave.establishment;
--   drop table renave.tenant;
--   drop function renave.touch_updated_at(), renave.establishment_guard(),
--                 renave.cnpj_is_valid(text), renave.normalize_cnpj(text),
--                 renave.current_tenant_id();
--   delete from renave.schema_migrations where version = '0001_tenant_establishment';
--   commit;

create schema if not exists renave;

revoke all on schema renave from public;
grant usage on schema renave to renave_app;

-- ── Funções ────────────────────────────────────────────────────────────

-- Tenant ativo da transação corrente; NULL quando ausente (fail closed).
create function renave.current_tenant_id()
returns uuid
language sql
stable
parallel safe
as $$
  select nullif(pg_catalog.current_setting('renave.tenant_id', true), '')::uuid
$$;

-- Forma canônica de armazenamento: maiúsculas e sem máscara (`.`, `/`, `-`,
-- espaços). Não valida; quem valida é `cnpj_is_valid` e a CHECK da coluna.
create function renave.normalize_cnpj(raw text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select pg_catalog.upper(pg_catalog.regexp_replace(raw, '[./\s-]', '', 'g'))
$$;

-- CNPJ de 14 posições: 12 alfanuméricas (maiúsculas ou dígitos; o formato
-- numérico é subconjunto) + 2 dígitos verificadores numéricos, módulo 11 com
-- valor = ASCII − 48. Espera a forma já normalizada. Rejeita sequências de
-- 14 dígitos iguais (convenção da Receita, ex.: 00000000000000).
create function renave.cnpj_is_valid(cnpj text)
returns boolean
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
declare
  w1 constant int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
  w2 constant int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  total int;
  i int;
  d1 int;
  d2 int;
begin
  if cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' or cnpj ~ '^([0-9])\1{13}$' then
    return false;
  end if;

  total := 0;
  for i in 1..12 loop
    total := total + (ascii(substr(cnpj, i, 1)) - 48) * w1[i];
  end loop;
  d1 := case when total % 11 < 2 then 0 else 11 - total % 11 end;

  total := d1 * w2[13];
  for i in 1..12 loop
    total := total + (ascii(substr(cnpj, i, 1)) - 48) * w2[i];
  end loop;
  d2 := case when total % 11 < 2 then 0 else 11 - total % 11 end;

  return d1 = substr(cnpj, 13, 1)::int and d2 = substr(cnpj, 14, 1)::int;
end;
$$;

create function renave.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

-- ── tenant ─────────────────────────────────────────────────────────────

create table renave.tenant (
  id           uuid        primary key default gen_random_uuid(),
  slug         text        not null,
  display_name text        not null,
  status       text        not null default 'active',
  created_at   timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at   timestamptz not null default pg_catalog.clock_timestamp(),
  constraint tenant_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint tenant_display_name_not_blank check (pg_catalog.btrim(display_name) <> ''),
  constraint tenant_status_valid check (status in ('active', 'suspended'))
);

create unique index tenant_slug_key on renave.tenant (slug);

create trigger tenant_touch_updated_at
  before update on renave.tenant
  for each row execute function renave.touch_updated_at();

-- ── establishment ──────────────────────────────────────────────────────

create table renave.establishment (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references renave.tenant (id) on delete restrict,
  cnpj        text        not null,
  cnpj_root   text        generated always as (pg_catalog.substr(cnpj, 1, 8)) stored,
  cnpj_branch text        generated always as (pg_catalog.substr(cnpj, 9, 4)) stored,
  trade_name  text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at  timestamptz not null default pg_catalog.clock_timestamp(),
  constraint establishment_cnpj_normalized check (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  constraint establishment_cnpj_valid check (renave.cnpj_is_valid(cnpj)),
  constraint establishment_trade_name_not_blank check (pg_catalog.btrim(trade_name) <> ''),
  constraint establishment_status_valid check (status in ('active', 'inactive')),
  -- O mesmo CNPJ pode existir em tenants diferentes; dentro do tenant é único.
  constraint establishment_tenant_cnpj_key unique (tenant_id, cnpj),
  -- Alvo de chaves estrangeiras compostas das tabelas filhas futuras
  -- (tenant_id, establishment_id), que impedem referência entre tenants.
  constraint establishment_tenant_id_key unique (tenant_id, id)
);

create index establishment_tenant_root_idx on renave.establishment (tenant_id, cnpj_root);

-- Normaliza o CNPJ ANTES das CHECKs (gatilhos BEFORE rodam primeiro) e
-- congela a identidade da linha: id, tenant e CNPJ nunca mudam.
create function renave.establishment_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    new.cnpj := renave.normalize_cnpj(new.cnpj);
  elsif new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.cnpj is distinct from old.cnpj then
    raise exception 'establishment: id, tenant_id e cnpj são imutáveis'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create trigger establishment_guard
  before insert or update on renave.establishment
  for each row execute function renave.establishment_guard();

create trigger establishment_touch_updated_at
  before update on renave.establishment
  for each row execute function renave.touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────

alter table renave.tenant enable row level security;
alter table renave.tenant force row level security;
alter table renave.establishment enable row level security;
alter table renave.establishment force row level security;

-- `(select ...)` faz o planner avaliar a função uma vez por consulta.
create policy tenant_isolation on renave.tenant
  using (id = (select renave.current_tenant_id()))
  with check (id = (select renave.current_tenant_id()));

create policy establishment_isolation on renave.establishment
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

-- ── Privilégios do papel de aplicação (mínimo necessário) ──────────────
-- Sem DELETE/TRUNCATE; sem escrita em `tenant` (provisionamento é do
-- migrator, dentro do contexto do novo tenant); update só em colunas mutáveis.

revoke all on renave.tenant, renave.establishment from public;

grant select on renave.tenant to renave_app;
grant select, insert on renave.establishment to renave_app;
grant update (trade_name, status, updated_at) on renave.establishment to renave_app;
