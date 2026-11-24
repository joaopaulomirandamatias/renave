-- 0025 — Fundação durável de operações mutáveis e outbox.
--
-- Esta migration NÃO habilita despacho, worker, rota HTTP ou chamada RENAVE.
-- Ela persiste somente envelopes já cifrados e cria a fronteira idempotente
-- que será usada por uma fatia posterior, depois dos gates operacionais.

create table renave.operation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  establishment_id uuid not null,
  kind text not null,
  mutation_family text not null,
  status text not null default 'PENDING_SEND',
  idempotency_key_digest bytea not null,
  vehicle_key_digest bytea not null,
  request_sha256 bytea not null,
  request_size integer not null,
  request_schema_version integer not null,
  request_key_id text not null,
  request_nonce bytea not null,
  request_auth_tag bytea not null,
  request_ciphertext bytea not null,
  actor_subject_hash bytea not null,
  correlation_id uuid not null,
  version bigint not null default 1,
  sent_at timestamptz,
  finalized_at timestamptz,
  last_error_code text,
  remote_record_id bigint,
  remote_state text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint operation_tenant_id_key unique (tenant_id, id),
  constraint operation_tenant_idempotency_key unique (
    tenant_id, idempotency_key_digest
  ),
  constraint operation_kind_valid check (kind in ('USED_STOCK_ENTRY')),
  constraint operation_mutation_family_valid check (
    mutation_family in ('STOCK_ENTRY')
  ),
  constraint operation_status_valid check (status in (
    'PENDING_SEND', 'SENT', 'REJECTED', 'PENDING_RECONCILIATION',
    'CONFIRMED', 'MANUAL_REVIEW'
  )),
  constraint operation_idempotency_digest_valid check (
    pg_catalog.octet_length(idempotency_key_digest) = 32
  ),
  constraint operation_vehicle_digest_valid check (
    pg_catalog.octet_length(vehicle_key_digest) = 32
  ),
  constraint operation_request_hash_valid check (
    pg_catalog.octet_length(request_sha256) = 32
  ),
  constraint operation_request_size_valid check (
    request_size between 1 and 1048576
    and request_size = pg_catalog.octet_length(request_ciphertext)
  ),
  constraint operation_schema_version_valid check (
    request_schema_version between 1 and 2147483647
  ),
  constraint operation_key_id_valid check (
    request_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  constraint operation_nonce_valid check (
    pg_catalog.octet_length(request_nonce) = 12
  ),
  constraint operation_auth_tag_valid check (
    pg_catalog.octet_length(request_auth_tag) = 16
  ),
  constraint operation_actor_hash_valid check (
    pg_catalog.octet_length(actor_subject_hash) = 32
  ),
  constraint operation_version_valid check (version > 0),
  constraint operation_error_code_valid check (
    last_error_code is null or (
      last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
      and pg_catalog.length(last_error_code) <= 64
    )
  ),
  constraint operation_remote_record_id_valid check (
    remote_record_id is null or remote_record_id > 0
  )
);

-- Uma segunda chave idempotente não pode abrir outra mutação simultânea para
-- o mesmo veículo/família. MANUAL_REVIEW permanece ativo e bloqueante.
create unique index operation_active_vehicle_family_key
  on renave.operation (tenant_id, vehicle_key_digest, mutation_family)
  where status in (
    'PENDING_SEND', 'SENT', 'PENDING_RECONCILIATION', 'MANUAL_REVIEW'
  );

create table renave.operation_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operation_id uuid not null,
  event_type text not null,
  delivery_status text not null default 'READY',
  available_at timestamptz not null default pg_catalog.clock_timestamp(),
  attempt_count integer not null default 0,
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  foreign key (tenant_id, operation_id)
    references renave.operation (tenant_id, id) on delete restrict,
  constraint operation_outbox_event_key unique (
    tenant_id, operation_id, event_type
  ),
  constraint operation_outbox_event_type_valid check (
    event_type in ('SEND_MUTATION', 'RECONCILE')
  ),
  constraint operation_outbox_delivery_status_valid check (
    delivery_status in ('READY', 'LEASED', 'COMPLETED')
  ),
  constraint operation_outbox_attempt_count_valid check (attempt_count >= 0),
  constraint operation_outbox_lease_coherent check (
    (delivery_status = 'LEASED'
      and lease_owner is not null
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null)
    or
    (delivery_status = 'READY'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completed_at is null)
    or
    (delivery_status = 'COMPLETED'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null)
  ),
  constraint operation_outbox_error_code_valid check (
    last_error_code is null or (
      last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
      and pg_catalog.length(last_error_code) <= 64
    )
  )
);

create index operation_outbox_ready_idx
  on renave.operation_outbox (
    tenant_id, event_type, available_at, created_at, id
  ) where delivery_status = 'READY';

create table renave.operation_transition (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  operation_id uuid not null,
  version bigint not null,
  previous_status text,
  status text not null,
  reason_code text not null,
  actor_hash bytea not null,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (tenant_id, operation_id)
    references renave.operation (tenant_id, id) on delete restrict,
  constraint operation_transition_version_key unique (
    tenant_id, operation_id, version
  ),
  constraint operation_transition_version_valid check (version > 0),
  constraint operation_transition_previous_status_valid check (
    previous_status is null or previous_status in (
      'PENDING_SEND', 'SENT', 'REJECTED', 'PENDING_RECONCILIATION',
      'CONFIRMED', 'MANUAL_REVIEW'
    )
  ),
  constraint operation_transition_status_valid check (status in (
    'PENDING_SEND', 'SENT', 'REJECTED', 'PENDING_RECONCILIATION',
    'CONFIRMED', 'MANUAL_REVIEW'
  )),
  constraint operation_transition_reason_valid check (
    reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    and pg_catalog.length(reason_code) <= 64
  ),
  constraint operation_transition_actor_hash_valid check (
    pg_catalog.octet_length(actor_hash) = 32
  )
);

create index operation_transition_timeline_idx
  on renave.operation_transition (tenant_id, operation_id, version);

alter table renave.operation enable row level security;
alter table renave.operation force row level security;
alter table renave.operation_outbox enable row level security;
alter table renave.operation_outbox force row level security;
alter table renave.operation_transition enable row level security;
alter table renave.operation_transition force row level security;

create policy operation_isolation on renave.operation
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy operation_outbox_isolation on renave.operation_outbox
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy operation_transition_isolation on renave.operation_transition
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.operation_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING_SEND' or new.version <> 1 then
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

create trigger operation_guard
  before insert or update on renave.operation
  for each row execute function renave.operation_guard();

create function renave.operation_outbox_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.operation_id is distinct from old.operation_id
     or new.event_type is distinct from old.event_type
     or new.created_at is distinct from old.created_at then
    raise exception 'operation_outbox: identidade é imutável'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create trigger operation_outbox_guard
  before update on renave.operation_outbox
  for each row execute function renave.operation_outbox_guard();

create function renave.operation_transition_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'operation_transition é append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger operation_transition_append_only
  before update or delete on renave.operation_transition
  for each row execute function renave.operation_transition_reject_change();

create function renave.operation_storage_reject_removal()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'operation storage: remoção proibida'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger operation_reject_delete
  before delete on renave.operation
  for each row execute function renave.operation_storage_reject_removal();
create trigger operation_reject_truncate
  before truncate on renave.operation
  for each statement execute function renave.operation_storage_reject_removal();
create trigger operation_outbox_reject_delete
  before delete on renave.operation_outbox
  for each row execute function renave.operation_storage_reject_removal();
create trigger operation_outbox_reject_truncate
  before truncate on renave.operation_outbox
  for each statement execute function renave.operation_storage_reject_removal();
create trigger operation_transition_reject_truncate
  before truncate on renave.operation_transition
  for each statement execute function renave.operation_storage_reject_removal();

create function renave.create_operation_with_outbox(
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
  p_correlation_id uuid
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
  existing_operation renave.operation;
  created_operation renave.operation;
begin
  if active_tenant is null then
    raise exception 'operation: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_establishment_id is null or p_correlation_id is null then
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
     or p_request_key_id is null
     or p_request_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or p_request_nonce is null
     or pg_catalog.octet_length(p_request_nonce) <> 12
     or p_request_auth_tag is null
     or pg_catalog.octet_length(p_request_auth_tag) <> 16 then
    raise exception 'operation: envelope inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from renave.tenant tenant
     where tenant.id = active_tenant
       and tenant.status = 'active'
  ) then
    raise exception 'operation: tenant indisponível'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from renave.establishment establishment
     where establishment.tenant_id = active_tenant
       and establishment.id = p_establishment_id
       and establishment.status = 'active'
  ) then
    raise exception 'operation: estabelecimento indisponível'
      using errcode = 'insufficient_privilege';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      active_tenant::text || ':' || pg_catalog.encode(p_idempotency_key_digest, 'hex'),
      250025
    )
  );

  select operation.* into existing_operation
    from renave.operation operation
   where operation.tenant_id = active_tenant
     and operation.idempotency_key_digest = p_idempotency_key_digest;

  if found then
    if existing_operation.establishment_id is distinct from p_establishment_id
       or existing_operation.kind is distinct from p_kind
       or existing_operation.mutation_family is distinct from p_mutation_family
       or existing_operation.vehicle_key_digest is distinct from p_vehicle_key_digest
       or existing_operation.request_sha256 is distinct from p_request_sha256
       or existing_operation.request_size is distinct from p_request_size
       or existing_operation.request_schema_version is distinct from p_request_schema_version then
      raise exception 'operation: conflito de idempotência'
        using errcode = 'integrity_constraint_violation';
    end if;
    return query select
      existing_operation.id,
      existing_operation.status,
      true,
      existing_operation.created_at;
    return;
  end if;

  begin
    insert into renave.operation (
      tenant_id, establishment_id, kind, mutation_family,
      idempotency_key_digest, vehicle_key_digest, request_sha256,
      request_size, request_schema_version, request_key_id,
      request_nonce, request_auth_tag, request_ciphertext,
      actor_subject_hash, correlation_id
    ) values (
      active_tenant, p_establishment_id, p_kind, p_mutation_family,
      p_idempotency_key_digest, p_vehicle_key_digest, p_request_sha256,
      p_request_size, p_request_schema_version, p_request_key_id,
      p_request_nonce, p_request_auth_tag, p_request_ciphertext,
      p_actor_subject_hash, p_correlation_id
    ) returning * into created_operation;
  exception when unique_violation then
    raise exception 'operation: mutação ativa conflitante'
      using errcode = 'integrity_constraint_violation';
  end;

  insert into renave.operation_outbox (
    tenant_id, operation_id, event_type
  ) values (
    active_tenant, created_operation.id, 'SEND_MUTATION'
  );

  insert into renave.operation_transition (
    tenant_id, operation_id, version, previous_status, status,
    reason_code, actor_hash, changed_at
  ) values (
    active_tenant, created_operation.id, 1, null, 'PENDING_SEND',
    'CREATED', p_actor_subject_hash, created_operation.created_at
  );

  return query select
    created_operation.id,
    created_operation.status,
    false,
    created_operation.created_at;
end;
$$;

create function renave.get_operation_summary(p_operation_id uuid)
returns table (
  operation_id uuid,
  establishment_id uuid,
  kind text,
  mutation_family text,
  status text,
  version bigint,
  correlation_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select operation.id, operation.establishment_id, operation.kind,
         operation.mutation_family, operation.status, operation.version,
         operation.correlation_id, operation.created_at, operation.updated_at
    from renave.operation operation
   where operation.tenant_id = renave.current_tenant_id()
     and operation.id = p_operation_id
$$;

revoke all on renave.operation, renave.operation_outbox,
  renave.operation_transition from public, renave_app,
  renave_identity_app, renave_maintenance_app;
revoke all on function renave.create_operation_with_outbox(
  uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid
) from public, renave_identity_app, renave_maintenance_app;
revoke all on function renave.get_operation_summary(uuid)
  from public, renave_identity_app, renave_maintenance_app;
revoke all on function renave.operation_guard() from public;
revoke all on function renave.operation_outbox_guard() from public;
revoke all on function renave.operation_transition_reject_change() from public;
revoke all on function renave.operation_storage_reject_removal() from public;

grant execute on function renave.create_operation_with_outbox(
  uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid
) to renave_app;
grant execute on function renave.get_operation_summary(uuid) to renave_app;
