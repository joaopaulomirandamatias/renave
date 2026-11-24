-- 0037 — Projeção cifrada mínima para reconciliação de operações.
--
-- Não há worker, rede ou despacho nesta migration. O runtime persiste a
-- projeção somente pela função atômica de criação; o begin de reconciliação
-- owner-fenced devolve apenas o envelope cifrado e seus metadados vinculados.

do $$
declare
  legacy_tenant record;
  previous_tenant text := pg_catalog.current_setting('renave.tenant_id', true);
begin
  for legacy_tenant in
    select catalog.tenant_id from renave_directory.tenant_catalog catalog
  loop
    perform pg_catalog.set_config(
      'renave.tenant_id', legacy_tenant.tenant_id::text, true
    );
    if exists (select 1 from renave.operation) then
      raise exception 'operation reconciliation projection: backfill legado indisponível'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;
  perform pg_catalog.set_config(
    'renave.tenant_id', coalesce(previous_tenant, ''), true
  );
end;
$$;

create table renave.operation_reconciliation_projection (
  tenant_id uuid not null,
  operation_id uuid not null,
  projection_kind text not null,
  projection_schema_version integer not null,
  projection_generation bigint not null,
  projection_size integer not null,
  projection_key_id text not null,
  projection_nonce bytea not null,
  projection_auth_tag bytea not null,
  projection_ciphertext bytea not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, operation_id),
  constraint operation_reconciliation_projection_key_nonce_key unique (
    projection_key_id, projection_nonce
  ),
  constraint operation_reconciliation_projection_operation_fkey
    foreign key (tenant_id, operation_id)
    references renave.operation (tenant_id, id) on delete restrict,
  constraint operation_reconciliation_projection_kind_valid check (
    projection_kind = 'STOCK_ENTRY_RECONCILIATION'
  ),
  constraint operation_reconciliation_projection_schema_valid check (
    projection_schema_version = 1
  ),
  constraint operation_reconciliation_projection_generation_valid check (
    projection_generation = 1
  ),
  constraint operation_reconciliation_projection_size_valid check (
    projection_size between 1 and 4096
    and projection_size = pg_catalog.octet_length(projection_ciphertext)
  ),
  constraint operation_reconciliation_projection_key_id_valid check (
    projection_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  constraint operation_reconciliation_projection_nonce_valid check (
    pg_catalog.octet_length(projection_nonce) = 12
  ),
  constraint operation_reconciliation_projection_auth_tag_valid check (
    pg_catalog.octet_length(projection_auth_tag) = 16
  )
);

alter table renave.operation_reconciliation_projection enable row level security;
alter table renave.operation_reconciliation_projection force row level security;

create policy operation_reconciliation_projection_isolation
  on renave.operation_reconciliation_projection
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.operation_reconciliation_projection_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'operation_reconciliation_projection é imutável'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger operation_reconciliation_projection_reject_update_delete
  before update or delete on renave.operation_reconciliation_projection
  for each row execute function
    renave.operation_reconciliation_projection_reject_change();

create trigger operation_reconciliation_projection_reject_truncate
  before truncate on renave.operation_reconciliation_projection
  for each statement execute function renave.operation_storage_reject_removal();

drop function renave.create_operation_with_outbox(
  uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid
);

-- Defesa em profundidade para qualquer futuro caminho de INSERT: a operação
-- só pode confirmar se sua projeção foi gravada na mesma transação.
create function renave.operation_requires_reconciliation_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (
    select 1
      from renave.operation_reconciliation_projection projection
     where projection.tenant_id = new.tenant_id
       and projection.operation_id = new.id
  ) then
    raise exception 'operation: projeção de reconciliação ausente'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return null;
end;
$$;

create constraint trigger operation_requires_reconciliation_projection
  after insert on renave.operation
  deferrable initially deferred
  for each row execute function
    renave.operation_requires_reconciliation_projection();

create function renave.create_operation_with_outbox(
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

  -- O lock administrativo ocorre depois da serialização idempotente e antes
  -- de qualquer escrita, fechando suspensão concorrente do tenant/loja.
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
      id, tenant_id, establishment_id, kind, mutation_family,
      idempotency_key_digest, vehicle_key_digest, request_sha256,
      request_size, request_schema_version, request_key_id,
      request_nonce, request_auth_tag, request_ciphertext,
      actor_subject_hash, correlation_id
    ) values (
      p_operation_id, active_tenant, p_establishment_id, p_kind,
      p_mutation_family, p_idempotency_key_digest, p_vehicle_key_digest,
      p_request_sha256, p_request_size, p_request_schema_version,
      p_request_key_id, p_request_nonce, p_request_auth_tag,
      p_request_ciphertext, p_actor_subject_hash, p_correlation_id
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

  return query select created_operation.id, created_operation.status,
    false, created_operation.created_at;
end;
$$;

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

  -- Ordem global preservada: RECONCILE outbox -> operação -> tenant ->
  -- estabelecimento. A projeção é imutável e lida sem lock após a operação.
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
    pending_operation.establishment_id, pending_operation.correlation_id,
    pending_operation.kind, pending_operation.mutation_family,
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

revoke all on renave.operation_reconciliation_projection
from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.operation_reconciliation_projection_reject_change()
from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.operation_requires_reconciliation_projection()
from public, renave_app, renave_identity_app, renave_maintenance_app;
revoke all on function renave.create_operation_with_outbox(
  uuid, uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid, text, integer, bigint,
  integer, text, bytea, bytea, bytea
) from public, renave_identity_app, renave_maintenance_app;
revoke all on function renave.begin_operation_reconciliation(
  uuid, uuid, uuid, bigint
) from public, renave_app, renave_identity_app, renave_maintenance_app;

grant execute on function renave.create_operation_with_outbox(
  uuid, uuid, text, text, bytea, bytea, bytea, integer, integer,
  text, bytea, bytea, bytea, bytea, uuid, text, integer, bigint,
  integer, text, bytea, bytea, bytea
) to renave_app;
