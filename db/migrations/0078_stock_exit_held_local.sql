-- 0078 — Fundação local de saída de estoque usado.
--
-- O schema separado é um limite de capacidade: não contém outbox, claim,
-- promoção nem despacho. A primeira fatia de saída pode somente persistir
-- HELD_LOCAL com o mesmo selo regulatório exigido da entrada.

create schema renave_stock_exit authorization renave_migrator;
revoke all on schema renave_stock_exit from public;
grant usage on schema renave_stock_exit to renave_app;

create table renave_stock_exit.operation (
  tenant_id uuid not null,
  id uuid not null,
  establishment_id uuid not null,
  kind text not null,
  mutation_family text not null,
  status text not null,
  remote_stock_id bigint not null,
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
  reconciliation_projection_kind text not null,
  reconciliation_projection_schema_version integer not null,
  reconciliation_projection_generation bigint not null,
  reconciliation_projection_size integer not null,
  reconciliation_projection_key_id text not null,
  reconciliation_projection_nonce bytea not null,
  reconciliation_projection_auth_tag bytea not null,
  reconciliation_projection_ciphertext bytea not null,
  service_nature text not null,
  jurisdiction_uf text not null,
  jurisdiction_generation bigint not null,
  scope_generation bigint not null,
  credential_link_version bigint not null,
  operator_profile_id uuid not null,
  operator_profile_version bigint not null,
  establishment_profile_id uuid not null,
  establishment_profile_version bigint not null,
  version bigint not null default 1,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, id),
  constraint stock_exit_operation_idempotency_key unique (
    tenant_id, idempotency_key_digest
  ),
  constraint stock_exit_operation_active_vehicle_key unique (
    tenant_id, vehicle_key_digest, mutation_family
  ),
  constraint stock_exit_operation_active_remote_stock unique (
    tenant_id, establishment_id, remote_stock_id
  ),
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  foreign key (tenant_id, operator_profile_id)
    references renave.operator_identity_profile (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, establishment_profile_id)
    references renave.establishment_renave_profile (tenant_id, id)
    on delete restrict,
  constraint stock_exit_operation_type_valid check (
    kind = 'USED_STOCK_EXIT' and mutation_family = 'STOCK_EXIT'
  ),
  constraint stock_exit_operation_status_valid check (status = 'HELD_LOCAL'),
  constraint stock_exit_operation_remote_stock_id_valid check (
    remote_stock_id > 0
  ),
  constraint stock_exit_operation_digests_valid check (
    pg_catalog.octet_length(idempotency_key_digest) = 32
    and pg_catalog.octet_length(vehicle_key_digest) = 32
    and pg_catalog.octet_length(request_sha256) = 32
    and pg_catalog.octet_length(actor_subject_hash) = 32
  ),
  constraint stock_exit_operation_request_envelope_valid check (
    request_size between 1 and 1048576
    and request_size = pg_catalog.octet_length(request_ciphertext)
    and request_schema_version between 1 and 2147483647
    and request_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(request_nonce) = 12
    and pg_catalog.octet_length(request_auth_tag) = 16
  ),
  constraint stock_exit_operation_projection_envelope_valid check (
    reconciliation_projection_kind = 'STOCK_EXIT_RECONCILIATION'
    and reconciliation_projection_schema_version = 1
    and reconciliation_projection_generation = 1
    and reconciliation_projection_size between 1 and 4096
    and reconciliation_projection_size =
      pg_catalog.octet_length(reconciliation_projection_ciphertext)
    and reconciliation_projection_key_id ~
      '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(reconciliation_projection_nonce) = 12
    and pg_catalog.octet_length(reconciliation_projection_auth_tag) = 16
  ),
  constraint stock_exit_operation_authorization_valid check (
    service_nature = 'establishment'
    and jurisdiction_uf in (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    )
    and jurisdiction_generation > 0 and scope_generation > 0
    and credential_link_version > 0 and operator_profile_version > 0
    and establishment_profile_version > 0
  ),
  constraint stock_exit_operation_version_valid check (version > 0),
  constraint stock_exit_operation_timeline_valid check (updated_at >= created_at)
);

alter table renave_stock_exit.operation enable row level security;
alter table renave_stock_exit.operation force row level security;
create policy stock_exit_operation_isolation on renave_stock_exit.operation
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create table renave_stock_exit.operation_transition (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  operation_id uuid not null,
  from_status text,
  to_status text not null,
  actor_subject_hash bytea not null,
  correlation_id uuid not null,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (tenant_id, operation_id)
    references renave_stock_exit.operation (tenant_id, id) on delete restrict,
  unique (tenant_id, operation_id, to_status),
  constraint stock_exit_transition_initial_valid check (
    from_status is null and to_status = 'HELD_LOCAL'
  ),
  constraint stock_exit_transition_actor_valid check (
    pg_catalog.octet_length(actor_subject_hash) = 32
  )
);

alter table renave_stock_exit.operation_transition enable row level security;
alter table renave_stock_exit.operation_transition force row level security;
create policy stock_exit_transition_isolation
  on renave_stock_exit.operation_transition
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave_stock_exit.reject_change()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'stock exit: registro imutável'
    using errcode = 'insufficient_privilege';
end
$$;

create trigger stock_exit_operation_append_only
  before update or delete on renave_stock_exit.operation
  for each row execute function renave_stock_exit.reject_change();
create trigger stock_exit_operation_reject_truncate
  before truncate on renave_stock_exit.operation
  for each statement execute function renave_stock_exit.reject_change();
create trigger stock_exit_transition_append_only
  before update or delete on renave_stock_exit.operation_transition
  for each row execute function renave_stock_exit.reject_change();
create trigger stock_exit_transition_reject_truncate
  before truncate on renave_stock_exit.operation_transition
  for each statement execute function renave_stock_exit.reject_change();

create function renave_stock_exit.create_held_local_operation(
  p_operation_id uuid,p_establishment_id uuid,p_kind text,
  p_mutation_family text,p_idempotency_key_digest bytea,
  p_vehicle_key_digest bytea,p_request_sha256 bytea,p_request_size integer,
  p_request_schema_version integer,p_request_key_id text,
  p_request_nonce bytea,p_request_auth_tag bytea,p_request_ciphertext bytea,
  p_actor_subject_hash bytea,p_correlation_id uuid,p_projection_kind text,
  p_projection_schema_version integer,p_projection_generation bigint,
  p_projection_size integer,p_projection_key_id text,p_projection_nonce bytea,
  p_projection_auth_tag bytea,p_projection_ciphertext bytea,p_subject text,
  p_operator_profile_id uuid,p_operator_profile_version bigint,
  p_establishment_profile_id uuid,p_establishment_profile_version bigint,
  p_remote_stock_id bigint)
returns table(operation_id uuid,operation_status text,replayed boolean,
  operation_created_at timestamptz)
language plpgsql security definer set search_path = pg_catalog as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  auth_now timestamptz;
  effective_uf text;
  uf_count integer;
  principal record;
  jurisdiction renave.establishment_regulatory_jurisdiction;
  scope_item renave.credential_service_scope;
  link_item renave.credential_link;
  existing_item renave_stock_exit.operation;
  created_item renave_stock_exit.operation;
  violated_constraint text;
begin
  if active_tenant is null or p_operation_id is null
    or p_establishment_id is null or p_correlation_id is null
    or p_kind is distinct from 'USED_STOCK_EXIT'
    or p_mutation_family is distinct from 'STOCK_EXIT'
    or p_remote_stock_id is null or p_remote_stock_id < 1
    or p_projection_kind is distinct from 'STOCK_EXIT_RECONCILIATION'
    or p_projection_schema_version is distinct from 1
    or p_projection_generation is distinct from 1
    or p_subject is null or pg_catalog.btrim(p_subject) <> p_subject
    or pg_catalog.length(p_subject) not between 1 and 255
    or p_operator_profile_id is null or p_operator_profile_version is null
    or p_operator_profile_version < 1
    or p_establishment_profile_id is null
    or p_establishment_profile_version is null
    or p_establishment_profile_version < 1
    or p_idempotency_key_digest is null
    or pg_catalog.octet_length(p_idempotency_key_digest) <> 32
    or p_vehicle_key_digest is null
    or pg_catalog.octet_length(p_vehicle_key_digest) <> 32
    or p_request_sha256 is null
    or pg_catalog.octet_length(p_request_sha256) <> 32
    or p_actor_subject_hash is null
    or pg_catalog.octet_length(p_actor_subject_hash) <> 32
    or p_request_size is null or p_request_size not between 1 and 1048576
    or p_request_schema_version is null
    or p_request_schema_version not between 1 and 2147483647
    or p_request_key_id is null
    or p_request_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_request_nonce is null or pg_catalog.octet_length(p_request_nonce) <> 12
    or p_request_auth_tag is null
    or pg_catalog.octet_length(p_request_auth_tag) <> 16
    or p_request_ciphertext is null
    or pg_catalog.octet_length(p_request_ciphertext) <> p_request_size
    or p_projection_size is null or p_projection_size not between 1 and 4096
    or p_projection_key_id is null
    or p_projection_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_projection_nonce is null
    or pg_catalog.octet_length(p_projection_nonce) <> 12
    or p_projection_auth_tag is null
    or pg_catalog.octet_length(p_projection_auth_tag) <> 16
    or p_projection_ciphertext is null
    or pg_catalog.octet_length(p_projection_ciphertext) <> p_projection_size
  then
    raise exception 'operation: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into principal
    from renave.resolve_verified_renave_principals_v0072(
      p_subject,p_establishment_id,p_idempotency_key_digest);
  if not found then
    raise exception 'operation: selo regulatório ausente ou obsoleto'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  auth_now := pg_catalog.clock_timestamp();
  select pg_catalog.count(*)::integer,pg_catalog.min(j.jurisdiction_uf)
    into uf_count,effective_uf
    from renave.establishment_regulatory_jurisdiction j
   where j.tenant_id = active_tenant
     and j.establishment_id = p_establishment_id
     and j.status = 'verified' and j.valid_from <= auth_now
     and j.expires_at > auth_now;
  if uf_count <> 1 then
    raise exception 'operation: jurisdição regulatória não verificada'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select j.* into jurisdiction
    from renave.establishment_regulatory_jurisdiction j
   where j.tenant_id = active_tenant
     and j.establishment_id = p_establishment_id
     and j.jurisdiction_uf = effective_uf for share;
  select s.* into scope_item from renave.credential_service_scope s
   where s.tenant_id = active_tenant
     and s.establishment_id = p_establishment_id
     and s.service_nature = 'establishment'
     and s.jurisdiction_uf = effective_uf for share;
  select l.* into link_item from renave.credential_link l
   where l.tenant_id = active_tenant
     and l.establishment_id = p_establishment_id for share;
  if jurisdiction.establishment_id is null
    or scope_item.establishment_id is null
    or scope_item.status <> 'enabled' or scope_item.valid_from > auth_now
    or scope_item.expires_at <= auth_now
    or scope_item.jurisdiction_generation <> jurisdiction.generation
    or link_item.establishment_id is null or link_item.status <> 'enabled'
  then
    raise exception 'operation: escopo credencial não habilitado'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select o.* into existing_item from renave_stock_exit.operation o
   where o.tenant_id = active_tenant
     and o.idempotency_key_digest = p_idempotency_key_digest;
  if found then
    -- A chave já está serializada pelo resolver v0072. IDs, correlação e
    -- envelopes usam aleatoriedade por tentativa e não definem a operação.
    -- O replay devolve os bytes originais, sem substituir prova cifrada.
    if existing_item.establishment_id <> p_establishment_id
      or existing_item.remote_stock_id <> p_remote_stock_id
      or existing_item.vehicle_key_digest <> p_vehicle_key_digest
      or existing_item.request_sha256 <> p_request_sha256
      or existing_item.jurisdiction_uf <> effective_uf
      or existing_item.jurisdiction_generation <> jurisdiction.generation
      or existing_item.scope_generation <> scope_item.generation
      or existing_item.credential_link_version <> link_item.version
      or existing_item.operator_profile_id <> p_operator_profile_id
      or existing_item.operator_profile_version <> p_operator_profile_version
      or existing_item.establishment_profile_id <> p_establishment_profile_id
      or existing_item.establishment_profile_version <>
        p_establishment_profile_version
      or principal.operator_profile_id <> p_operator_profile_id
      or principal.operator_profile_version <> p_operator_profile_version
      or principal.establishment_profile_id <> p_establishment_profile_id
      or principal.establishment_profile_version <>
        p_establishment_profile_version
    then
      raise exception 'operation: conflito de idempotência'
        using errcode = 'integrity_constraint_violation';
    end if;
    return query select existing_item.id,existing_item.status,true,
      existing_item.created_at;
    return;
  end if;

  if principal.operator_profile_id <> p_operator_profile_id
    or principal.operator_profile_version <> p_operator_profile_version
    or principal.establishment_profile_id <> p_establishment_profile_id
    or principal.establishment_profile_version <>
      p_establishment_profile_version
  then
    raise exception 'operation: selo regulatório ausente ou obsoleto'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (select 1 from renave_stock_exit.operation o
      where o.tenant_id = active_tenant
        and o.vehicle_key_digest = p_vehicle_key_digest
        and o.mutation_family = 'STOCK_EXIT') then
    raise exception 'operation: mutação ativa conflitante'
      using errcode = 'integrity_constraint_violation';
  end if;

  begin
    insert into renave_stock_exit.operation (
      tenant_id,id,establishment_id,kind,mutation_family,status,remote_stock_id,
      idempotency_key_digest,vehicle_key_digest,request_sha256,request_size,
      request_schema_version,request_key_id,request_nonce,request_auth_tag,
      request_ciphertext,actor_subject_hash,correlation_id,
      reconciliation_projection_kind,reconciliation_projection_schema_version,
      reconciliation_projection_generation,reconciliation_projection_size,
      reconciliation_projection_key_id,reconciliation_projection_nonce,
      reconciliation_projection_auth_tag,reconciliation_projection_ciphertext,
      service_nature,jurisdiction_uf,jurisdiction_generation,scope_generation,
      credential_link_version,operator_profile_id,operator_profile_version,
      establishment_profile_id,establishment_profile_version)
    values (active_tenant,p_operation_id,p_establishment_id,p_kind,
      p_mutation_family,'HELD_LOCAL',p_remote_stock_id,p_idempotency_key_digest,
      p_vehicle_key_digest,p_request_sha256,p_request_size,
      p_request_schema_version,p_request_key_id,p_request_nonce,
      p_request_auth_tag,p_request_ciphertext,p_actor_subject_hash,
      p_correlation_id,p_projection_kind,p_projection_schema_version,
      p_projection_generation,p_projection_size,p_projection_key_id,
      p_projection_nonce,p_projection_auth_tag,p_projection_ciphertext,
      'establishment',effective_uf,jurisdiction.generation,
      scope_item.generation,link_item.version,p_operator_profile_id,
      p_operator_profile_version,p_establishment_profile_id,
      p_establishment_profile_version)
    returning * into created_item;
  exception when unique_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint in (
      'stock_exit_operation_active_vehicle_key',
      'stock_exit_operation_active_remote_stock'
    )
    then
      raise exception 'operation: mutação ativa conflitante'
        using errcode = 'integrity_constraint_violation';
    elsif violated_constraint = 'operation_pkey' then
      raise exception 'operation: identificador já utilizado'
        using errcode = 'integrity_constraint_violation';
    else
      raise exception 'operation: conflito de idempotência'
        using errcode = 'integrity_constraint_violation';
    end if;
  end;

  insert into renave_stock_exit.operation_transition (
    tenant_id,operation_id,from_status,to_status,actor_subject_hash,
    correlation_id,changed_at)
  values (active_tenant,created_item.id,null,'HELD_LOCAL',
    p_actor_subject_hash,p_correlation_id,created_item.created_at);
  return query select created_item.id,created_item.status,false,
    created_item.created_at;
end
$$;

create function renave_stock_exit.get_operation_summary(p_operation_id uuid)
returns table(operation_id uuid,establishment_id uuid,kind text,
  mutation_family text,status text,version bigint,correlation_id uuid,
  created_at timestamptz,updated_at timestamptz)
language sql stable security definer set search_path = pg_catalog as $$
  select o.id,o.establishment_id,o.kind,o.mutation_family,o.status,
    o.version,o.correlation_id,o.created_at,o.updated_at
  from renave_stock_exit.operation o
  where o.tenant_id = renave.current_tenant_id() and o.id = p_operation_id
$$;

revoke all on all tables in schema renave_stock_exit from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on all sequences in schema renave_stock_exit from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on all functions in schema renave_stock_exit from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_stock_exit.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,
  uuid,bigint,uuid,bigint,bigint) to renave_app;
grant execute on function renave_stock_exit.get_operation_summary(uuid)
  to renave_app;
