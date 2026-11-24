-- 0039 — Runtime mínimo e conclusão fenced da reconciliação RENAVE.
--
-- Não há rede, worker ou retry de POST nesta migration. O papel dedicado não
-- recebe ACL de tabela: somente EXECUTE nas seis rotinas fechadas. A ordem de
-- locks permanece RECONCILE -> operação -> tenant -> estabelecimento.

drop function renave.begin_operation_reconciliation(uuid, uuid, uuid, bigint);

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
  establishment_cnpj text,
  correlation_id uuid,
  kind text,
  mutation_family text,
  request_schema_version integer,
  operation_version bigint,
  sent_at timestamptz,
  attempt_count integer,
  lease_expires_at timestamptz,
  projection_kind text,
  projection_schema_version integer,
  projection_generation bigint,
  source_request_sha256 bytea,
  projection_size integer,
  projection_key_id text,
  projection_nonce bytea,
  projection_auth_tag bytea,
  projection_ciphertext bytea
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  claimed_reconcile record;
  pending_operation record;
  encrypted_projection record;
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
         operation.kind, operation.mutation_family,
         operation.request_schema_version, operation.request_sha256,
         operation.status, operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  select projection.projection_kind,
         projection.projection_schema_version,
         projection.projection_generation,
         projection.projection_size,
         projection.projection_key_id,
         projection.projection_nonce,
         projection.projection_auth_tag,
         projection.projection_ciphertext
    into encrypted_projection
    from renave.operation_reconciliation_projection projection
   where projection.tenant_id = active_tenant
     and projection.operation_id = pending_operation.id;
  if not found then
    raise exception 'operation reconciliation: projeção ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  select tenant.id, tenant.status into reconciliation_tenant
    from renave.tenant tenant where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation reconciliation: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select establishment.id, establishment.status, establishment.cnpj
    into reconciliation_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation reconciliation: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Capturado após os locks administrativos: suspensão ou lease na borda
  -- recusam o trabalho externo antes de expor o CNPJ/envelope ao worker.
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
            reconcile.lease_expires_at into begun_reconcile;

  return query select
    begun_reconcile.id, pending_operation.id,
    pending_operation.establishment_id,
    reconciliation_establishment.cnpj,
    pending_operation.correlation_id, pending_operation.kind,
    pending_operation.mutation_family,
    pending_operation.request_schema_version, pending_operation.version,
    pending_operation.sent_at, begun_reconcile.attempt_count,
    begun_reconcile.lease_expires_at,
    encrypted_projection.projection_kind,
    encrypted_projection.projection_schema_version,
    encrypted_projection.projection_generation,
    pending_operation.request_sha256,
    encrypted_projection.projection_size,
    encrypted_projection.projection_key_id,
    encrypted_projection.projection_nonce,
    encrypted_projection.projection_auth_tag,
    encrypted_projection.projection_ciphertext;
end;
$$;

create function renave.complete_operation_reconciliation_confirmed(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint,
  p_remote_record_id bigint,
  p_remote_state text
)
returns table (
  operation_id uuid,
  reconcile_outbox_id uuid,
  operation_version bigint,
  completed_at timestamptz
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
  completed_operation record;
  completed_outbox_id uuid;
  completion_now timestamptz;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:reconciliation-outcome:v1', 'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation reconciliation completion: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1
     or p_remote_record_id is null or p_remote_record_id < 1
     or p_remote_record_id > 9007199254740991
     or p_remote_state is null
     or p_remote_state not in (
       'SOLICITADO', 'TRANSFERIDO', 'CONFIRMADO', 'FINALIZADO'
     ) then
    raise exception 'operation reconciliation completion: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select reconcile.id, reconcile.operation_id, reconcile.event_type,
         reconcile.delivery_status, reconcile.lease_owner,
         reconcile.lease_token, reconcile.lease_expires_at
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

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation completion: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select tenant.id, tenant.status into reconciliation_tenant
    from renave.tenant tenant where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation reconciliation completion: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select establishment.id, establishment.status
    into reconciliation_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation reconciliation completion: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  completion_now := pg_catalog.clock_timestamp();
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token
     or claimed_reconcile.lease_expires_at is null
     or claimed_reconcile.lease_expires_at <= completion_now
     or pending_operation.status <> 'PENDING_RECONCILIATION'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version
     or reconciliation_tenant.status <> 'active'
     or reconciliation_establishment.status <> 'active' then
    return;
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
    'PENDING_RECONCILIATION', 'CONFIRMED',
    'RENAVE_RECONCILIATION_CONFIRMED', system_actor, completion_now
  );

  update renave.operation_outbox reconcile
     set delivery_status = 'COMPLETED',
         lease_owner = null, lease_token = null, lease_expires_at = null,
         last_error_code = null, completed_at = completion_now,
         updated_at = completion_now
   where reconcile.tenant_id = active_tenant
     and reconcile.id = claimed_reconcile.id
  returning reconcile.id into completed_outbox_id;

  return query select completed_operation.id, completed_outbox_id,
                      completed_operation.version, completion_now;
end;
$$;

create function renave.complete_operation_reconciliation_manual_review(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid,
  p_expected_operation_version bigint,
  p_reason_code text
)
returns table (
  operation_id uuid,
  reconcile_outbox_id uuid,
  operation_version bigint,
  completed_at timestamptz
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
  completed_operation record;
  completed_outbox_id uuid;
  completion_now timestamptz;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:reconciliation-outcome:v1', 'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation reconciliation completion: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null
     or p_expected_operation_version is null
     or p_expected_operation_version < 1
     or p_reason_code is null
     or p_reason_code not in (
       'RENAVE_RECONCILIATION_AMBIGUOUS',
       'RENAVE_RECONCILIATION_WINDOW_EXPIRED',
       'RENAVE_RECONCILIATION_UNRECOVERABLE'
     ) then
    raise exception 'operation reconciliation completion: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  select reconcile.id, reconcile.operation_id, reconcile.event_type,
         reconcile.delivery_status, reconcile.lease_owner,
         reconcile.lease_token, reconcile.lease_expires_at
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

  select operation.id, operation.establishment_id, operation.status,
         operation.sent_at, operation.version
    into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_reconcile.operation_id
   for update;
  if not found then
    raise exception 'operation reconciliation completion: operação ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select tenant.id, tenant.status into reconciliation_tenant
    from renave.tenant tenant where tenant.id = active_tenant for share;
  if not found then
    raise exception 'operation reconciliation completion: tenant ausente'
      using errcode = 'integrity_constraint_violation';
  end if;
  select establishment.id, establishment.status
    into reconciliation_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found then
    raise exception 'operation reconciliation completion: estabelecimento ausente'
      using errcode = 'integrity_constraint_violation';
  end if;

  completion_now := pg_catalog.clock_timestamp();
  if claimed_reconcile.event_type <> 'RECONCILE'
     or claimed_reconcile.delivery_status <> 'LEASED'
     or claimed_reconcile.lease_owner is distinct from p_lease_owner
     or claimed_reconcile.lease_token is distinct from p_lease_token
     or claimed_reconcile.lease_expires_at is null
     or claimed_reconcile.lease_expires_at <= completion_now
     or pending_operation.status <> 'PENDING_RECONCILIATION'
     or pending_operation.sent_at is null
     or pending_operation.version <> p_expected_operation_version
     or reconciliation_tenant.status <> 'active'
     or reconciliation_establishment.status <> 'active' then
    return;
  end if;

  update renave.operation operation
     set status = 'MANUAL_REVIEW',
         version = pending_operation.version + 1,
         -- MANUAL_REVIEW permanece ativo e aguarda decisão humana.
         finalized_at = null,
         last_error_code = p_reason_code,
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
    'PENDING_RECONCILIATION', 'MANUAL_REVIEW',
    p_reason_code, system_actor, completion_now
  );

  update renave.operation_outbox reconcile
     set delivery_status = 'COMPLETED',
         lease_owner = null, lease_token = null, lease_expires_at = null,
         last_error_code = p_reason_code, completed_at = completion_now,
         updated_at = completion_now
   where reconcile.tenant_id = active_tenant
     and reconcile.id = claimed_reconcile.id
  returning reconcile.id into completed_outbox_id;

  return query select completed_operation.id, completed_outbox_id,
                      completed_operation.version, completion_now;
end;
$$;

revoke all on schema renave from renave_operation_worker;
grant usage on schema renave to renave_operation_worker;

-- O worker recebe USAGE no schema de negócio para chamar as seis rotinas
-- fechadas. Remova antes os defaults EXECUTE de PUBLIC, senão helpers legados
-- no mesmo schema também seriam efetivamente invocáveis. Os grants explícitos
-- abaixo preservam o contrato já usado pela API nas funções auxiliares.
revoke execute on all functions in schema renave from public;
revoke execute on all functions in schema renave_runtime from public;
grant execute on function
  renave.cnpj_is_valid(text),
  renave.current_tenant_id(),
  renave.establishment_guard(),
  renave.normalize_cnpj(text),
  renave.protected_evidence_guard(),
  renave.touch_updated_at()
to renave_app;

revoke all on renave.operation, renave.operation_outbox,
  renave.operation_transition, renave.operation_reconciliation_projection,
  renave.tenant, renave.establishment
from renave_operation_worker;

revoke all on function renave.claim_operation_reconciliation_leases(uuid, integer),
  renave.renew_operation_reconciliation_lease(uuid, uuid, uuid, bigint),
  renave.release_operation_reconciliation_lease(uuid, uuid, uuid, bigint, integer),
  renave.begin_operation_reconciliation(uuid, uuid, uuid, bigint),
  renave.complete_operation_reconciliation_confirmed(
    uuid, uuid, uuid, bigint, bigint, text
  ),
  renave.complete_operation_reconciliation_manual_review(
    uuid, uuid, uuid, bigint, text
  )
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

grant execute on function
  renave.claim_operation_reconciliation_leases(uuid, integer),
  renave.renew_operation_reconciliation_lease(uuid, uuid, uuid, bigint),
  renave.release_operation_reconciliation_lease(uuid, uuid, uuid, bigint, integer),
  renave.begin_operation_reconciliation(uuid, uuid, uuid, bigint),
  renave.complete_operation_reconciliation_confirmed(
    uuid, uuid, uuid, bigint, bigint, text
  ),
  renave.complete_operation_reconciliation_manual_review(
    uuid, uuid, uuid, bigint, text
  )
to renave_operation_worker;
