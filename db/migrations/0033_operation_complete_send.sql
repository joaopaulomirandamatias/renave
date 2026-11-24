-- 0033 — Conclusão fenced de uma tentativa SEND já iniciada.
--
-- As três funções permanecem owner-only. Elas registram somente o desfecho
-- observado pelo futuro worker; não chamam rede e nunca leem o envelope.

create function renave.complete_operation_send_confirmed(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint,
  p_remote_record_id bigint,
  p_remote_state text
)
returns table (
  operation_id uuid,
  send_outbox_id uuid,
  operation_version bigint,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_send record;
  existing_reconcile record;
  pending_operation record;
  completed_operation record;
  completed_send_id uuid;
  has_reconcile boolean;
  completion_now timestamptz;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:send-outcome:v1', 'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null
     or p_lease_owner is null
     or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1
     or p_remote_record_id is null
     or p_remote_record_id < 1
     or p_remote_record_id > 9007199254740991
     or p_remote_state is null
     or p_remote_state not in (
       'SOLICITADO', 'TRANSFERIDO', 'CONFIRMADO', 'FINALIZADO'
     ) then
    raise exception 'operation completion: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Ordem global: SEND -> RECONCILE -> operação -> tenant -> estabelecimento.
  select send_outbox.id, send_outbox.operation_id, send_outbox.event_type,
         send_outbox.delivery_status, send_outbox.lease_owner,
         send_outbox.lease_token, send_outbox.lease_expires_at
    into claimed_send
    from renave.operation_outbox send_outbox
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = p_outbox_id
   for update;
  if not found then
    return;
  end if;
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token then
    return;
  end if;

  existing_reconcile := null;
  select reconcile_outbox.id, reconcile_outbox.delivery_status
    into existing_reconcile
    from renave.operation_outbox reconcile_outbox
   where reconcile_outbox.tenant_id = active_tenant
     and reconcile_outbox.operation_id = claimed_send.operation_id
     and reconcile_outbox.event_type = 'RECONCILE'
   for update;
  has_reconcile := found;

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_send.operation_id
   for update;
  if not found then
    raise exception 'operation completion: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform tenant.id
    from renave.tenant tenant
   where tenant.id = active_tenant
   for share;
  if not found then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform establishment.id
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation completion: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Capturado após todos os locks: lease na borda ou já vencida é tardia.
  completion_now := pg_catalog.clock_timestamp();
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token
     or claimed_send.lease_expires_at is null
     or claimed_send.lease_expires_at <= completion_now
     or pending_operation.status <> 'SENT'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version then
    return;
  end if;
  if has_reconcile and existing_reconcile.delivery_status <> 'COMPLETED' then
    raise exception 'operation completion: reconciliação já ativa'
      using errcode = 'integrity_constraint_violation';
  end if;

  update renave.operation operation
     set status = 'CONFIRMED',
         version = pending_operation.version + 1,
         finalized_at = completion_now,
         last_error_code = null,
         remote_record_id = p_remote_record_id,
         remote_state = p_remote_state,
         updated_at = completion_now
   where operation.tenant_id = active_tenant
     and operation.id = pending_operation.id
  returning operation.id, operation.version into completed_operation;

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, completed_operation.id, completed_operation.version,
    'SENT', 'CONFIRMED', 'RENAVE_CONFIRMED', system_actor, completion_now
  );

  update renave.operation_outbox send_outbox
     set delivery_status = 'COMPLETED',
         lease_owner = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = null,
         completed_at = completion_now,
         updated_at = completion_now
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = claimed_send.id
  returning send_outbox.id into completed_send_id;

  return query select completed_operation.id, completed_send_id,
                      completed_operation.version, completion_now;
end;
$$;

create function renave.complete_operation_send_rejected(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint,
  p_http_status integer
)
returns table (
  operation_id uuid,
  send_outbox_id uuid,
  operation_version bigint,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_send record;
  existing_reconcile record;
  pending_operation record;
  completed_operation record;
  completed_send_id uuid;
  has_reconcile boolean;
  completion_now timestamptz;
  rejection_code text;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:send-outcome:v1', 'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null
     or p_lease_owner is null
     or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1
     or p_http_status is null
     or p_http_status < 400
     or p_http_status > 499 then
    raise exception 'operation completion: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;
  rejection_code := 'RENAVE_HTTP_' || p_http_status::text;

  select send_outbox.id, send_outbox.operation_id, send_outbox.event_type,
         send_outbox.delivery_status, send_outbox.lease_owner,
         send_outbox.lease_token, send_outbox.lease_expires_at
    into claimed_send
    from renave.operation_outbox send_outbox
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = p_outbox_id
   for update;
  if not found then
    return;
  end if;
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token then
    return;
  end if;

  existing_reconcile := null;
  select reconcile_outbox.id, reconcile_outbox.delivery_status
    into existing_reconcile
    from renave.operation_outbox reconcile_outbox
   where reconcile_outbox.tenant_id = active_tenant
     and reconcile_outbox.operation_id = claimed_send.operation_id
     and reconcile_outbox.event_type = 'RECONCILE'
   for update;
  has_reconcile := found;

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_send.operation_id
   for update;
  if not found then
    raise exception 'operation completion: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform tenant.id from renave.tenant tenant
   where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  perform establishment.id from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id for share;
  if not found then
    raise exception 'operation completion: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  completion_now := pg_catalog.clock_timestamp();
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token
     or claimed_send.lease_expires_at is null
     or claimed_send.lease_expires_at <= completion_now
     or pending_operation.status <> 'SENT'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version then
    return;
  end if;
  if has_reconcile and existing_reconcile.delivery_status <> 'COMPLETED' then
    raise exception 'operation completion: reconciliação já ativa'
      using errcode = 'integrity_constraint_violation';
  end if;

  update renave.operation operation
     set status = 'REJECTED',
         version = pending_operation.version + 1,
         finalized_at = completion_now,
         last_error_code = rejection_code,
         remote_record_id = null,
         remote_state = null,
         updated_at = completion_now
   where operation.tenant_id = active_tenant
     and operation.id = pending_operation.id
  returning operation.id, operation.version into completed_operation;

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, completed_operation.id, completed_operation.version,
    'SENT', 'REJECTED', 'RENAVE_REJECTED', system_actor, completion_now
  );

  update renave.operation_outbox send_outbox
     set delivery_status = 'COMPLETED', lease_owner = null,
         lease_token = null, lease_expires_at = null,
         last_error_code = rejection_code, completed_at = completion_now,
         updated_at = completion_now
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = claimed_send.id
  returning send_outbox.id into completed_send_id;

  return query select completed_operation.id, completed_send_id,
                      completed_operation.version, completion_now;
end;
$$;

create function renave.complete_operation_send_outcome_unknown(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint
)
returns table (
  operation_id uuid,
  send_outbox_id uuid,
  reconcile_outbox_id uuid,
  operation_version bigint,
  completed_at timestamptz,
  reconcile_available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_send record;
  existing_reconcile record;
  pending_operation record;
  completed_operation record;
  completed_send_id uuid;
  scheduled_reconcile record;
  has_reconcile boolean;
  completion_now timestamptz;
  reconcile_at timestamptz;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:send-outcome:v1', 'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null
     or p_lease_owner is null
     or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1 then
    raise exception 'operation completion: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select send_outbox.id, send_outbox.operation_id, send_outbox.event_type,
         send_outbox.delivery_status, send_outbox.lease_owner,
         send_outbox.lease_token, send_outbox.lease_expires_at
    into claimed_send
    from renave.operation_outbox send_outbox
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = p_outbox_id
   for update;
  if not found then
    return;
  end if;
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token then
    return;
  end if;

  existing_reconcile := null;
  select reconcile_outbox.id, reconcile_outbox.delivery_status
    into existing_reconcile
    from renave.operation_outbox reconcile_outbox
   where reconcile_outbox.tenant_id = active_tenant
     and reconcile_outbox.operation_id = claimed_send.operation_id
     and reconcile_outbox.event_type = 'RECONCILE'
   for update;
  has_reconcile := found;

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_send.operation_id
   for update;
  if not found then
    raise exception 'operation completion: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform tenant.id from renave.tenant tenant
   where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation completion: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  perform establishment.id from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id for share;
  if not found then
    raise exception 'operation completion: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  completion_now := pg_catalog.clock_timestamp();
  if claimed_send.event_type <> 'SEND_MUTATION'
     or claimed_send.delivery_status <> 'LEASED'
     or claimed_send.lease_owner is distinct from p_lease_owner
     or claimed_send.lease_token is distinct from p_lease_token
     or claimed_send.lease_expires_at is null
     or claimed_send.lease_expires_at <= completion_now
     or pending_operation.status <> 'SENT'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version then
    return;
  end if;
  if has_reconcile and existing_reconcile.delivery_status <> 'COMPLETED' then
    raise exception 'operation completion: reconciliação já ativa'
      using errcode = 'integrity_constraint_violation';
  end if;

  reconcile_at := greatest(
    completion_now, pending_operation.sent_at + interval '60 seconds'
  );
  update renave.operation operation
     set status = 'PENDING_RECONCILIATION',
         version = pending_operation.version + 1,
         finalized_at = null,
         last_error_code = 'RENAVE_MUTATION_OUTCOME_UNKNOWN',
         remote_record_id = null,
         remote_state = null,
         updated_at = completion_now
   where operation.tenant_id = active_tenant
     and operation.id = pending_operation.id
  returning operation.id, operation.version into completed_operation;

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, completed_operation.id, completed_operation.version,
    'SENT', 'PENDING_RECONCILIATION',
    'RENAVE_MUTATION_OUTCOME_UNKNOWN', system_actor, completion_now
  );

  update renave.operation_outbox send_outbox
     set delivery_status = 'COMPLETED', lease_owner = null,
         lease_token = null, lease_expires_at = null,
         last_error_code = 'RENAVE_MUTATION_OUTCOME_UNKNOWN',
         completed_at = completion_now, updated_at = completion_now
   where send_outbox.tenant_id = active_tenant
     and send_outbox.id = claimed_send.id
  returning send_outbox.id into completed_send_id;

  if has_reconcile then
    update renave.operation_outbox reconcile_outbox
       set delivery_status = 'READY', available_at = reconcile_at,
           lease_owner = null, lease_token = null, lease_expires_at = null,
           last_error_code = null, completed_at = null,
           updated_at = completion_now
     where reconcile_outbox.tenant_id = active_tenant
       and reconcile_outbox.id = existing_reconcile.id
       and reconcile_outbox.delivery_status = 'COMPLETED'
    returning reconcile_outbox.id, reconcile_outbox.available_at
      into scheduled_reconcile;
  else
    insert into renave.operation_outbox (
      tenant_id, operation_id, event_type, delivery_status,
      available_at, updated_at
    ) values (
      active_tenant, completed_operation.id, 'RECONCILE', 'READY',
      reconcile_at, completion_now
    ) returning operation_outbox.id, operation_outbox.available_at
      into scheduled_reconcile;
  end if;
  if scheduled_reconcile.id is null then
    raise exception 'operation completion: reconciliação não agendada'
      using errcode = 'integrity_constraint_violation';
  end if;

  return query select completed_operation.id, completed_send_id,
                      scheduled_reconcile.id, completed_operation.version,
                      completion_now, scheduled_reconcile.available_at;
end;
$$;

revoke all on function renave.complete_operation_send_confirmed(
  uuid, uuid, uuid, bigint, bigint, text
) from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.complete_operation_send_rejected(
  uuid, uuid, uuid, bigint, integer
) from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.complete_operation_send_outcome_unknown(
  uuid, uuid, uuid, bigint
) from public, renave_app, renave_identity_app, renave_maintenance_app;
