-- 0029 — Fence durável anterior ao envio de uma mutação RENAVE.
--
-- Esta função ainda não é concedida a nenhum papel de runtime. Ela consome
-- uma lease válida, grava PENDING_SEND -> SENT e só então devolve o envelope
-- cifrado. Nenhuma chamada externa ou descriptografia acontece no banco.

create function renave.begin_operation_send_dispatch(
  p_outbox_id uuid,
  p_lease_owner uuid,
  p_lease_token uuid
)
returns table (
  outbox_id uuid,
  operation_id uuid,
  tenant_id uuid,
  establishment_id uuid,
  correlation_id uuid,
  kind text,
  mutation_family text,
  operation_version bigint,
  sent_at timestamptz,
  attempt_count integer,
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  idempotency_key_digest bytea,
  vehicle_key_digest bytea,
  actor_subject_hash bytea,
  request_sha256 bytea,
  request_size integer,
  request_schema_version integer,
  request_key_id text,
  request_nonce bytea,
  request_auth_tag bytea,
  request_ciphertext bytea
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  dispatch_now timestamptz;
  claimed_outbox renave.operation_outbox;
  pending_operation renave.operation;
  dispatch_tenant renave.tenant;
  dispatch_establishment renave.establishment;
  dispatched_operation renave.operation;
  dispatched_outbox renave.operation_outbox;
begin
  if active_tenant is null then
    raise exception 'operation dispatch: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outbox_id is null or p_lease_owner is null or p_lease_token is null then
    raise exception 'operation dispatch: parâmetros inválidos'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Ordem global de locks: outbox -> operação -> tenant -> estabelecimento.
  select outbox.* into claimed_outbox
    from renave.operation_outbox outbox
   where outbox.tenant_id = active_tenant
     and outbox.id = p_outbox_id
   for update;
  if not found then
    return;
  end if;

  select operation.* into pending_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.id = claimed_outbox.operation_id
   for update;
  if not found then
    return;
  end if;

  -- O status não entra no predicado: primeiro compartilhamos o lock da linha,
  -- depois decidimos sobre o estado confirmado pela transação administrativa.
  select tenant.* into dispatch_tenant
    from renave.tenant tenant
   where tenant.id = active_tenant
   for share;
  if not found or dispatch_tenant.status <> 'active' then
    return;
  end if;

  select establishment.* into dispatch_establishment
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = pending_operation.establishment_id
   for share;
  if not found or dispatch_establishment.status <> 'active' then
    return;
  end if;

  -- O instante é capturado após adquirir todos os locks para não aceitar uma
  -- lease que expirou enquanto a transação aguardava outra sessão.
  dispatch_now := pg_catalog.clock_timestamp();

  if claimed_outbox.event_type <> 'SEND_MUTATION'
     or claimed_outbox.delivery_status <> 'LEASED'
     or claimed_outbox.lease_owner is distinct from p_lease_owner
     or claimed_outbox.lease_token is distinct from p_lease_token
     or claimed_outbox.lease_expires_at is null
     or claimed_outbox.lease_expires_at <= dispatch_now
     or pending_operation.status <> 'PENDING_SEND' then
    return;
  end if;

  update renave.operation operation
     set status = 'SENT',
         version = pending_operation.version + 1,
         sent_at = dispatch_now,
         last_error_code = null,
         updated_at = dispatch_now
   where operation.tenant_id = active_tenant
     and operation.id = pending_operation.id
  returning operation.* into dispatched_operation;

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, dispatched_operation.id, dispatched_operation.version,
    'PENDING_SEND', 'SENT', 'DISPATCH_BEGUN',
    pending_operation.actor_subject_hash, dispatch_now
  );

  update renave.operation_outbox outbox
     set lease_expires_at = dispatch_now + interval '300 seconds',
         updated_at = dispatch_now
   where outbox.tenant_id = active_tenant
     and outbox.id = claimed_outbox.id
  returning outbox.* into dispatched_outbox;

  return query select
    dispatched_outbox.id,
    dispatched_operation.id,
    dispatched_operation.tenant_id,
    dispatched_operation.establishment_id,
    dispatched_operation.correlation_id,
    dispatched_operation.kind,
    dispatched_operation.mutation_family,
    dispatched_operation.version,
    dispatched_operation.sent_at,
    dispatched_outbox.attempt_count,
    dispatched_outbox.lease_owner,
    dispatched_outbox.lease_token,
    dispatched_outbox.lease_expires_at,
    dispatched_operation.idempotency_key_digest,
    dispatched_operation.vehicle_key_digest,
    dispatched_operation.actor_subject_hash,
    dispatched_operation.request_sha256,
    dispatched_operation.request_size,
    dispatched_operation.request_schema_version,
    dispatched_operation.request_key_id,
    dispatched_operation.request_nonce,
    dispatched_operation.request_auth_tag,
    dispatched_operation.request_ciphertext;
end;
$$;

revoke all on function renave.begin_operation_send_dispatch(uuid, uuid, uuid)
from public, renave_app, renave_identity_app, renave_maintenance_app;
