-- 0084 — Replay local da saída antes de qualquer GET ao SERPRO.
-- O registro contém somente digests e referência local; não cria outbox.

create table renave_stock_exit_barriers.replay_registry (
  tenant_id uuid not null,
  idempotency_key_digest bytea not null,
  replay_digest bytea not null,
  operation_id uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id,idempotency_key_digest),
  foreign key (tenant_id,operation_id)
    references renave_stock_exit.operation(tenant_id,id) on delete restrict,
  constraint stock_exit_replay_idempotency_digest check (
    pg_catalog.octet_length(idempotency_key_digest)=32
  ),
  constraint stock_exit_replay_digest check (
    pg_catalog.octet_length(replay_digest)=32
  )
);

revoke all on renave_stock_exit_barriers.replay_registry
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_operation_promoter;

create function renave_stock_exit_barriers.probe_replay(
  p_idempotency_key_digest bytea,p_replay_digest bytea
)
returns table(
  state text,operation_id uuid,created_at timestamptz,request_sha256 bytea
)
language plpgsql volatile security definer set search_path=pg_catalog
as $$
declare active_tenant uuid:=renave.current_tenant_id();
begin
  if active_tenant is null
     or p_idempotency_key_digest is null
     or pg_catalog.octet_length(p_idempotency_key_digest)<>32
     or p_replay_digest is null
     or pg_catalog.octet_length(p_replay_digest)<>32 then
    raise exception 'stock exit replay: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  return query
  select case when r.replay_digest=p_replay_digest then 'MATCH' else 'CONFLICT' end,
         o.id,o.created_at,
         case when r.replay_digest=p_replay_digest then o.request_sha256 else null end
    from renave_stock_exit_barriers.replay_registry r
    join renave_stock_exit.operation o
      on (o.tenant_id,o.id)=(r.tenant_id,r.operation_id)
   where r.tenant_id=active_tenant
     and r.idempotency_key_digest=p_idempotency_key_digest
     and o.status='HELD_LOCAL';
  if not found then
    return query select 'MISSING',null::uuid,null::timestamptz,null::bytea;
  end if;
end
$$;

create function renave_stock_exit_barriers.record_replay(
  p_idempotency_key_digest bytea,p_replay_digest bytea,p_operation_id uuid
)
returns void language plpgsql volatile security definer set search_path=pg_catalog
as $$
declare active_tenant uuid:=renave.current_tenant_id();
declare stored record;
begin
  if active_tenant is null or p_operation_id is null
     or p_idempotency_key_digest is null
     or pg_catalog.octet_length(p_idempotency_key_digest)<>32
     or p_replay_digest is null
     or pg_catalog.octet_length(p_replay_digest)<>32 then
    raise exception 'stock exit replay: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  if not exists(select 1 from renave_stock_exit.operation o
      where o.tenant_id=active_tenant and o.id=p_operation_id
        and o.idempotency_key_digest=p_idempotency_key_digest
        and o.status='HELD_LOCAL') then
    raise exception 'stock exit replay: operação inválida'
      using errcode='check_violation';
  end if;
  insert into renave_stock_exit_barriers.replay_registry
    (tenant_id,idempotency_key_digest,replay_digest,operation_id)
  values(active_tenant,p_idempotency_key_digest,p_replay_digest,p_operation_id)
  on conflict(tenant_id,idempotency_key_digest) do nothing;
  select r.replay_digest,r.operation_id into strict stored
    from renave_stock_exit_barriers.replay_registry r
   where r.tenant_id=active_tenant
     and r.idempotency_key_digest=p_idempotency_key_digest
   for update;
  if stored.replay_digest<>p_replay_digest
     or stored.operation_id<>p_operation_id then
    raise exception 'stock exit replay: conflito'
      using errcode='unique_violation';
  end if;
end
$$;

revoke all on function
  renave_stock_exit_barriers.probe_replay(bytea,bytea),
  renave_stock_exit_barriers.record_replay(bytea,bytea,uuid)
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_operation_promoter;
grant execute on function
  renave_stock_exit_barriers.probe_replay(bytea,bytea),
  renave_stock_exit_barriers.record_replay(bytea,bytea,uuid)
to renave_app;
