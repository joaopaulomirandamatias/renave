-- 0017 — Estado e histórico do vínculo Credencia/RENAVE por estabelecimento.
--
-- A aplicação lê as tabelas, mas só altera o agregado pela função de
-- transição. Assim o estado corrente e o histórico append-only mudam juntos.

create table renave.credential_link (
  tenant_id uuid not null,
  establishment_id uuid not null,
  status text not null,
  version bigint not null default 1,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, establishment_id),
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint credential_link_status_valid check (
    status in ('pending', 'confirmed', 'enabled', 'deactivated', 'rejected')
  ),
  constraint credential_link_version_valid check (version > 0)
);

create table renave.credential_link_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  establishment_id uuid not null,
  version bigint not null,
  previous_status text,
  status text not null,
  source text not null,
  reason text,
  changed_by_subject_hash bytea not null,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (tenant_id, establishment_id)
    references renave.credential_link (tenant_id, establishment_id)
    on delete restrict,
  constraint credential_link_history_version_key unique (
    tenant_id, establishment_id, version
  ),
  constraint credential_link_history_previous_status_valid check (
    previous_status is null or previous_status in (
      'pending', 'confirmed', 'enabled', 'deactivated', 'rejected'
    )
  ),
  constraint credential_link_history_status_valid check (
    status in ('pending', 'confirmed', 'enabled', 'deactivated', 'rejected')
  ),
  constraint credential_link_history_source_valid check (
    source in ('manual', 'serpro_preflight', 'system')
  ),
  constraint credential_link_history_reason_valid check (
    reason is null or pg_catalog.btrim(reason) <> ''
  ),
  constraint credential_link_history_actor_hash_valid check (
    pg_catalog.octet_length(changed_by_subject_hash) = 32
  )
);

create index credential_link_history_timeline_idx
  on renave.credential_link_history (
    tenant_id, establishment_id, version desc
  );

alter table renave.credential_link enable row level security;
alter table renave.credential_link force row level security;
alter table renave.credential_link_history enable row level security;
alter table renave.credential_link_history force row level security;

create policy credential_link_isolation on renave.credential_link
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy credential_link_history_isolation on renave.credential_link_history
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.credential_link_history_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'credential_link_history é append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger credential_link_history_append_only
  before update or delete on renave.credential_link_history
  for each row execute function renave.credential_link_history_reject_change();

create function renave.transition_credential_link(
  p_establishment_id uuid,
  p_status text,
  p_source text,
  p_changed_by_subject_hash bytea,
  p_reason text default null
)
returns renave.credential_link
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_link renave.credential_link;
  next_link renave.credential_link;
begin
  if active_tenant is null then
    raise exception 'credential_link: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_establishment_id is null then
    raise exception 'credential_link: estabelecimento ausente'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_status not in ('pending', 'confirmed', 'enabled', 'deactivated', 'rejected') then
    raise exception 'credential_link: status inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_source not in ('manual', 'serpro_preflight', 'system') then
    raise exception 'credential_link: source inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_changed_by_subject_hash is null
     or pg_catalog.octet_length(p_changed_by_subject_hash) <> 32 then
    raise exception 'credential_link: hash do actor inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is not null and pg_catalog.btrim(p_reason) = '' then
    raise exception 'credential_link: reason inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from renave.establishment establishment
     where establishment.tenant_id = active_tenant
       and establishment.id = p_establishment_id
  ) then
    raise exception 'credential_link: estabelecimento indisponível'
      using errcode = 'insufficient_privilege';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(active_tenant::text || ':' || p_establishment_id::text, 170017)
  );

  select link.* into current_link
    from renave.credential_link link
   where link.tenant_id = active_tenant
     and link.establishment_id = p_establishment_id
   for update;

  if found and current_link.status = p_status then
    return current_link;
  end if;

  if not found then
    if p_status <> 'pending' then
      raise exception 'credential_link: vínculo deve iniciar pendente'
        using errcode = 'integrity_constraint_violation';
    end if;
    insert into renave.credential_link (
      tenant_id, establishment_id, status
    ) values (
      active_tenant, p_establishment_id, p_status
    ) returning * into next_link;
  else
    if not (case current_link.status
      when 'pending' then p_status in ('confirmed', 'rejected', 'deactivated')
      when 'confirmed' then p_status in ('enabled', 'rejected', 'deactivated')
      when 'enabled' then p_status = 'deactivated'
      when 'rejected' then p_status = 'pending'
      when 'deactivated' then p_status = 'pending'
      else false
    end) then
      raise exception 'credential_link: transição inválida de % para %',
        current_link.status, p_status
        using errcode = 'integrity_constraint_violation';
    end if;
    update renave.credential_link
       set status = p_status,
           version = version + 1,
           updated_at = pg_catalog.clock_timestamp()
     where tenant_id = active_tenant
       and establishment_id = p_establishment_id
     returning * into next_link;
  end if;

  insert into renave.credential_link_history (
    tenant_id, establishment_id, version, previous_status, status,
    source, reason, changed_by_subject_hash, changed_at
  ) values (
    active_tenant, p_establishment_id, next_link.version,
    case when current_link.tenant_id is null then null else current_link.status end,
    next_link.status, p_source, p_reason, p_changed_by_subject_hash,
    next_link.updated_at
  );

  return next_link;
end;
$$;

revoke all on renave.credential_link, renave.credential_link_history from public;
revoke all on function renave.transition_credential_link(uuid, text, text, bytea, text)
from public, renave_identity_app, renave_maintenance_app;
revoke all on function renave.credential_link_history_reject_change() from public;

grant select on renave.credential_link, renave.credential_link_history to renave_app;
grant execute on function renave.transition_credential_link(uuid, text, text, bytea, text)
to renave_app;

-- A presença desta definição também sinaliza ao runtime que a fatia foi
-- migrada; os checksums anteriores continuam fechados pela migration 0014.
create or replace function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected(version, checksum) as (
    values
      ('0009_tenant_directory', '95139964cbc1419a54d740483d2a4e0aaece5b7be7eaa77b7e9f88a33e524653'),
      ('0010_protected_evidence_operations', 'e6cb7e1b5fdd3ada707cf641974b5280bcf9b3d50a78a91db8c7ed4741e9e319'),
      ('0011_login_rate_limit', 'a49d1a66d095c83f20f4ab8cccd0166e789dbf78143f4387592a2b9a68886348'),
      ('0012_runtime_contract', '0e4e7d69c7298540e70f46e606b97c18b7f193fbd814b09b8e6e765c1a70c913'),
      ('0013_serpro_query_limit', '0b781d990d1d79634a075184fb9f4679c047f7bb0d3be160b99d66535f67027c')
  )
  select pg_catalog.count(migrations.version) = 5
     and pg_catalog.bool_and(migrations.checksum = expected.checksum)
     and pg_catalog.to_regclass('renave.credential_link') is not null
    from expected
    left join renave.schema_migrations migrations
      on migrations.version = expected.version
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
