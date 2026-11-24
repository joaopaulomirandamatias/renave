-- 0043 — Preflight read-only das projeções pendentes de reconciliação.
--
-- Esta função não reivindica outbox, não altera operação e não consulta rede.
-- O envelope continua cifrado e é visível somente ao papel dedicado do worker.
-- Para impedir varredura do backlog, retorna no máximo uma amostra determinística
-- por projection_key_id pendente e não aceita cursor, filtro ou limite do chamador.

create function renave.preflight_pending_operation_reconciliation_projection_samples()
returns table (
  operation_id uuid,
  establishment_id uuid,
  kind text,
  mutation_family text,
  request_schema_version integer,
  source_request_sha256 bytea,
  projection_kind text,
  projection_schema_version integer,
  projection_generation bigint,
  projection_size integer,
  projection_key_id text,
  projection_nonce bytea,
  projection_auth_tag bytea,
  projection_ciphertext bytea
)
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
    select distinct on (projection.projection_key_id)
           operation.id,
           operation.establishment_id,
           operation.kind,
           operation.mutation_family,
           operation.request_schema_version,
           operation.request_sha256,
           projection.projection_kind,
           projection.projection_schema_version,
           projection.projection_generation,
           projection.projection_size,
           projection.projection_key_id,
           projection.projection_nonce,
           projection.projection_auth_tag,
           projection.projection_ciphertext
      from renave.operation operation
      join renave.operation_outbox reconcile
        on reconcile.tenant_id = operation.tenant_id
       and reconcile.operation_id = operation.id
       and reconcile.event_type = 'RECONCILE'
      join renave.operation_reconciliation_projection projection
        on projection.tenant_id = operation.tenant_id
       and projection.operation_id = operation.id
      join renave.tenant tenant
        on tenant.id = operation.tenant_id
       and tenant.status = 'active'
      join renave.establishment establishment
        on establishment.tenant_id = operation.tenant_id
       and establishment.id = operation.establishment_id
       and establishment.status = 'active'
     where operation.tenant_id = active_tenant
       and operation.status = 'PENDING_RECONCILIATION'
       and reconcile.delivery_status <> 'COMPLETED'
     order by projection.projection_key_id, operation.id;
end
$$;

revoke all on function
  renave.preflight_pending_operation_reconciliation_projection_samples()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave.preflight_pending_operation_reconciliation_projection_samples()
to renave_operation_worker;
