-- 0027 — Claim/lease fechado da outbox, ainda sem capacidade de despacho.
--
-- As funções abaixo não retornam o envelope cifrado e não são concedidas a
-- nenhum papel de runtime. Elas materializam e testam somente o fencing de
-- concorrência que antecederá um futuro beginDispatch atômico.

create unique index operation_outbox_lease_token_key
  on renave.operation_outbox (lease_token)
  where lease_token is not null;

create index operation_outbox_expired_lease_idx
  on renave.operation_outbox (
    tenant_id, event_type, lease_expires_at, created_at, id
  ) where delivery_status = 'LEASED';

create function renave.claim_operation_send_leases(
  p_lease_owner uuid,
  p_limit integer
)
returns table (
  outbox_id uuid,
  operation_id uuid,
  event_type text,
  attempt_count integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claim_now timestamptz := pg_catalog.clock_timestamp();
begin
  if active_tenant is null then
    raise exception 'operation outbox lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_lease_owner is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'operation outbox lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1
      from renave.tenant tenant
     where tenant.id = active_tenant
       and tenant.status = 'active'
  ) then
    raise exception 'operation outbox lease: tenant indisponível'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with candidates as materialized (
    select outbox.id,
           case
             when outbox.delivery_status = 'READY' then outbox.available_at
             else outbox.lease_expires_at
           end as priority_at,
           outbox.created_at
      from renave.operation_outbox outbox
      join renave.operation operation
        on operation.tenant_id = outbox.tenant_id
       and operation.id = outbox.operation_id
     where outbox.tenant_id = active_tenant
       and operation.tenant_id = active_tenant
       and outbox.event_type = 'SEND_MUTATION'
       and operation.status = 'PENDING_SEND'
       and (
         (outbox.delivery_status = 'READY'
          and outbox.available_at <= claim_now)
         or
         (outbox.delivery_status = 'LEASED'
          and outbox.lease_expires_at <= claim_now)
       )
     order by
       case
         when outbox.delivery_status = 'READY' then outbox.available_at
         else outbox.lease_expires_at
       end,
       outbox.created_at,
       outbox.id
     for update of outbox skip locked
     limit p_limit
  ),
  claimed as (
    update renave.operation_outbox outbox
       set delivery_status = 'LEASED',
           lease_owner = p_lease_owner,
           lease_token = gen_random_uuid(),
           lease_expires_at = claim_now + interval '300 seconds',
           attempt_count = outbox.attempt_count + 1,
           updated_at = claim_now
      from candidates
     where outbox.tenant_id = active_tenant
       and outbox.id = candidates.id
    returning outbox.id, outbox.operation_id, outbox.event_type,
              outbox.attempt_count, outbox.lease_token,
              outbox.lease_expires_at, candidates.priority_at,
              candidates.created_at
  )
  select claimed.id, claimed.operation_id, claimed.event_type,
         claimed.attempt_count, claimed.lease_token,
         claimed.lease_expires_at
    from claimed
   order by claimed.priority_at, claimed.created_at, claimed.id;
end;
$$;

create function renave.renew_operation_send_lease(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  renew_now timestamptz := pg_catalog.clock_timestamp();
  changed integer;
begin
  if active_tenant is null then
    raise exception 'operation outbox lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null then
    raise exception 'operation outbox lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  update renave.operation_outbox outbox
     set lease_expires_at = renew_now + interval '300 seconds',
         updated_at = renew_now
   where outbox.tenant_id = active_tenant
     and outbox.id = p_outbox_id
     and outbox.event_type = 'SEND_MUTATION'
     and outbox.delivery_status = 'LEASED'
     and outbox.lease_owner = p_lease_owner
     and outbox.lease_token = p_lease_token
     and outbox.lease_expires_at > renew_now
     and exists (
       select 1
         from renave.tenant tenant
        where tenant.id = active_tenant
          and tenant.status = 'active'
     )
     and exists (
       select 1
         from renave.operation operation
        where operation.tenant_id = active_tenant
          and operation.id = outbox.operation_id
          and operation.status = 'PENDING_SEND'
     );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create function renave.release_operation_send_lease(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_retry_delay_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  release_now timestamptz := pg_catalog.clock_timestamp();
  changed integer;
begin
  if active_tenant is null then
    raise exception 'operation outbox lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null
     or p_lease_owner is null
     or p_lease_token is null
     or p_retry_delay_seconds is null
     or p_retry_delay_seconds < 0
     or p_retry_delay_seconds > 86400 then
    raise exception 'operation outbox lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  update renave.operation_outbox outbox
     set delivery_status = 'READY',
         available_at = release_now
           + pg_catalog.make_interval(secs => p_retry_delay_seconds),
         lease_owner = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = 'PRE_DISPATCH_RELEASED',
         updated_at = release_now
   where outbox.tenant_id = active_tenant
     and outbox.id = p_outbox_id
     and outbox.event_type = 'SEND_MUTATION'
     and outbox.delivery_status = 'LEASED'
     and outbox.lease_owner = p_lease_owner
     and outbox.lease_token = p_lease_token
     and outbox.lease_expires_at > release_now
     and exists (
       select 1
         from renave.tenant tenant
        where tenant.id = active_tenant
          and tenant.status = 'active'
     )
     and exists (
       select 1
         from renave.operation operation
        where operation.tenant_id = active_tenant
          and operation.id = outbox.operation_id
          and operation.status = 'PENDING_SEND'
     );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function renave.claim_operation_send_leases(uuid, integer)
  from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.renew_operation_send_lease(uuid, uuid, uuid)
  from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.release_operation_send_lease(
  uuid, uuid, uuid, integer
) from public, renave_app, renave_identity_app, renave_maintenance_app;
