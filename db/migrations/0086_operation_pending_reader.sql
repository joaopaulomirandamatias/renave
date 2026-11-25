-- 0086 — Projeção sanitizada e somente leitura das operações pendentes.
--
-- A API nunca recebe envelopes, digests, hashes, PII, leases ou IDs de
-- outbox. Tenant e estabelecimento são filtros obrigatórios dentro das
-- funções SECURITY DEFINER; ausência e escopo divergente retornam zero linhas.

create schema renave_operation_reader authorization renave_migrator;
revoke all on schema renave_operation_reader from public;
grant usage on schema renave_operation_reader to renave_app;

create function renave_operation_reader.list_pending_operations(
  p_establishment_id uuid,
  p_limit integer
)
returns table (
  operation_id uuid,
  kind text,
  status text,
  reason_code text,
  correlation_id uuid,
  sent_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null
     or p_establishment_id is null
     or p_limit is null
     or p_limit not between 1 and 50 then
    raise exception 'pending operation reader: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A linha extra permite ao chamador calcular `truncated` sem expor count.
  return query
  select operation.id,
         operation.kind,
         operation.status,
         latest.reason_code,
         operation.correlation_id,
         operation.sent_at,
         operation.created_at,
         operation.updated_at
    from renave.operation operation
    left join lateral (
      select transition.reason_code
        from renave.operation_transition transition
       where transition.tenant_id = operation.tenant_id
         and transition.operation_id = operation.id
       order by transition.version desc
       limit 1
    ) latest on true
   where operation.tenant_id = active_tenant
     and operation.establishment_id = p_establishment_id
     and operation.status in ('PENDING_RECONCILIATION','MANUAL_REVIEW')
   order by case operation.status
              when 'PENDING_RECONCILIATION' then 0
              else 1
            end,
            operation.updated_at,
            operation.id
   limit p_limit + 1;
end
$$;

create function renave_operation_reader.get_operation_detail(
  p_establishment_id uuid,
  p_operation_id uuid
)
returns table (
  operation_id uuid,
  kind text,
  status text,
  reason_code text,
  correlation_id uuid,
  sent_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  version bigint,
  remote_record_id bigint,
  remote_state text,
  finalized_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null
     or p_establishment_id is null
     or p_operation_id is null then
    raise exception 'pending operation reader: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select operation.id,
         operation.kind,
         operation.status,
         latest.reason_code,
         operation.correlation_id,
         operation.sent_at,
         operation.created_at,
         operation.updated_at,
         operation.version,
         operation.remote_record_id,
         operation.remote_state,
         operation.finalized_at
    from renave.operation operation
    left join lateral (
      select transition.reason_code
        from renave.operation_transition transition
       where transition.tenant_id = operation.tenant_id
         and transition.operation_id = operation.id
       order by transition.version desc
       limit 1
    ) latest on true
   where operation.tenant_id = active_tenant
     and operation.establishment_id = p_establishment_id
     and operation.id = p_operation_id;
end
$$;

create function renave_operation_reader.list_operation_timeline(
  p_establishment_id uuid,
  p_operation_id uuid
)
returns table (
  version bigint,
  previous_status text,
  status text,
  reason_code text,
  changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null
     or p_establishment_id is null
     or p_operation_id is null then
    raise exception 'pending operation reader: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select transition.version,
         transition.previous_status,
         transition.status,
         transition.reason_code,
         transition.changed_at
    from renave.operation operation
    join renave.operation_transition transition
      on transition.tenant_id = operation.tenant_id
     and transition.operation_id = operation.id
   where operation.tenant_id = active_tenant
     and operation.establishment_id = p_establishment_id
     and operation.id = p_operation_id
   order by transition.version;
end
$$;

revoke all on function
  renave_operation_reader.list_pending_operations(uuid,integer),
  renave_operation_reader.get_operation_detail(uuid,uuid),
  renave_operation_reader.list_operation_timeline(uuid,uuid)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

grant execute on function
  renave_operation_reader.list_pending_operations(uuid,integer),
  renave_operation_reader.get_operation_detail(uuid,uuid),
  renave_operation_reader.list_operation_timeline(uuid,uuid)
to renave_app;
