-- 0013 — Limite distribuído de volume e concorrência para consultas SERPRO.
--
-- O banco recebe apenas chaves HMAC. Leases expiram pelo relógio do PostgreSQL,
-- portanto um processo encerrado não bloqueia capacidade indefinidamente.

create table renave_operations.serpro_query_policy (
  singleton boolean primary key default true check (singleton),
  global_concurrency integer not null default 16,
  tenant_concurrency integer not null default 4,
  actor_concurrency integer not null default 2,
  global_per_window integer not null default 600,
  tenant_per_window integer not null default 120,
  actor_per_window integer not null default 30,
  window_size interval not null default interval '1 minute',
  lease_ttl interval not null default interval '3 minutes',
  constraint serpro_query_policy_positive check (
    global_concurrency >= 1
    and tenant_concurrency between 1 and global_concurrency
    and actor_concurrency between 1 and tenant_concurrency
    and global_per_window >= 1
    and tenant_per_window between 1 and global_per_window
    and actor_per_window between 1 and tenant_per_window
    and window_size between interval '1 second' and interval '1 hour'
    and lease_ttl between interval '10 seconds' and interval '10 minutes'
  )
);

insert into renave_operations.serpro_query_policy (singleton) values (true);

create table renave_operations.serpro_query_window (
  scope text not null,
  scope_key bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  primary key (scope, scope_key),
  constraint serpro_query_window_scope check (
    scope in ('global', 'tenant', 'actor')
  ),
  constraint serpro_query_window_key check (
    pg_catalog.octet_length(scope_key) = 32
  ),
  constraint serpro_query_window_count check (request_count >= 0)
);

create table renave_operations.serpro_query_lease (
  lease_id uuid primary key,
  tenant_key bytea not null,
  actor_key bytea not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  constraint serpro_query_lease_tenant_key check (
    pg_catalog.octet_length(tenant_key) = 32
  ),
  constraint serpro_query_lease_actor_key check (
    pg_catalog.octet_length(actor_key) = 32
  ),
  constraint serpro_query_lease_expiry check (expires_at > acquired_at)
);

create index serpro_query_lease_expiry_idx
  on renave_operations.serpro_query_lease (expires_at);
create index serpro_query_lease_tenant_idx
  on renave_operations.serpro_query_lease (tenant_key, expires_at);
create index serpro_query_lease_actor_idx
  on renave_operations.serpro_query_lease (actor_key, expires_at);

revoke all on renave_operations.serpro_query_policy,
  renave_operations.serpro_query_window,
  renave_operations.serpro_query_lease
from public, renave_app, renave_identity_app, renave_maintenance_app;

create function renave_runtime.acquire_serpro_query_permit(
  p_lease_id uuid,
  p_tenant_key bytea,
  p_actor_key bytea
)
returns table (
  allowed boolean,
  limited_scope text,
  retry_after_seconds integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy renave_operations.serpro_query_policy%rowtype;
  now_at timestamptz := pg_catalog.clock_timestamp();
  global_key constant bytea := pg_catalog.decode(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  );
  global_count integer;
  tenant_count integer;
  actor_count integer;
  global_started timestamptz;
  tenant_started timestamptz;
  actor_started timestamptz;
  active_global integer;
  active_tenant integer;
  active_actor integer;
  retry_seconds integer;
begin
  if p_lease_id is null
     or p_tenant_key is null
     or p_actor_key is null
     or pg_catalog.octet_length(p_tenant_key) <> 32
     or pg_catalog.octet_length(p_actor_key) <> 32 then
    raise exception 'chaves do limite SERPRO inválidas'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into strict policy
    from renave_operations.serpro_query_policy
   where singleton = true
   for update;

  delete from renave_operations.serpro_query_lease lease
   where lease.expires_at <= now_at;

  insert into renave_operations.serpro_query_window (
    scope, scope_key, window_started_at, request_count
  ) values
    ('global', global_key, now_at, 0),
    ('tenant', p_tenant_key, now_at, 0),
    ('actor', p_actor_key, now_at, 0)
  on conflict (scope, scope_key) do nothing;

  update renave_operations.serpro_query_window rate_window
     set window_started_at = now_at, request_count = 0
   where rate_window.window_started_at + policy.window_size <= now_at
     and (
       (rate_window.scope = 'global' and rate_window.scope_key = global_key)
       or (rate_window.scope = 'tenant' and rate_window.scope_key = p_tenant_key)
       or (rate_window.scope = 'actor' and rate_window.scope_key = p_actor_key)
     );

  select rate_window.request_count, rate_window.window_started_at
    into strict global_count, global_started
    from renave_operations.serpro_query_window rate_window
   where rate_window.scope = 'global' and rate_window.scope_key = global_key;
  select rate_window.request_count, rate_window.window_started_at
    into strict tenant_count, tenant_started
    from renave_operations.serpro_query_window rate_window
   where rate_window.scope = 'tenant' and rate_window.scope_key = p_tenant_key;
  select rate_window.request_count, rate_window.window_started_at
    into strict actor_count, actor_started
    from renave_operations.serpro_query_window rate_window
   where rate_window.scope = 'actor' and rate_window.scope_key = p_actor_key;

  if global_count >= policy.global_per_window then
    retry_seconds := greatest(1, pg_catalog.ceil(extract(epoch from (
      global_started + policy.window_size - now_at
    )))::integer);
    return query select false, 'global_rate'::text, retry_seconds;
    return;
  end if;
  if tenant_count >= policy.tenant_per_window then
    retry_seconds := greatest(1, pg_catalog.ceil(extract(epoch from (
      tenant_started + policy.window_size - now_at
    )))::integer);
    return query select false, 'tenant_rate'::text, retry_seconds;
    return;
  end if;
  if actor_count >= policy.actor_per_window then
    retry_seconds := greatest(1, pg_catalog.ceil(extract(epoch from (
      actor_started + policy.window_size - now_at
    )))::integer);
    return query select false, 'actor_rate'::text, retry_seconds;
    return;
  end if;

  select pg_catalog.count(*)::integer into active_global
    from renave_operations.serpro_query_lease lease
   where lease.expires_at > now_at;
  select pg_catalog.count(*)::integer into active_tenant
    from renave_operations.serpro_query_lease lease
   where lease.tenant_key = p_tenant_key and lease.expires_at > now_at;
  select pg_catalog.count(*)::integer into active_actor
    from renave_operations.serpro_query_lease lease
   where lease.actor_key = p_actor_key and lease.expires_at > now_at;

  if active_global >= policy.global_concurrency then
    select greatest(1, pg_catalog.ceil(extract(epoch from (
      pg_catalog.min(lease.expires_at) - now_at
    )))::integer) into retry_seconds
      from renave_operations.serpro_query_lease lease
     where lease.expires_at > now_at;
    return query select false, 'global_concurrency'::text, retry_seconds;
    return;
  end if;
  if active_tenant >= policy.tenant_concurrency then
    select greatest(1, pg_catalog.ceil(extract(epoch from (
      pg_catalog.min(lease.expires_at) - now_at
    )))::integer) into retry_seconds
      from renave_operations.serpro_query_lease lease
     where lease.tenant_key = p_tenant_key and lease.expires_at > now_at;
    return query select false, 'tenant_concurrency'::text, retry_seconds;
    return;
  end if;
  if active_actor >= policy.actor_concurrency then
    select greatest(1, pg_catalog.ceil(extract(epoch from (
      pg_catalog.min(lease.expires_at) - now_at
    )))::integer) into retry_seconds
      from renave_operations.serpro_query_lease lease
     where lease.actor_key = p_actor_key and lease.expires_at > now_at;
    return query select false, 'actor_concurrency'::text, retry_seconds;
    return;
  end if;

  update renave_operations.serpro_query_window rate_window
     set request_count = rate_window.request_count + 1
   where (rate_window.scope = 'global' and rate_window.scope_key = global_key)
      or (rate_window.scope = 'tenant' and rate_window.scope_key = p_tenant_key)
      or (rate_window.scope = 'actor' and rate_window.scope_key = p_actor_key);

  insert into renave_operations.serpro_query_lease (
    lease_id, tenant_key, actor_key, acquired_at, expires_at
  ) values (
    p_lease_id, p_tenant_key, p_actor_key, now_at, now_at + policy.lease_ttl
  );

  return query select true, null::text, 0;
end
$$;

create function renave_runtime.release_serpro_query_permit(
  p_lease_id uuid,
  p_actor_key bytea
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  with released as (
    delete from renave_operations.serpro_query_lease lease
     where lease.lease_id = p_lease_id
       and lease.actor_key = p_actor_key
    returning 1
  )
  select exists (select 1 from released)
$$;

revoke all on function
  renave_runtime.acquire_serpro_query_permit(uuid, bytea, bytea),
  renave_runtime.release_serpro_query_permit(uuid, bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function
  renave_runtime.acquire_serpro_query_permit(uuid, bytea, bytea),
  renave_runtime.release_serpro_query_permit(uuid, bytea)
to renave_app;

create or replace function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.count(*) = 4
    from renave.schema_migrations migrations
   where migrations.version = any (
     array[
       '0009_tenant_directory',
       '0010_protected_evidence_operations',
       '0011_login_rate_limit',
       '0013_serpro_query_limit'
     ]::text[]
   )
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
