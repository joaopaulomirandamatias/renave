-- 0068 — Limite distribuído anterior à leitura auditada do console global.

alter function renave_runtime.api_contract_ready()
  rename to identity_recent_mfa_contract_ready_v0067;
revoke all on function renave_runtime.identity_recent_mfa_contract_ready_v0067()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create schema renave_platform_rate;
revoke all on schema renave_platform_rate from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,renave_platform_reader,
  renave_platform_provisioner;

create table renave_platform_rate.queue_bucket (
  scope text not null,
  actor_digest bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  primary key (scope,actor_digest),
  constraint platform_rate_scope_valid check (scope in ('global','actor')),
  constraint platform_rate_actor_digest_valid
    check (octet_length(actor_digest)=32),
  constraint platform_rate_request_count_valid
    check (request_count>=0 and request_count<=120),
  constraint platform_rate_global_digest_valid check (
    scope<>'global' or actor_digest=decode(repeat('00',32),'hex')
  )
);
revoke all on table renave_platform_rate.queue_bucket
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.acquire_platform_console_permit(
  p_actor_digest bytea
)
returns table (allowed boolean,retry_after_seconds integer)
language plpgsql security definer set search_path=pg_catalog as $$
declare
  now_at timestamptz := clock_timestamp();
  global_digest bytea := decode(repeat('00',32),'hex');
  global_started timestamptz;
  global_count integer;
  actor_started timestamptz;
  actor_count integer;
  global_retry integer;
  actor_retry integer;
begin
  if session_user<>'renave_platform_reader'
     or current_user<>'renave_migrator'
     or p_actor_digest is null or octet_length(p_actor_digest)<>32
     or not coalesce(renave_runtime.api_contract_ready(),false) then
    raise exception 'platform rate limit: acesso negado'
      using errcode='insufficient_privilege';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('renave.platform.rate.global',6801));
  perform pg_advisory_xact_lock(
    hashtextextended(encode(p_actor_digest,'hex'),6802));

  insert into renave_platform_rate.queue_bucket (
    scope,actor_digest,window_started_at,request_count
  ) values ('global',global_digest,now_at,0),('actor',p_actor_digest,now_at,0)
  on conflict do nothing;

  select bucket.window_started_at,bucket.request_count
    into global_started,global_count
    from renave_platform_rate.queue_bucket bucket
    where bucket.scope='global' and bucket.actor_digest=global_digest
    for update;
  select bucket.window_started_at,bucket.request_count
    into actor_started,actor_count
    from renave_platform_rate.queue_bucket bucket
    where bucket.scope='actor' and bucket.actor_digest=p_actor_digest
    for update;

  if global_started+interval '60 seconds'<=now_at then
    global_started:=now_at;
    global_count:=0;
  end if;
  if actor_started+interval '60 seconds'<=now_at then
    actor_started:=now_at;
    actor_count:=0;
  end if;

  global_retry:=greatest(1,ceil(extract(epoch from
    global_started+interval '60 seconds'-now_at))::integer);
  actor_retry:=greatest(1,ceil(extract(epoch from
    actor_started+interval '60 seconds'-now_at))::integer);

  if global_count>=120 or actor_count>=30 then
    update renave_platform_rate.queue_bucket
       set window_started_at=global_started,request_count=global_count
     where scope='global' and actor_digest=global_digest;
    update renave_platform_rate.queue_bucket
       set window_started_at=actor_started,request_count=actor_count
     where scope='actor' and actor_digest=p_actor_digest;
    allowed:=false;
    retry_after_seconds:=case when global_count>=120
      then global_retry else actor_retry end;
    return next;
    return;
  end if;

  update renave_platform_rate.queue_bucket
     set window_started_at=global_started,request_count=global_count+1
   where scope='global' and actor_digest=global_digest;
  update renave_platform_rate.queue_bucket
     set window_started_at=actor_started,request_count=actor_count+1
   where scope='actor' and actor_digest=p_actor_digest;
  allowed:=true;
  retry_after_seconds:=0;
  return next;
end
$$;
revoke all on function
  renave_runtime.acquire_platform_console_permit(bytea)
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function
  renave_runtime.acquire_platform_console_permit(bytea)
to renave_platform_reader;

create function renave_runtime.platform_rate_catalog_fingerprint_v0068()
returns text language sql stable security definer set search_path=pg_catalog as $$
select encode(sha256(convert_to(jsonb_build_object(
  'previous',renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067(),
  'schema',coalesce((select jsonb_agg(jsonb_build_array(
      namespace.nspname,owner.rolname,coalesce(namespace.nspacl::text,'')))
    from pg_namespace namespace join pg_roles owner
      on owner.oid=namespace.nspowner
    where namespace.nspname='renave_platform_rate'),'[]'::jsonb),
  'tables',coalesce((select jsonb_agg(jsonb_build_array(
      relation.relname,relation.relkind,relation.relpersistence,
      owner.rolname,coalesce(relation.relacl::text,'')) order by relation.relname)
    from pg_class relation join pg_namespace namespace
      on namespace.oid=relation.relnamespace
      join pg_roles owner on owner.oid=relation.relowner
    where namespace.nspname='renave_platform_rate'),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(
      relation.relname,column_item.attnum,column_item.attname,
      format_type(column_item.atttypid,column_item.atttypmod),
      column_item.attnotnull,coalesce(column_item.attacl::text,''))
      order by relation.relname,column_item.attnum)
    from pg_class relation join pg_namespace namespace
      on namespace.oid=relation.relnamespace
      join pg_attribute column_item
        on column_item.attrelid=relation.oid and column_item.attnum>0
    where namespace.nspname='renave_platform_rate'
      and relation.relkind in ('r','p')),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(
      relation.relname,constraint_item.conname,constraint_item.contype,
      constraint_item.convalidated,
      pg_get_constraintdef(constraint_item.oid,false))
      order by relation.relname,constraint_item.conname)
    from pg_constraint constraint_item join pg_class relation
      on relation.oid=constraint_item.conrelid
      join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='renave_platform_rate'),'[]'::jsonb),
  'function',coalesce((select jsonb_agg(jsonb_build_array(
      function_item.proname,
      pg_get_function_identity_arguments(function_item.oid),
      pg_get_function_result(function_item.oid),function_item.prosecdef,
      function_item.provolatile,owner.rolname,
      coalesce(function_item.proconfig::text,''),
      coalesce(function_item.proacl::text,''),
      encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')))
    from pg_proc function_item join pg_namespace namespace
      on namespace.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
    where namespace.nspname='renave_runtime'
      and function_item.proname='acquire_platform_console_permit'),
    '[]'::jsonb)
)::text,'UTF8')),'hex')
$$;
revoke all on function
  renave_runtime.platform_rate_catalog_fingerprint_v0068()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select renave_runtime.identity_recent_mfa_contract_ready_v0067()
  and renave_runtime.platform_rate_catalog_fingerprint_v0068()=
    'c76c7287f34425a70b8e83e7d1fa1db1fc5a2d0f3c9aead1e5f323c489c450c7'
  and has_schema_privilege(
    'renave_platform_reader','renave_runtime','USAGE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_runtime','CREATE')
  and not has_schema_privilege(
    'renave_platform_provisioner','renave_runtime','USAGE')
  and not has_schema_privilege(
    'renave_platform_provisioner','renave_runtime','CREATE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_platform_rate','USAGE')
  and not has_schema_privilege(
    'renave_platform_provisioner','renave_platform_rate','USAGE')
  and not exists (
    select 1 from information_schema.table_privileges privilege
    where privilege.table_schema='renave_platform_rate'
      and privilege.grantee in
        ('renave_platform_reader','renave_platform_provisioner')
  )
  and has_function_privilege('renave_platform_reader',
    'renave_runtime.acquire_platform_console_permit(bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_provisioner',
    'renave_runtime.acquire_platform_console_permit(bytea)','EXECUTE')
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
