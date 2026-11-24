-- 0049 — Criação local retida de entrada de estoque usado.
--
-- A operação fica durável e bloqueante, mas não recebe outbox. Não há nesta
-- fatia função de liberação, worker, sender, rota HTTP ou chamada ao RENAVE.

alter table renave.operation
  drop constraint operation_status_valid;
alter table renave.operation
  add constraint operation_status_valid check (status in (
    'HELD_LOCAL', 'PENDING_SEND', 'SENT', 'REJECTED',
    'PENDING_RECONCILIATION', 'CONFIRMED', 'MANUAL_REVIEW'
  ));

alter table renave.operation_transition
  drop constraint operation_transition_previous_status_valid;
alter table renave.operation_transition
  add constraint operation_transition_previous_status_valid check (
    previous_status is null or previous_status in (
      'HELD_LOCAL', 'PENDING_SEND', 'SENT', 'REJECTED',
      'PENDING_RECONCILIATION', 'CONFIRMED', 'MANUAL_REVIEW'
    )
  );
alter table renave.operation_transition
  drop constraint operation_transition_status_valid;
alter table renave.operation_transition
  add constraint operation_transition_status_valid check (status in (
    'HELD_LOCAL', 'PENDING_SEND', 'SENT', 'REJECTED',
    'PENDING_RECONCILIATION', 'CONFIRMED', 'MANUAL_REVIEW'
  ));

drop index renave.operation_active_vehicle_family_key;
create unique index operation_active_vehicle_family_key
  on renave.operation (tenant_id, vehicle_key_digest, mutation_family)
  where status in (
    'HELD_LOCAL', 'PENDING_SEND', 'SENT',
    'PENDING_RECONCILIATION', 'MANUAL_REVIEW'
  );

-- O caminho legado continua disponível apenas ao owner para migrações e
-- testes históricos. Nenhum runtime pode criar outbox diretamente.
revoke all on function renave.create_operation_with_outbox(
  uuid, uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid, text, integer, bigint,
  integer, text, bytea, bytea, bytea
) from public, renave_app, renave_identity_app, renave_maintenance_app,
       renave_operation_worker;

create or replace function renave.operation_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('HELD_LOCAL', 'PENDING_SEND') or new.version <> 1 then
      raise exception 'operation: estado inicial inválido'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.establishment_id is distinct from old.establishment_id
     or new.kind is distinct from old.kind
     or new.mutation_family is distinct from old.mutation_family
     or new.idempotency_key_digest is distinct from old.idempotency_key_digest
     or new.vehicle_key_digest is distinct from old.vehicle_key_digest
     or new.request_sha256 is distinct from old.request_sha256
     or new.request_size is distinct from old.request_size
     or new.request_schema_version is distinct from old.request_schema_version
     or new.request_key_id is distinct from old.request_key_id
     or new.request_nonce is distinct from old.request_nonce
     or new.request_auth_tag is distinct from old.request_auth_tag
     or new.request_ciphertext is distinct from old.request_ciphertext
     or new.actor_subject_hash is distinct from old.actor_subject_hash
     or new.correlation_id is distinct from old.correlation_id
     or new.created_at is distinct from old.created_at then
    raise exception 'operation: identidade e payload são imutáveis'
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'operation: versão inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not (case old.status
    when 'PENDING_SEND' then new.status = 'SENT'
    when 'SENT' then new.status in (
      'CONFIRMED', 'REJECTED', 'PENDING_RECONCILIATION'
    )
    when 'PENDING_RECONCILIATION' then new.status in (
      'CONFIRMED', 'MANUAL_REVIEW', 'PENDING_SEND'
    )
    else false
  end) then
    raise exception 'operation: transição inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create function renave.create_held_local_operation(
  p_operation_id uuid,
  p_establishment_id uuid,
  p_kind text,
  p_mutation_family text,
  p_idempotency_key_digest bytea,
  p_vehicle_key_digest bytea,
  p_request_sha256 bytea,
  p_request_size integer,
  p_request_schema_version integer,
  p_request_key_id text,
  p_request_nonce bytea,
  p_request_auth_tag bytea,
  p_request_ciphertext bytea,
  p_actor_subject_hash bytea,
  p_correlation_id uuid,
  p_projection_kind text,
  p_projection_schema_version integer,
  p_projection_generation bigint,
  p_projection_size integer,
  p_projection_key_id text,
  p_projection_nonce bytea,
  p_projection_auth_tag bytea,
  p_projection_ciphertext bytea
)
returns table (
  operation_id uuid,
  operation_status text,
  replayed boolean,
  operation_created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  existing_operation record;
  created_operation record;
  current_link_status text;
  violated_constraint text;
begin
  if active_tenant is null then
    raise exception 'operation: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_operation_id is null or p_establishment_id is null
     or p_correlation_id is null then
    raise exception 'operation: identificador ausente'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_kind <> 'USED_STOCK_ENTRY' or p_mutation_family <> 'STOCK_ENTRY' then
    raise exception 'operation: tipo inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_idempotency_key_digest is null
     or pg_catalog.octet_length(p_idempotency_key_digest) <> 32
     or p_vehicle_key_digest is null
     or pg_catalog.octet_length(p_vehicle_key_digest) <> 32
     or p_request_sha256 is null
     or pg_catalog.octet_length(p_request_sha256) <> 32
     or p_actor_subject_hash is null
     or pg_catalog.octet_length(p_actor_subject_hash) <> 32 then
    raise exception 'operation: digest inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_request_size is null
     or p_request_size < 1
     or p_request_size > 1048576
     or p_request_ciphertext is null
     or p_request_size <> pg_catalog.octet_length(p_request_ciphertext)
     or p_request_schema_version is null
     or p_request_schema_version < 1
     or p_request_schema_version > 2147483647
     or p_request_key_id is null
     or p_request_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or p_request_nonce is null
     or pg_catalog.octet_length(p_request_nonce) <> 12
     or p_request_auth_tag is null
     or pg_catalog.octet_length(p_request_auth_tag) <> 16 then
    raise exception 'operation: envelope inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_projection_kind <> 'STOCK_ENTRY_RECONCILIATION'
     or p_projection_schema_version <> 1
     or p_projection_generation <> 1
     or p_projection_size is null
     or p_projection_size < 1
     or p_projection_size > 4096
     or p_projection_ciphertext is null
     or p_projection_size <> pg_catalog.octet_length(p_projection_ciphertext)
     or p_projection_key_id is null
     or p_projection_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or p_projection_nonce is null
     or pg_catalog.octet_length(p_projection_nonce) <> 12
     or p_projection_auth_tag is null
     or pg_catalog.octet_length(p_projection_auth_tag) <> 16 then
    raise exception 'operation: projeção cifrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      active_tenant::text || ':' ||
        pg_catalog.encode(p_idempotency_key_digest, 'hex'),
      250025
    )
  );

  perform 1 from renave.tenant tenant
   where tenant.id = active_tenant and tenant.status = 'active'
   for share;
  if not found then
    raise exception 'operation: tenant indisponível'
      using errcode = 'insufficient_privilege';
  end if;
  perform 1 from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = p_establishment_id
     and establishment.status = 'active'
   for share;
  if not found then
    raise exception 'operation: estabelecimento indisponível'
      using errcode = 'insufficient_privilege';
  end if;

  -- Compartilha a mesma serialização da máquina de estados do vínculo.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      active_tenant::text || ':' || p_establishment_id::text,
      170017
    )
  );
  select link.status into current_link_status
    from renave.credential_link link
   where link.tenant_id = active_tenant
     and link.establishment_id = p_establishment_id
   for share;
  if not found or current_link_status <> 'enabled' then
    raise exception 'operation: vínculo credencial não habilitado'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select operation.id, operation.establishment_id, operation.kind,
         operation.mutation_family, operation.vehicle_key_digest,
         operation.request_sha256, operation.request_size,
         operation.request_schema_version, operation.status,
         operation.created_at
    into existing_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.idempotency_key_digest = p_idempotency_key_digest;

  if found then
    if existing_operation.status <> 'HELD_LOCAL'
       or existing_operation.establishment_id is distinct from p_establishment_id
       or existing_operation.kind is distinct from p_kind
       or existing_operation.mutation_family is distinct from p_mutation_family
       or existing_operation.vehicle_key_digest is distinct from p_vehicle_key_digest
       or existing_operation.request_sha256 is distinct from p_request_sha256
       or existing_operation.request_size is distinct from p_request_size
       or existing_operation.request_schema_version is distinct from p_request_schema_version then
      raise exception 'operation: conflito de idempotência'
        using errcode = 'integrity_constraint_violation';
    end if;
    if not exists (
      select 1 from renave.operation_reconciliation_projection projection
       where projection.tenant_id = active_tenant
         and projection.operation_id = existing_operation.id
    ) then
      raise exception 'operation: projeção de reconciliação ausente'
        using errcode = 'integrity_constraint_violation';
    end if;
    return query select existing_operation.id, existing_operation.status,
      true, existing_operation.created_at;
    return;
  end if;

  begin
    insert into renave.operation (
      id, tenant_id, establishment_id, kind, mutation_family, status,
      idempotency_key_digest, vehicle_key_digest, request_sha256,
      request_size, request_schema_version, request_key_id,
      request_nonce, request_auth_tag, request_ciphertext,
      actor_subject_hash, correlation_id
    ) values (
      p_operation_id, active_tenant, p_establishment_id, p_kind,
      p_mutation_family, 'HELD_LOCAL', p_idempotency_key_digest,
      p_vehicle_key_digest, p_request_sha256, p_request_size,
      p_request_schema_version, p_request_key_id, p_request_nonce,
      p_request_auth_tag, p_request_ciphertext, p_actor_subject_hash,
      p_correlation_id
    ) returning id, status, created_at into created_operation;
  exception when unique_violation then
    get stacked diagnostics violated_constraint = CONSTRAINT_NAME;
    if violated_constraint = 'operation_active_vehicle_family_key' then
      raise exception 'operation: mutação ativa conflitante'
        using errcode = 'integrity_constraint_violation';
    end if;
    raise exception 'operation: identificador já utilizado'
      using errcode = 'integrity_constraint_violation';
  end;

  insert into renave.operation_reconciliation_projection (
    tenant_id, operation_id, projection_kind, projection_schema_version,
    projection_generation, projection_size,
    projection_key_id, projection_nonce, projection_auth_tag,
    projection_ciphertext, created_at
  ) values (
    active_tenant, created_operation.id, p_projection_kind,
    p_projection_schema_version, p_projection_generation,
    p_projection_size, p_projection_key_id, p_projection_nonce,
    p_projection_auth_tag, p_projection_ciphertext,
    created_operation.created_at
  );

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, created_operation.id, 1, null, 'HELD_LOCAL',
    'HELD_LOCAL_CREATED', p_actor_subject_hash, created_operation.created_at
  );

  return query select created_operation.id, created_operation.status,
    false, created_operation.created_at;
end;
$$;

revoke all on function renave.create_held_local_operation(
  uuid, uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid, text, integer, bigint,
  integer, text, bytea, bytea, bytea
) from public, renave_identity_app, renave_maintenance_app,
       renave_operation_worker;
grant execute on function renave.create_held_local_operation(
  uuid, uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid, text, integer, bigint,
  integer, text, bytea, bytea, bytea
) to renave_app;
