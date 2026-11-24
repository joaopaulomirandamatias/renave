-- 0031 — Recuperação durável de SEND cujo dispatch ficou sem desfecho.
--
-- A função permanece owner-only. Ela não lê o envelope, não chama rede e não
-- permite reenvio: fecha o SEND expirado e agenda reconciliação na mesma TX.

create function renave.recover_expired_operation_sends(p_limit integer)
returns table (
  operation_id uuid,
  send_outbox_id uuid,
  reconcile_outbox_id uuid,
  operation_version bigint,
  recovered_at timestamptz,
  reconcile_available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  expired_send renave.operation_outbox;
  existing_reconcile renave.operation_outbox;
  pending_operation record;
  recovered_operation record;
  completed_send renave.operation_outbox;
  scheduled_reconcile renave.operation_outbox;
  has_reconcile boolean;
  recovery_now timestamptz;
  reconcile_at timestamptz;
  system_actor bytea := pg_catalog.sha256(pg_catalog.convert_to(
    'seu-renave:system:expired-send-recovery:v1',
    'UTF8'
  ));
begin
  if active_tenant is null then
    raise exception 'operation recovery: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'operation recovery: limite inválido'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Ordem de locks por item:
  -- SEND outbox -> RECONCILE outbox existente -> operação -> tenant -> estabelecimento.
  -- Todos os outboxes ficam antes da operação para não conflitar com o futuro
  -- consumidor de RECONCILE. O instante só é capturado depois desses locks.
  for expired_send in
    select send_outbox.*
      from renave.operation_outbox send_outbox
      join renave.operation operation
        on operation.tenant_id = send_outbox.tenant_id
       and operation.id = send_outbox.operation_id
     where send_outbox.tenant_id = active_tenant
       and send_outbox.event_type = 'SEND_MUTATION'
       and send_outbox.delivery_status = 'LEASED'
       and send_outbox.lease_expires_at <= pg_catalog.clock_timestamp()
       and operation.status = 'SENT'
       and operation.sent_at is not null
     order by send_outbox.lease_expires_at,
              send_outbox.created_at,
              send_outbox.id
     for update of send_outbox skip locked
     limit p_limit
  loop
    existing_reconcile := null;
    select reconcile_outbox.* into existing_reconcile
      from renave.operation_outbox reconcile_outbox
     where reconcile_outbox.tenant_id = active_tenant
       and reconcile_outbox.operation_id = expired_send.operation_id
       and reconcile_outbox.event_type = 'RECONCILE'
     for update;
    has_reconcile := found;

    if has_reconcile
       and existing_reconcile.delivery_status <> 'COMPLETED' then
      raise exception 'operation recovery: reconciliação já ativa'
        using errcode = 'integrity_constraint_violation';
    end if;

    select operation.id, operation.establishment_id, operation.status,
           operation.sent_at, operation.version
      into pending_operation
      from renave.operation operation
     where operation.tenant_id = active_tenant
       and operation.id = expired_send.operation_id
     for update;
    if not found then
      raise exception 'operation recovery: operação ausente'
        using errcode = 'integrity_constraint_violation';
    end if;

    -- Recuperação é bookkeeping de segurança e continua permitida para tenant
    -- ou estabelecimento suspenso. Locks SHARE apenas serializam a mudança de
    -- status administrativa; nenhum status ativo é exigido aqui.
    perform tenant.id
      from renave.tenant tenant
     where tenant.id = active_tenant
     for share;
    if not found then
      raise exception 'operation recovery: tenant ausente'
        using errcode = 'integrity_constraint_violation';
    end if;

    perform establishment.id
      from renave.establishment establishment
     where establishment.tenant_id = active_tenant
       and establishment.id = pending_operation.establishment_id
     for share;
    if not found then
      raise exception 'operation recovery: estabelecimento ausente'
        using errcode = 'integrity_constraint_violation';
    end if;

    recovery_now := pg_catalog.clock_timestamp();
    if expired_send.event_type <> 'SEND_MUTATION'
       or expired_send.delivery_status <> 'LEASED'
       or expired_send.lease_expires_at is null
       or expired_send.lease_expires_at > recovery_now
       or pending_operation.status <> 'SENT'
       or pending_operation.sent_at is null then
      continue;
    end if;

    -- Nunca agenda antes da borda de consistência sent_at + 60 s. Como o
    -- recovery normalmente ocorre após a lease de 300 s, a fila fica pronta
    -- imediatamente, mas relógios e fixtures na borda continuam determinísticos.
    reconcile_at := greatest(
      recovery_now,
      pending_operation.sent_at + interval '60 seconds'
    );

    update renave.operation operation
       set status = 'PENDING_RECONCILIATION',
           version = pending_operation.version + 1,
           last_error_code = 'SEND_LEASE_EXPIRED',
           updated_at = recovery_now
     where operation.tenant_id = active_tenant
       and operation.id = pending_operation.id
    returning operation.id, operation.version into recovered_operation;

    insert into renave.operation_transition (
      tenant_id, operation_id, version, previous_status, status,
      reason_code, actor_hash, changed_at
    ) values (
      active_tenant, recovered_operation.id, recovered_operation.version,
      'SENT', 'PENDING_RECONCILIATION', 'SEND_LEASE_EXPIRED',
      system_actor, recovery_now
    );

    update renave.operation_outbox send_outbox
       set delivery_status = 'COMPLETED',
           lease_owner = null,
           lease_token = null,
           lease_expires_at = null,
           last_error_code = 'SEND_LEASE_EXPIRED',
           completed_at = recovery_now,
           updated_at = recovery_now
     where send_outbox.tenant_id = active_tenant
       and send_outbox.id = expired_send.id
    returning send_outbox.* into completed_send;

    if has_reconcile then
      update renave.operation_outbox reconcile_outbox
         set delivery_status = 'READY',
             available_at = reconcile_at,
             lease_owner = null,
             lease_token = null,
             lease_expires_at = null,
             last_error_code = null,
             completed_at = null,
             updated_at = recovery_now
       where reconcile_outbox.tenant_id = active_tenant
         and reconcile_outbox.id = existing_reconcile.id
         and reconcile_outbox.delivery_status = 'COMPLETED'
      returning reconcile_outbox.* into scheduled_reconcile;
    else
      insert into renave.operation_outbox (
        tenant_id, operation_id, event_type, delivery_status,
        available_at, updated_at
      ) values (
        active_tenant, recovered_operation.id, 'RECONCILE', 'READY',
        reconcile_at, recovery_now
      )
      returning * into scheduled_reconcile;
    end if;

    if scheduled_reconcile.id is null then
      raise exception 'operation recovery: reconciliação não agendada'
        using errcode = 'integrity_constraint_violation';
    end if;

    return query select
      recovered_operation.id,
      completed_send.id,
      scheduled_reconcile.id,
      recovered_operation.version,
      recovery_now,
      scheduled_reconcile.available_at;
  end loop;
end;
$$;

revoke all on function renave.recover_expired_operation_sends(integer)
from public, renave_app, renave_identity_app, renave_maintenance_app;
