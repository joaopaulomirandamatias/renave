-- 0009 — Diretório global mínimo para descoberta de organizações da sessão.
--
-- As tabelas de negócio continuam com FORCE RLS e nunca são consultadas sem
-- tenant. Esta projeção contém somente tenant, nome exibível e SHA-256 do
-- subject; nenhum e-mail, role ou subject em texto claro.

create schema renave_directory;
revoke all on schema renave_directory from public, renave_app, renave_identity_app;
grant usage on schema renave_directory to renave_app;

create table renave_directory.tenant_catalog (
  tenant_id    uuid        primary key,
  display_name text        not null,
  status       text        not null,
  updated_at   timestamptz not null,
  constraint tenant_catalog_name_valid
    check (pg_catalog.btrim(display_name) <> ''),
  constraint tenant_catalog_status_valid
    check (status in ('active', 'suspended'))
);

create table renave_directory.subject_tenant_membership (
  subject_hash bytea       not null,
  tenant_id    uuid        not null
    references renave_directory.tenant_catalog (tenant_id) on delete cascade,
  status       text        not null,
  updated_at   timestamptz not null,
  primary key (subject_hash, tenant_id),
  constraint subject_tenant_membership_hash_valid
    check (pg_catalog.octet_length(subject_hash) = 32),
  constraint subject_tenant_membership_status_valid
    check (status in ('active', 'suspended'))
);

create index subject_tenant_membership_lookup_idx
  on renave_directory.subject_tenant_membership (subject_hash, status, tenant_id);

revoke all on renave_directory.tenant_catalog,
  renave_directory.subject_tenant_membership
from public, renave_app, renave_identity_app;

create function renave_directory.sync_tenant_catalog()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    delete from renave_directory.tenant_catalog catalog
     where catalog.tenant_id = old.id;
    return old;
  end if;
  insert into renave_directory.tenant_catalog (
    tenant_id, display_name, status, updated_at
  ) values (new.id, new.display_name, new.status, new.updated_at)
  on conflict (tenant_id) do update set
    display_name = excluded.display_name,
    status = excluded.status,
    updated_at = excluded.updated_at;
  return new;
end
$$;

create function renave_directory.sync_subject_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  old_hash bytea;
  new_hash bytea;
begin
  if tg_op = 'DELETE' then
    old_hash := pg_catalog.sha256(pg_catalog.convert_to(old.subject, 'UTF8'));
    delete from renave_directory.subject_tenant_membership membership
     where membership.subject_hash = old_hash
       and membership.tenant_id = old.tenant_id;
    return old;
  end if;

  new_hash := pg_catalog.sha256(pg_catalog.convert_to(new.subject, 'UTF8'));

  if tg_op = 'UPDATE' then
    old_hash := pg_catalog.sha256(pg_catalog.convert_to(old.subject, 'UTF8'));
    if old.tenant_id is distinct from new.tenant_id
       or old_hash is distinct from new_hash then
      delete from renave_directory.subject_tenant_membership membership
       where membership.subject_hash = old_hash
         and membership.tenant_id = old.tenant_id;
    end if;
  end if;

  insert into renave_directory.subject_tenant_membership (
    subject_hash, tenant_id, status, updated_at
  ) values (new_hash, new.tenant_id, new.status, new.updated_at)
  on conflict (subject_hash, tenant_id) do update set
    status = excluded.status,
    updated_at = excluded.updated_at;
  return new;
end
$$;

create trigger tenant_catalog_projection
  after insert or update or delete on renave.tenant
  for each row execute function renave_directory.sync_tenant_catalog();

create trigger subject_tenant_membership_projection
  after insert or update or delete on renave.tenant_user
  for each row execute function renave_directory.sync_subject_membership();

-- O migrator é dono, mas FORCE RLS também vale para o dono. A suspensão ocorre
-- apenas dentro desta migration transacional para o backfill e é restaurada
-- antes do COMMIT.
alter table renave.tenant no force row level security;
alter table renave.tenant_user no force row level security;

insert into renave_directory.tenant_catalog (
  tenant_id, display_name, status, updated_at
)
select id, display_name, status, updated_at from renave.tenant;

insert into renave_directory.subject_tenant_membership (
  subject_hash, tenant_id, status, updated_at
)
select pg_catalog.sha256(pg_catalog.convert_to(subject, 'UTF8')),
       tenant_id, status, updated_at
  from renave.tenant_user;

alter table renave.tenant force row level security;
alter table renave.tenant_user force row level security;

create function renave_directory.discover_tenants(p_subject_hash bytea)
returns table (tenant_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if p_subject_hash is null
     or pg_catalog.octet_length(p_subject_hash) <> 32 then
    raise exception 'subject hash inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  return query
    select catalog.tenant_id, catalog.display_name
      from renave_directory.subject_tenant_membership membership
      join renave_directory.tenant_catalog catalog
        on catalog.tenant_id = membership.tenant_id
     where membership.subject_hash = p_subject_hash
       and membership.status = 'active'
       and catalog.status = 'active'
     order by catalog.display_name, catalog.tenant_id;
end
$$;

revoke all on function
  renave_directory.sync_tenant_catalog(),
  renave_directory.sync_subject_membership(),
  renave_directory.discover_tenants(bytea)
from public, renave_app, renave_identity_app;

grant execute on function renave_directory.discover_tenants(bytea)
to renave_app;
