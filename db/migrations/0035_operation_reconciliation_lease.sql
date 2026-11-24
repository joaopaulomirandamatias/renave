-- 0035 — Claim/lease fechado para reconciliação, ainda sem worker ou rede.
--
-- Estas funções permanecem owner-only e nunca leem o envelope da operação.
-- Como não tocam SEND, usam o sufixo seguro da ordem global:
-- RECONCILE -> operação -> tenant -> estabelecimento.

create function renave.claim_operation_reconciliation_leases(
  p_lease_owner uuid,
  p_limit integer
)
returns table (
  outbox_id uuid,
  operation_id uuid,
  operation_version bigint,
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
    raise exception 'operation reconciliation lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_lease_owner is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'operation reconciliation lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from renave.tenant tenant
     where tenant.id = active_tenant and tenant.status = 'active'
  ) then
    raise exception 'operation reconciliation lease: tenant indisponível'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with candidates as materialized (
    select reconcile.id, reconcile.operation_id, operation.version,
           case when reconcile.delivery_status = 'READY'
             then reconcile.available_at else reconcile.lease_expires_at
           end as priority_at,
           reconcile.created_at
      from renave.operation_outbox reconcile
      join renave.operation operation
        on operation.tenant_id = reconcile.tenant_id
       and operation.id = reconcile.operation_id
      join renave.establishment establishment
        on establishment.tenant_id = operation.tenant_id
       and establishment.id = operation.establishment_id
     where reconcile.tenant_id = active_tenant
       and reconcile.event_type = 'RECONCILE'
       and operation.status = 'PENDING_RECONCILIATION'
       and establishment.status = 'active'
       and (
         (reconcile.delivery_status = 'READY'
          and reconcile.available_at <= claim_now)
         or
         (reconcile.delivery_status = 'LEASED'
          and reconcile.lease_expires_at <= claim_now)
       )
     order by
       case when reconcile.delivery_status = 'READY'
         then reconcile.available_at else reconcile.lease_expires_at
       end,
       reconcile.created_at,
       reconcile.id
     for update of reconcile skip locked
     limit p_limit
  ),
  claimed as (
    update renave.operation_outbox reconcile
       set delivery_status = 'LEASED',
           lease_owner = p_lease_owner,
           lease_token = gen_random_uuid(),
           lease_expires_at = claim_now + interval '300 seconds',
           attempt_count = reconcile.attempt_count + 1,
           last_error_code = null,
           updated_at = claim_now
      from candidates
     where reconcile.tenant_id = active_tenant
       and reconcile.id = candidates.id
    returning reconcile.id, reconcile.operation_id,
              candidates.version, reconcile.attempt_count,
              reconcile.lease_token, reconcile.lease_expires_at,
              candidates.priority_at, candidates.created_at
  )
  select claimed.id, claimed.operation_id, claimed.version,
         claimed.attempt_count, claimed.lease_token,
         claimed.lease_expires_at
    from claimed
   order by claimed.priority_at, claimed.created_at, claimed.id;
end;
$$;

create function renave.renew_operation_reconciliation_lease(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_reconcile record;
  pending_operation record;
  reconciliation_tenant record;
  reconciliation_establishment record;
  renew_now timestamptz;
begin
  if active_tenant is null then
    raise exception 'operation reconciliation lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1 then
    raise exception 'operation reconciliation lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select reconcile.id, reconcile.operation_id, reconcile.event_type,
         reconcile.delivery_status, reconcile.lease_owner,
         reconcile.lease_token, reconcile.lease_expires_at
    into claimed_reconcile
    from renave.operation_outbox reconcile
   where reconcile.tenant_id = active_tenant and reconcile.id = p_outbox_id
   for update;
  if not found then return false; end if;
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token then
    return false;
  end if;

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation lease: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select tenant.id, tenant.status into reconciliation_tenant
    from renave.tenant tenant where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation reconciliation lease: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select establishment.id, establishment.status
    into reconciliation_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation reconciliation lease: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  renew_now := pg_catalog.clock_timestamp();
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token
     or claimed_reconcile.lease_expires_at is null
     or claimed_reconcile.lease_expires_at <= renew_now
     or pending_operation.status <> 'PENDING_RECONCILIATION'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version
     or reconciliation_tenant.status <> 'active'
     or reconciliation_establishment.status <> 'active' then
    return false;
  end if;

  update renave.operation_outbox reconcile
     set lease_expires_at = renew_now + interval '300 seconds',
         updated_at = renew_now
   where reconcile.tenant_id = active_tenant
     and reconcile.id = claimed_reconcile.id;
  return true;
end;
$$;

create function renave.release_operation_reconciliation_lease(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint,
  p_retry_delay_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_reconcile record;
  pending_operation record;
  release_now timestamptz;
begin
  if active_tenant is null then
    raise exception 'operation reconciliation lease: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1
     or p_retry_delay_seconds is null
     or p_retry_delay_seconds < 0
     or p_retry_delay_seconds > 86400 then
    raise exception 'operation reconciliation lease: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select reconcile.id, reconcile.operation_id, reconcile.event_type,
         reconcile.delivery_status, reconcile.lease_owner,
         reconcile.lease_token, reconcile.lease_expires_at
    into claimed_reconcile
    from renave.operation_outbox reconcile
   where reconcile.tenant_id = active_tenant and reconcile.id = p_outbox_id
   for update;
  if not found then return false; end if;
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token then
    return false;
  end if;

  select operation.id, operation.status, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation lease: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  release_now := pg_catalog.clock_timestamp();
  if claimed_reconcile.lease_expires_at is null
     or claimed_reconcile.lease_expires_at <= release_now
     or pending_operation.status <> 'PENDING_RECONCILIATION'
     or pending_operation.version <> p_expected_operation_version then
    return false;
  end if;

  update renave.operation_outbox reconcile
     set delivery_status = 'READY',
         available_at = release_now
           + pg_catalog.make_interval(secs => p_retry_delay_seconds),
         lease_owner = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = 'RECONCILIATION_RELEASED',
         updated_at = release_now
   where reconcile.tenant_id = active_tenant
     and reconcile.id = claimed_reconcile.id;
  return true;
end;
$$;

create function renave.begin_operation_reconciliation(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint
)
returns table (
  outbox_id uuid,
  operation_id uuid,
  establishment_id uuid,
  correlation_id uuid,
  kind text,
  mutation_family text,
  operation_version bigint,
  sent_at timestamptz,
  attempt_count integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_reconcile record;
  pending_operation record;
  reconciliation_tenant record;
  reconciliation_establishment record;
  begun_reconcile record;
  begin_now timestamptz;
begin
  if active_tenant is null then
    raise exception 'operation reconciliation: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1 then
    raise exception 'operation reconciliation: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select reconcile.id, reconcile.operation_id, reconcile.event_type,
         reconcile.delivery_status, reconcile.attempt_count,
         reconcile.lease_owner, reconcile.lease_token,
         reconcile.lease_expires_at
    into claimed_reconcile
    from renave.operation_outbox reconcile
   where reconcile.tenant_id = active_tenant and reconcile.id = p_outbox_id
   for update;
  if not found then return; end if;
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token then
    return;
  end if;

  select operation.id, operation.establishment_id, operation.correlation_id,
         operation.kind, operation.mutation_family, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select tenant.id, tenant.status into reconciliation_tenant
    from renave.tenant tenant where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation reconciliation: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select establishment.id, establishment.status
    into reconciliation_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation reconciliation: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- O relógio é capturado após os locks administrativos para fechar TOCTOU.
  begin_now := pg_catalog.clock_timestamp();
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token
     or claimed_reconcile.lease_expires_at is null
     or claimed_reconcile.lease_expires_at <= begin_now
     or pending_operation.status <> 'PENDING_RECONCILIATION'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version
     or reconciliation_tenant.status <> 'active'
     or reconciliation_establishment.status <> 'active' then
    return;
  end if;

  update renave.operation_outbox reconcile
     set lease_expires_at = begin_now + interval '300 seconds',
         updated_at = begin_now
   where reconcile.tenant_id = active_tenant
     and reconcile.id = claimed_reconcile.id
  returning reconcile.id, reconcile.attempt_count,
            reconcile.lease_expires_at
       into begun_reconcile;

  return query select
    begun_reconcile.id, pending_operation.id,
    pending_operation.establishment_id, pending_operation.correlation_id,
    pending_operation.kind, pending_operation.mutation_family,
    pending_operation.version, pending_operation.sent_at,
    begun_reconcile.attempt_count, begun_reconcile.lease_expires_at;
end;
$$;

revoke all on function renave.claim_operation_reconciliation_leases(uuid, integer)
from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.renew_operation_reconciliation_lease(
  uuid, uuid, uuid, bigint
) from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.release_operation_reconciliation_lease(
  uuid, uuid, uuid, bigint, integer
) from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.begin_operation_reconciliation(
  uuid, uuid, uuid, bigint
) from public, renave_app, renave_identity_app, renave_maintenance_app;
