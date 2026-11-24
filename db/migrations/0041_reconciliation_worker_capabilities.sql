-- 0041 — Capacidades mínimas do worker operacional de reconciliação.
--
-- O worker não recebe acesso direto a tabelas. Esta migration expõe somente
-- a enumeração tenant-scoped de IDs de chave ainda necessários e as duas
-- rotinas já fechadas do limitador distribuído de consultas ao SERPRO.

create function renave.list_pending_operation_reconciliation_projection_key_ids()
returns table (projection_key_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null then
    raise exception 'tenant de reconciliação ausente'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    select distinct projection.projection_key_id
      from renave.operation operation
      join renave.operation_outbox reconcile
        on reconcile.tenant_id = operation.tenant_id
       and reconcile.operation_id = operation.id
       and reconcile.event_type = 'RECONCILE'
      join renave.operation_reconciliation_projection projection
        on projection.tenant_id = operation.tenant_id
       and projection.operation_id = operation.id
     where operation.tenant_id = active_tenant
       and operation.status = 'PENDING_RECONCILIATION'
       and reconcile.delivery_status <> 'COMPLETED'
     order by projection.projection_key_id;
end
$$;

revoke all on function
  renave.list_pending_operation_reconciliation_projection_key_ids()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave.list_pending_operation_reconciliation_projection_key_ids()
to renave_operation_worker;

revoke all on function
  renave_runtime.acquire_serpro_query_permit(uuid, bytea, bytea),
  renave_runtime.release_serpro_query_permit(uuid, bytea)
from renave_operation_worker;
grant execute on function
  renave_runtime.acquire_serpro_query_permit(uuid, bytea, bytea),
  renave_runtime.release_serpro_query_permit(uuid, bytea)
to renave_operation_worker;
