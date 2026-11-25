-- 0082 — Barreiras de runtime para a saída local HELD_LOCAL.
-- Não cria outbox, despacho, worker ou qualquer capacidade de mutação SERPRO.

create schema renave_stock_exit_barriers authorization renave_migrator;
revoke all on schema renave_stock_exit_barriers from public;
grant usage on schema renave_stock_exit_barriers to renave_app;

create function renave_stock_exit_barriers.municipality_catalog_ready()
returns boolean
language sql volatile security definer set search_path = pg_catalog
as $$
  with instant as materialized (
    select pg_catalog.clock_timestamp() now_at
  )
  select coalesce((
    select r.source_kind = 'RENAVE_MUNICIPIOS'
      and r.source_url =
        'https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/municipios'
      and r.row_count between 5000 and 10000
      and r.observed_at <= instant.now_at
      and r.observed_at >= instant.now_at - interval '24 hours'
      and renave_reference.municipality_release_integrity(
        r.version, r.row_count, r.artifact_sha256)
      and not exists (
        select 1 from (values (1501402),(2611533),(5101837),(3303807)) s(code)
        where not exists (
          select 1 from renave_reference.municipality_catalog_entry e
          where e.release_version = r.version and e.code = s.code
        )
      )
    from renave_reference.active_municipality_catalog_release r
    cross join instant
  ), false)
$$;

create function renave_stock_exit_barriers.lookup_municipality(p_code integer)
returns table (state text, present boolean, release_version text)
language sql volatile security definer set search_path = pg_catalog
as $$
  with ready as (
    select r.version
    from renave_reference.active_municipality_catalog_release r
    where p_code > 0
      and renave_stock_exit_barriers.municipality_catalog_ready()
  )
  select 'READY'::text, exists (
    select 1 from renave_reference.municipality_catalog_entry e
    where e.release_version = r.version and e.code = p_code
  ), r.version from ready r
  union all
  select 'UNAVAILABLE', null::boolean, null::text
  where not exists (select 1 from ready)
$$;

revoke all on function
  renave_stock_exit_barriers.municipality_catalog_ready(),
  renave_stock_exit_barriers.lookup_municipality(integer)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker, renave_operation_promoter,
     renave_platform_reader, renave_platform_provisioner,
     renave_profile_reader, renave_profile_provisioner,
     renave_credential_scope_provisioner;
grant execute on function
  renave_stock_exit_barriers.municipality_catalog_ready(),
  renave_stock_exit_barriers.lookup_municipality(integer)
to renave_app;

create table renave_stock_exit_barriers.rate_policy (
  singleton boolean primary key default true,
  global_capacity numeric not null,
  global_refill_per_second numeric not null,
  tenant_capacity numeric not null,
  tenant_refill_per_second numeric not null,
  subject_capacity numeric not null,
  subject_refill_per_second numeric not null,
  constraint stock_exit_rate_policy_singleton check (singleton),
  constraint stock_exit_rate_policy_values check (
    global_capacity >= 1 and global_refill_per_second > 0
    and tenant_capacity >= 1 and tenant_refill_per_second > 0
    and subject_capacity >= 1 and subject_refill_per_second > 0
  )
);
insert into renave_stock_exit_barriers.rate_policy values (
  true, 60, 1.0, 30, 0.5, 10, 10.0 / 60.0
);

create table renave_stock_exit_barriers.rate_bucket (
  scope text not null,
  scope_key bytea not null,
  available_units numeric not null,
  last_refill_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (scope, scope_key),
  constraint stock_exit_rate_bucket_scope check (
    scope in ('global','tenant','subject')
  ),
  constraint stock_exit_rate_bucket_key check (
    pg_catalog.octet_length(scope_key) = 32
  ),
  constraint stock_exit_rate_bucket_units check (available_units >= 0)
);
create index stock_exit_rate_bucket_last_seen_idx
  on renave_stock_exit_barriers.rate_bucket(last_seen_at)
  where scope <> 'global';

revoke all on renave_stock_exit_barriers.rate_policy,
  renave_stock_exit_barriers.rate_bucket
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker, renave_operation_promoter,
     renave_platform_reader, renave_platform_provisioner,
     renave_profile_reader, renave_profile_provisioner,
     renave_credential_scope_provisioner;

create function renave_stock_exit_barriers.consume_rate_limit(
  p_tenant_key bytea, p_subject_key bytea
)
returns table (allowed boolean, limited_scope text, retry_after_seconds integer)
language plpgsql volatile security definer set search_path = pg_catalog
as $$
declare
  policy renave_stock_exit_barriers.rate_policy%rowtype;
  now_at timestamptz := pg_catalog.clock_timestamp();
  global_key constant bytea := pg_catalog.decode(pg_catalog.repeat('00',32),'hex');
  item record;
  tokens numeric;
  refill numeric;
  global_tokens numeric;
  tenant_tokens numeric;
  subject_tokens numeric;
begin
  if p_tenant_key is null or pg_catalog.octet_length(p_tenant_key) <> 32
     or p_subject_key is null or pg_catalog.octet_length(p_subject_key) <> 32 then
    raise exception 'chave de limite de saída inválida'
      using errcode = 'invalid_parameter_value';
  end if;
  select * into strict policy from renave_stock_exit_barriers.rate_policy
  where singleton;

  for item in select * from (values
    (1,'global'::text,global_key,policy.global_capacity,
      policy.global_refill_per_second),
    (2,'tenant'::text,p_tenant_key,policy.tenant_capacity,
      policy.tenant_refill_per_second),
    (3,'subject'::text,p_subject_key,policy.subject_capacity,
      policy.subject_refill_per_second)
  ) limits(lock_order,scope,scope_key,max_units,refill_rate)
  order by lock_order loop
    insert into renave_stock_exit_barriers.rate_bucket
      (scope,scope_key,available_units,last_refill_at,last_seen_at)
    values (item.scope,item.scope_key,item.max_units,now_at,now_at)
    on conflict (scope,scope_key) do nothing;
    perform 1 from renave_stock_exit_barriers.rate_bucket b
      where b.scope=item.scope and b.scope_key=item.scope_key for update;
    if item.scope='global' then
      delete from renave_stock_exit_barriers.rate_bucket stale
      where stale.ctid in (
        select candidate.ctid from renave_stock_exit_barriers.rate_bucket candidate
        where candidate.scope <> 'global'
          and candidate.last_seen_at < now_at - interval '48 hours'
        order by candidate.last_seen_at limit 100 for update skip locked
      );
    end if;
    now_at := pg_catalog.clock_timestamp();
    select item.refill_rate,
      least(item.max_units,b.available_units
        + extract(epoch from (now_at-b.last_refill_at))*item.refill_rate)
      into refill,tokens from renave_stock_exit_barriers.rate_bucket b
      where b.scope=item.scope and b.scope_key=item.scope_key;
    if tokens < 1 then
      update renave_stock_exit_barriers.rate_bucket b set
        available_units=tokens,last_refill_at=now_at,last_seen_at=now_at
      where b.scope=item.scope and b.scope_key=item.scope_key;
      return query select false,item.scope,
        greatest(1,pg_catalog.ceil((1-tokens)/refill)::integer);
      return;
    end if;
    if item.scope='global' then global_tokens:=tokens;
    elsif item.scope='tenant' then tenant_tokens:=tokens;
    else subject_tokens:=tokens;
    end if;
  end loop;

  update renave_stock_exit_barriers.rate_bucket b set
    available_units=case b.scope when 'global' then global_tokens-1
      when 'tenant' then tenant_tokens-1 else subject_tokens-1 end,
    last_refill_at=now_at,last_seen_at=now_at
  where (b.scope,b.scope_key) in (
    ('global',global_key),('tenant',p_tenant_key),('subject',p_subject_key)
  );
  return query select true,null::text,0;
end
$$;

revoke all on function renave_stock_exit_barriers.consume_rate_limit(bytea,bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker, renave_operation_promoter,
     renave_platform_reader, renave_platform_provisioner,
     renave_profile_reader, renave_profile_provisioner,
     renave_credential_scope_provisioner;
grant execute on function renave_stock_exit_barriers.consume_rate_limit(bytea,bytea)
to renave_app;
