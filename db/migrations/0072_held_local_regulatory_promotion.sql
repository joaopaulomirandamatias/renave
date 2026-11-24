-- 0072 — Selo regulatório imutável e promoção offline de HELD_LOCAL.
-- Tabelas existentes não recebem backfill: ausência de selo permanece deny.

alter table renave.credential_service_scope
  add column jurisdiction_generation bigint;
alter table renave.credential_service_scope_history
  add column jurisdiction_generation bigint;
alter table renave.credential_service_scope add constraint
  credential_service_scope_jurisdiction_generation_valid check (
    jurisdiction_generation is null or jurisdiction_generation>0);
alter table renave.credential_service_scope_history add constraint
  credential_service_scope_history_jurisdiction_generation_valid check (
    jurisdiction_generation is null or jurisdiction_generation>0);

create table renave.operation_authorization_binding (
  tenant_id uuid not null,operation_id uuid not null,
  service_nature text not null,jurisdiction_uf text not null,
  jurisdiction_generation bigint not null,scope_generation bigint not null,
  credential_link_version bigint not null,operator_profile_id uuid not null,
  operator_profile_version bigint not null,
  establishment_profile_id uuid not null,
  establishment_profile_version bigint not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(tenant_id,operation_id),
  foreign key(tenant_id,operation_id)
    references renave.operation(tenant_id,id) on delete restrict,
  foreign key(tenant_id,operator_profile_id)
    references renave.operator_identity_profile(tenant_id,id) on delete restrict,
  foreign key(tenant_id,establishment_profile_id)
    references renave.establishment_renave_profile(tenant_id,id) on delete restrict,
  constraint operation_authorization_binding_nature_valid check(
    service_nature in ('establishment','ite','manufacturer')),
  constraint operation_authorization_binding_uf_valid check(jurisdiction_uf in(
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
    'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
  constraint operation_authorization_binding_versions_valid check(
    jurisdiction_generation>0 and scope_generation>0
    and credential_link_version>0 and operator_profile_version>0
    and establishment_profile_version>0));
alter table renave.operation_authorization_binding enable row level security;
alter table renave.operation_authorization_binding force row level security;
create policy operation_authorization_binding_isolation
  on renave.operation_authorization_binding
  using(tenant_id=(select renave.current_tenant_id()))
  with check(tenant_id=(select renave.current_tenant_id()));
create function renave.operation_authorization_binding_reject_change()
returns trigger language plpgsql set search_path=pg_catalog as $$begin
  raise exception 'operation authorization binding é imutável'
    using errcode='insufficient_privilege'; end$$;
create trigger operation_authorization_binding_append_only
  before update or delete on renave.operation_authorization_binding
  for each row execute function
    renave.operation_authorization_binding_reject_change();
create trigger operation_authorization_binding_reject_truncate
  before truncate on renave.operation_authorization_binding
  for each statement execute function
    renave.operation_authorization_binding_reject_change();

create table renave.operation_promotion_decision (
  tenant_id uuid not null,operation_id uuid not null,outbox_id uuid not null,
  decision_ticket_digest bytea not null,evidence_digest bytea not null,
  changed_by_digest bytea not null,
  decided_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(tenant_id,operation_id),unique(outbox_id),
  foreign key(tenant_id,operation_id)
    references renave.operation(tenant_id,id) on delete restrict,
  foreign key(outbox_id)
    references renave.operation_outbox(id) on delete restrict,
  constraint operation_promotion_decision_digests_valid check(
    pg_catalog.octet_length(decision_ticket_digest)=32
    and pg_catalog.octet_length(evidence_digest)=32
    and pg_catalog.octet_length(changed_by_digest)=32));
alter table renave.operation_promotion_decision enable row level security;
alter table renave.operation_promotion_decision force row level security;
create policy operation_promotion_decision_isolation
  on renave.operation_promotion_decision
  using(tenant_id=(select renave.current_tenant_id()))
  with check(tenant_id=(select renave.current_tenant_id()));
create function renave.operation_promotion_decision_reject_change()
returns trigger language plpgsql set search_path=pg_catalog as $$begin
  raise exception 'operation promotion decision é imutável'
    using errcode='insufficient_privilege'; end$$;
create trigger operation_promotion_decision_append_only
  before update or delete on renave.operation_promotion_decision
  for each row execute function renave.operation_promotion_decision_reject_change();
create trigger operation_promotion_decision_reject_truncate
  before truncate on renave.operation_promotion_decision
  for each statement execute function
    renave.operation_promotion_decision_reject_change();

-- Cada transição é um rebind explícito à geração atual da jurisdição.
create or replace function renave_admin.transition_credential_service_scope(
  p_establishment_id uuid,p_service_nature text,p_jurisdiction_uf text,
  p_status text,p_valid_from timestamptz,p_expires_at timestamptz,
  p_evidence_digest bytea,p_decision_ticket_digest bytea,
  p_changed_by_digest bytea)
returns renave.credential_service_scope language plpgsql security definer
set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id();
  old_item renave.credential_service_scope;
  jurisdiction renave.establishment_regulatory_jurisdiction;
  next_item renave.credential_service_scope; next_version bigint;
begin
  if session_user<>'renave_credential_scope_provisioner' then
    raise exception 'credential service scope: papel offline obrigatório'
      using errcode='insufficient_privilege'; end if;
  if active_tenant is null or p_establishment_id is null
    or p_service_nature not in('establishment','ite','manufacturer')
    or p_jurisdiction_uf not in('AC','AL','AP','AM','BA','CE','DF','ES','GO',
      'MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR',
      'SC','SP','SE','TO')
    or p_status not in('pending','enabled','suspended','revoked')
    or p_valid_from is null or p_expires_at is null
    or p_valid_from>=p_expires_at
    or p_expires_at>p_valid_from+interval '366 days'
    or pg_catalog.octet_length(p_evidence_digest)<>32
    or pg_catalog.octet_length(p_decision_ticket_digest)<>32
    or pg_catalog.octet_length(p_changed_by_digest)<>32 then
    raise exception 'credential service scope: entrada inválida'
      using errcode='invalid_parameter_value'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text||':'||
      p_service_nature||':'||p_jurisdiction_uf,700070));
  perform 1 from renave.establishment e where e.tenant_id=active_tenant
    and e.id=p_establishment_id and e.status='active' for share;
  if not found then raise exception 'credential service scope: estabelecimento indisponível'
    using errcode='insufficient_privilege'; end if;
  select j.* into jurisdiction
    from renave.establishment_regulatory_jurisdiction j
    where j.tenant_id=active_tenant and j.establishment_id=p_establishment_id
      and j.jurisdiction_uf=p_jurisdiction_uf for share;
  if not found then raise exception 'credential service scope: jurisdição ausente'
    using errcode='insufficient_privilege'; end if;
  select s.* into old_item from renave.credential_service_scope s
    where s.tenant_id=active_tenant and s.establishment_id=p_establishment_id
      and s.service_nature=p_service_nature
      and s.jurisdiction_uf=p_jurisdiction_uf for update;
  if found then
    if old_item.status='revoked' or not(case old_item.status
      when 'pending' then p_status in('enabled','revoked')
      when 'enabled' then p_status in('suspended','revoked')
      when 'suspended' then p_status in('enabled','revoked') else false end)
    then raise exception 'credential service scope: transição inválida'
      using errcode='integrity_constraint_violation'; end if;
    next_version:=old_item.version+1;
    update renave.credential_service_scope set status=p_status,
      version=next_version,generation=next_version,
      jurisdiction_generation=jurisdiction.generation,
      valid_from=p_valid_from,expires_at=p_expires_at,
      evidence_digest=p_evidence_digest,
      decision_ticket_digest=p_decision_ticket_digest,
      changed_by_digest=p_changed_by_digest,
      updated_at=pg_catalog.clock_timestamp()
    where tenant_id=active_tenant and establishment_id=p_establishment_id
      and service_nature=p_service_nature and jurisdiction_uf=p_jurisdiction_uf
    returning * into next_item;
  else
    next_version:=1;
    insert into renave.credential_service_scope(tenant_id,establishment_id,
      service_nature,jurisdiction_uf,status,version,generation,
      jurisdiction_generation,valid_from,expires_at,evidence_digest,
      decision_ticket_digest,changed_by_digest) values(active_tenant,
      p_establishment_id,p_service_nature,p_jurisdiction_uf,p_status,1,1,
      jurisdiction.generation,p_valid_from,p_expires_at,p_evidence_digest,
      p_decision_ticket_digest,p_changed_by_digest) returning * into next_item;
  end if;
  insert into renave.credential_service_scope_history(tenant_id,
    establishment_id,service_nature,jurisdiction_uf,version,previous_status,
    status,generation,jurisdiction_generation,valid_from,expires_at,
    evidence_digest,decision_ticket_digest,changed_by_digest,changed_at)
  values(active_tenant,p_establishment_id,p_service_nature,p_jurisdiction_uf,
    next_version,old_item.status,next_item.status,next_item.generation,
    next_item.jurisdiction_generation,next_item.valid_from,next_item.expires_at,
    next_item.evidence_digest,next_item.decision_ticket_digest,
    next_item.changed_by_digest,next_item.updated_at);
  return next_item;
end$$;

create function renave.resolve_verified_renave_principals_v0072(
  p_subject text,p_establishment_id uuid,p_idempotency_key_digest bytea)
returns table(active_tenant_id uuid,operator_profile_id uuid,
  operator_profile_version bigint,operator_envelope_schema_version integer,
  operator_envelope_key_id text,operator_envelope_nonce bytea,
  operator_envelope_auth_tag bytea,operator_envelope_ciphertext bytea,
  operator_envelope_aad_sha256 bytea,operator_hmac_key_id text,
  operator_identity_hmac bytea,establishment_profile_id uuid,
  establishment_profile_version bigint,
  establishment_envelope_schema_version integer,
  establishment_envelope_key_id text,establishment_envelope_nonce bytea,
  establishment_envelope_auth_tag bytea,
  establishment_envelope_ciphertext bytea,
  establishment_envelope_aad_sha256 bytea,establishment_hmac_key_id text,
  establishment_email_hmac bytea)
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id(); candidate_uf text;
begin
  if active_tenant is null or p_establishment_id is null
    or pg_catalog.octet_length(p_idempotency_key_digest)<>32 then
    raise exception 'verified RENAVE principal: entrada inválida'
      using errcode='invalid_parameter_value'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||pg_catalog.encode(p_idempotency_key_digest,'hex'),
    250025));
  foreach candidate_uf in array array['AC','AL','AM','AP','BA','CE','DF','ES',
    'GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR',
    'RS','SC','SE','SP','TO'] loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      active_tenant::text||':'||p_establishment_id::text||':establishment:'||
        candidate_uf,700070));
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text,170017));
  return query select r.active_tenant_id,r.operator_profile_id,o.version,
  r.operator_envelope_schema_version,r.operator_envelope_key_id,
  r.operator_envelope_nonce,r.operator_envelope_auth_tag,
  r.operator_envelope_ciphertext,r.operator_envelope_aad_sha256,
  r.operator_hmac_key_id,r.operator_identity_hmac,
  r.establishment_profile_id,e.version,
  r.establishment_envelope_schema_version,r.establishment_envelope_key_id,
  r.establishment_envelope_nonce,r.establishment_envelope_auth_tag,
  r.establishment_envelope_ciphertext,r.establishment_envelope_aad_sha256,
  r.establishment_hmac_key_id,r.establishment_email_hmac
from renave.resolve_verified_renave_principals(
  p_subject,p_establishment_id,p_idempotency_key_digest) r
join renave.operator_identity_profile o
  on o.tenant_id=r.active_tenant_id and o.id=r.operator_profile_id
join renave.establishment_renave_profile e
  on e.tenant_id=r.active_tenant_id and e.id=r.establishment_profile_id
  ;
end$$;

revoke execute on function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)
from renave_app;

create function renave.create_held_local_operation(
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
  p_establishment_profile_id uuid,p_establishment_profile_version bigint)
returns table(operation_id uuid,operation_status text,replayed boolean,
  operation_created_at timestamptz)
language plpgsql security definer set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id();
  nature text; effective_uf text; uf_count integer; auth_now timestamptz;
  candidate_uf text;
  jurisdiction renave.establishment_regulatory_jurisdiction;
  scope_item renave.credential_service_scope; link renave.credential_link;
  operator_profile renave.operator_identity_profile;
  establishment_profile renave.establishment_renave_profile;
  created record; binding renave.operation_authorization_binding;
begin
  if active_tenant is null or p_establishment_id is null
    or p_subject is null or pg_catalog.btrim(p_subject)<>p_subject
    or pg_catalog.length(p_subject) not between 1 and 255
    or p_operator_profile_id is null or p_operator_profile_version is null
    or p_operator_profile_version<1
    or p_establishment_profile_id is null
    or p_establishment_profile_version is null
    or p_establishment_profile_version<1 then
    raise exception 'operation: autorização inválida'
      using errcode='invalid_parameter_value'; end if;
  nature:=case p_kind when 'USED_STOCK_ENTRY' then 'establishment' end;
  if nature is null then raise exception 'operation: tipo inválido'
    using errcode='invalid_parameter_value'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||pg_catalog.encode(p_idempotency_key_digest,'hex'),
    250025));
  -- A UF efetiva só pode ser escolhida depois de todos os fences candidatos.
  -- A ordem lexical fixa evita que duas criações concorrentes invertam locks.
  foreach candidate_uf in array array['AC','AL','AM','AP','BA','CE','DF','ES',
    'GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR',
    'RS','SC','SE','SP','TO'] loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      active_tenant::text||':'||p_establishment_id::text||':'||nature||':'||
        candidate_uf,700070));
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||p_establishment_id::text,170017));
  perform 1 from renave.establishment_regulatory_jurisdiction j
    where j.tenant_id=active_tenant and j.establishment_id=p_establishment_id
    for share;
  perform 1 from renave.credential_service_scope s
    where s.tenant_id=active_tenant and s.establishment_id=p_establishment_id
      and s.service_nature=nature for share;
  select l.* into link from renave.credential_link l
    where l.tenant_id=active_tenant and l.establishment_id=p_establishment_id
    for share;
  perform 1 from renave.tenant t where t.id=active_tenant
    and t.status='active' for share;
  if not found then raise exception 'operation: autorização indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment e where e.tenant_id=active_tenant
    and e.id=p_establishment_id and e.status='active' for share;
  if not found then raise exception 'operation: autorização indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  select p.* into operator_profile from renave.operator_identity_profile p
    where p.tenant_id=active_tenant and p.subject=p_subject
      and p.id=p_operator_profile_id for share;
  select p.* into establishment_profile
    from renave.establishment_renave_profile p
    where p.tenant_id=active_tenant and p.establishment_id=p_establishment_id
      and p.id=p_establishment_profile_id for share;
  perform 1 from renave.tenant_user u where u.tenant_id=active_tenant
    and u.subject=p_subject and u.status='active' for share;
  if not found then raise exception 'operation: autorização indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.tenant_role_grant g where g.tenant_id=active_tenant
    and g.subject=p_subject and g.role='renave_operator' for share;
  if not found then raise exception 'operation: autorização indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment_role_scope r
    where r.tenant_id=active_tenant and r.subject=p_subject
      and r.role='renave_operator' and r.establishment_id=p_establishment_id
    for share;
  if not found then raise exception 'operation: autorização indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  auth_now:=pg_catalog.clock_timestamp();
  select count(*)::integer,min(j.jurisdiction_uf) into uf_count,effective_uf
    from renave.establishment_regulatory_jurisdiction j
    where j.tenant_id=active_tenant and j.establishment_id=p_establishment_id
      and j.status='verified' and j.valid_from<=auth_now
      and j.expires_at>auth_now;
  select j.* into jurisdiction
    from renave.establishment_regulatory_jurisdiction j
    where j.tenant_id=active_tenant and j.establishment_id=p_establishment_id
      and j.jurisdiction_uf=effective_uf;
  select s.* into scope_item from renave.credential_service_scope s
    where s.tenant_id=active_tenant and s.establishment_id=p_establishment_id
      and s.service_nature=nature and s.jurisdiction_uf=effective_uf;
  if uf_count<>1 or jurisdiction.establishment_id is null
    or scope_item.establishment_id is null or link.establishment_id is null
    or operator_profile.id is null or establishment_profile.id is null
    or jurisdiction.jurisdiction_uf is distinct from effective_uf
    or jurisdiction.status<>'verified' or jurisdiction.valid_from>auth_now
    or jurisdiction.expires_at<=auth_now or scope_item.status<>'enabled'
    or scope_item.jurisdiction_generation is distinct from jurisdiction.generation
    or scope_item.valid_from>auth_now or scope_item.expires_at<=auth_now
    or link.status<>'enabled' or operator_profile.status<>'verified'
    or operator_profile.version<>p_operator_profile_version
    or establishment_profile.status<>'verified'
    or establishment_profile.version<>p_establishment_profile_version then
    raise exception 'operation: autorização indisponível'
      using errcode='object_not_in_prerequisite_state'; end if;
  select * into created from renave.create_held_local_operation(
    p_operation_id,p_establishment_id,p_kind,p_mutation_family,
    p_idempotency_key_digest,p_vehicle_key_digest,p_request_sha256,
    p_request_size,p_request_schema_version,p_request_key_id,p_request_nonce,
    p_request_auth_tag,p_request_ciphertext,p_actor_subject_hash,
    p_correlation_id,p_projection_kind,p_projection_schema_version,
    p_projection_generation,p_projection_size,p_projection_key_id,
    p_projection_nonce,p_projection_auth_tag,p_projection_ciphertext);
  if created.replayed then
    select b.* into binding from renave.operation_authorization_binding b
      where b.tenant_id=active_tenant and b.operation_id=created.operation_id
      for share;
    if not found or binding.service_nature<>nature
      or binding.jurisdiction_uf<>effective_uf
      or binding.jurisdiction_generation<>jurisdiction.generation
      or binding.scope_generation<>scope_item.generation
      or binding.credential_link_version<>link.version
      or binding.operator_profile_id<>operator_profile.id
      or binding.operator_profile_version<>operator_profile.version
      or binding.establishment_profile_id<>establishment_profile.id
      or binding.establishment_profile_version<>establishment_profile.version
    then raise exception 'operation: selo regulatório ausente ou obsoleto'
      using errcode='object_not_in_prerequisite_state'; end if;
  else
    insert into renave.operation_authorization_binding(tenant_id,operation_id,
      service_nature,jurisdiction_uf,jurisdiction_generation,scope_generation,
      credential_link_version,operator_profile_id,operator_profile_version,
      establishment_profile_id,establishment_profile_version)
    values(active_tenant,created.operation_id,nature,effective_uf,
      jurisdiction.generation,scope_item.generation,link.version,
      operator_profile.id,operator_profile.version,establishment_profile.id,
      establishment_profile.version);
  end if;
  return query select created.operation_id,created.operation_status,
    created.replayed,created.operation_created_at;
end$$;

create function renave_runtime.operation_authorization_binding_is_current(
  p_operation_id uuid,p_authorization_now timestamptz)
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select count(*)=1 and coalesce(bool_and(
  o.status in('HELD_LOCAL','PENDING_SEND') and t.status='active'
  and e.status='active' and l.status='enabled'
  and l.version=b.credential_link_version and op.status='verified'
  and op.version=b.operator_profile_version and u.status='active'
  and ep.status='verified' and ep.version=b.establishment_profile_version
  and j.status='verified' and j.generation=b.jurisdiction_generation
  and j.valid_from<=p_authorization_now and j.expires_at>p_authorization_now
  and s.status='enabled' and s.generation=b.scope_generation
  and s.jurisdiction_generation=b.jurisdiction_generation
  and s.valid_from<=p_authorization_now and s.expires_at>p_authorization_now
  and(select count(*)=1 from renave.establishment_regulatory_jurisdiction x
    where x.tenant_id=o.tenant_id and x.establishment_id=o.establishment_id
      and x.status='verified' and x.valid_from<=p_authorization_now
      and x.expires_at>p_authorization_now)),false)
from renave.operation o join renave.operation_authorization_binding b
  on b.tenant_id=o.tenant_id and b.operation_id=o.id
join renave.tenant t on t.id=o.tenant_id
join renave.establishment e on e.tenant_id=o.tenant_id
  and e.id=o.establishment_id
join renave.credential_link l on l.tenant_id=o.tenant_id
  and l.establishment_id=o.establishment_id
join renave.operator_identity_profile op on op.tenant_id=o.tenant_id
  and op.id=b.operator_profile_id
join renave.tenant_user u on u.tenant_id=o.tenant_id and u.subject=op.subject
join renave.tenant_role_grant g on g.tenant_id=o.tenant_id
  and g.subject=op.subject and g.role='renave_operator'
join renave.establishment_role_scope r on r.tenant_id=o.tenant_id
  and r.subject=op.subject and r.role='renave_operator'
  and r.establishment_id=o.establishment_id
join renave.establishment_renave_profile ep on ep.tenant_id=o.tenant_id
  and ep.id=b.establishment_profile_id and ep.establishment_id=o.establishment_id
join renave.establishment_regulatory_jurisdiction j on j.tenant_id=o.tenant_id
  and j.establishment_id=o.establishment_id and j.jurisdiction_uf=b.jurisdiction_uf
join renave.credential_service_scope s on s.tenant_id=o.tenant_id
  and s.establishment_id=o.establishment_id and s.service_nature=b.service_nature
  and s.jurisdiction_uf=b.jurisdiction_uf
where o.tenant_id=renave.current_tenant_id() and o.id=p_operation_id
  and b.service_nature=case o.kind when 'USED_STOCK_ENTRY' then 'establishment' end$$;

create or replace function renave.operation_guard()
returns trigger language plpgsql set search_path=pg_catalog as $$begin
  if tg_op='INSERT' then
    if new.status not in('HELD_LOCAL','PENDING_SEND') or new.version<>1 then
      raise exception 'operation: estado inicial inválido'
        using errcode='integrity_constraint_violation'; end if; return new;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
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
      using errcode='integrity_constraint_violation'; end if;
  if new.version<>old.version+1 then raise exception 'operation: versão inválida'
    using errcode='integrity_constraint_violation'; end if;
  if not(case old.status
    when 'HELD_LOCAL' then new.status='PENDING_SEND'
    when 'PENDING_SEND' then new.status='SENT'
    when 'SENT' then new.status in('CONFIRMED','REJECTED','PENDING_RECONCILIATION')
    when 'PENDING_RECONCILIATION' then
      new.status in('CONFIRMED','MANUAL_REVIEW','PENDING_SEND') else false end)
  then raise exception 'operation: transição inválida'
    using errcode='integrity_constraint_violation'; end if; return new;
end$$;

create function renave_admin.promote_held_local_operation(p_operation_id uuid,
  p_decision_ticket_digest bytea,p_evidence_digest bytea,
  p_changed_by_digest bytea)
returns table(operation_id uuid,operation_status text,replayed boolean,
  outbox_id uuid,promoted_at timestamptz)
language plpgsql security definer set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id(); target_establishment_id uuid;
  operation_item renave.operation; binding renave.operation_authorization_binding;
  outbox_item renave.operation_outbox; auth_now timestamptz;
  decision renave.operation_promotion_decision;
begin
  if session_user<>'renave_operation_promoter' then
    raise exception 'operation promotion: papel offline obrigatório'
      using errcode='insufficient_privilege'; end if;
  if active_tenant is null or p_operation_id is null
    or p_decision_ticket_digest is null
    or pg_catalog.octet_length(p_decision_ticket_digest)<>32
    or p_evidence_digest is null
    or pg_catalog.octet_length(p_evidence_digest)<>32
    or p_changed_by_digest is null
    or pg_catalog.octet_length(p_changed_by_digest)<>32 then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state'; end if;
  select o.establishment_id into target_establishment_id from renave.operation o
    where o.tenant_id=active_tenant and o.id=p_operation_id;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=p_operation_id;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text||':'||
      binding.service_nature||':'||binding.jurisdiction_uf,700070));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text,170017));
  select o.* into operation_item from renave.operation o
    where o.tenant_id=active_tenant and o.id=p_operation_id for update;
  if not found or operation_item.establishment_id<>target_establishment_id
    or operation_item.status not in('HELD_LOCAL','PENDING_SEND') then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state'; end if;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=p_operation_id for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.tenant t where t.id=active_tenant
    and t.status='active' for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment e where e.tenant_id=active_tenant
    and e.id=target_establishment_id and e.status='active' for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment_regulatory_jurisdiction x
    where x.tenant_id=active_tenant and x.establishment_id=target_establishment_id for share;
  perform 1 from renave.credential_service_scope x
    where x.tenant_id=active_tenant and x.establishment_id=target_establishment_id for share;
  perform 1 from renave.credential_link x where x.tenant_id=active_tenant
    and x.establishment_id=target_establishment_id for share;
  perform 1 from renave.operator_identity_profile x where x.tenant_id=active_tenant
    and x.id=binding.operator_profile_id for share;
  perform 1 from renave.tenant_user u where u.tenant_id=active_tenant
    and u.status='active' and u.subject=(select p.subject
      from renave.operator_identity_profile p where p.tenant_id=active_tenant
        and p.id=binding.operator_profile_id) for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.tenant_role_grant g where g.tenant_id=active_tenant
    and g.role='renave_operator' and g.subject=(select p.subject
      from renave.operator_identity_profile p where p.tenant_id=active_tenant
        and p.id=binding.operator_profile_id) for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment_role_scope r
    where r.tenant_id=active_tenant and r.role='renave_operator'
      and r.establishment_id=target_establishment_id
      and r.subject=(select p.subject from renave.operator_identity_profile p
        where p.tenant_id=active_tenant and p.id=binding.operator_profile_id)
    for share;
  if not found then raise exception 'operation promotion: indisponível'
    using errcode='object_not_in_prerequisite_state'; end if;
  perform 1 from renave.establishment_renave_profile x
    where x.tenant_id=active_tenant and x.id=binding.establishment_profile_id for share;
  auth_now:=pg_catalog.clock_timestamp();
  if not renave_runtime.operation_authorization_binding_is_current(
    p_operation_id,auth_now) then raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state'; end if;
  if operation_item.status='PENDING_SEND' then
    select x.* into outbox_item from renave.operation_outbox x
      where x.tenant_id=active_tenant and x.operation_id=p_operation_id
        and x.event_type='SEND_MUTATION' for share;
    if not found then raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state'; end if;
    select d.* into decision from renave.operation_promotion_decision d
      where d.tenant_id=active_tenant and d.operation_id=p_operation_id
      for share;
    if not found or decision.outbox_id<>outbox_item.id
      or decision.decision_ticket_digest<>p_decision_ticket_digest
      or decision.evidence_digest<>p_evidence_digest
      or decision.changed_by_digest<>p_changed_by_digest then
      raise exception 'operation promotion: indisponível'
        using errcode='object_not_in_prerequisite_state'; end if;
    return query select operation_item.id,operation_item.status,true,
      outbox_item.id,decision.decided_at; return;
  end if;
  update renave.operation o set status='PENDING_SEND',
    version=operation_item.version+1,updated_at=auth_now,last_error_code=null
    where o.tenant_id=active_tenant and o.id=p_operation_id
    returning o.* into operation_item;
  insert into renave.operation_transition(tenant_id,operation_id,version,
    previous_status,status,reason_code,actor_hash,changed_at)
  values(active_tenant,p_operation_id,operation_item.version,'HELD_LOCAL',
    'PENDING_SEND','REGULATORY_AUTHORIZATION_REVALIDATED',
    p_changed_by_digest,auth_now);
  insert into renave.operation_outbox(tenant_id,operation_id,event_type,
    delivery_status,available_at,created_at,updated_at)
  values(active_tenant,p_operation_id,'SEND_MUTATION','READY',auth_now,
    auth_now,auth_now) returning * into outbox_item;
  insert into renave.operation_promotion_decision(tenant_id,operation_id,
    outbox_id,decision_ticket_digest,evidence_digest,changed_by_digest,
    decided_at) values(active_tenant,p_operation_id,outbox_item.id,
    p_decision_ticket_digest,p_evidence_digest,p_changed_by_digest,auth_now);
  return query select operation_item.id,operation_item.status,false,
    outbox_item.id,auth_now;
end$$;

alter function renave.begin_operation_send_dispatch(uuid,uuid,uuid)
  rename to begin_operation_send_dispatch_without_authorization_v0029;
create function renave.begin_operation_send_dispatch(
  p_outbox_id uuid,p_lease_owner uuid,p_lease_token uuid)
returns table(outbox_id uuid,operation_id uuid,tenant_id uuid,
  establishment_id uuid,correlation_id uuid,kind text,mutation_family text,
  operation_version bigint,sent_at timestamptz,attempt_count integer,
  lease_owner uuid,lease_token uuid,lease_expires_at timestamptz,
  idempotency_key_digest bytea,vehicle_key_digest bytea,
  actor_subject_hash bytea,request_sha256 bytea,request_size integer,
  request_schema_version integer,request_key_id text,request_nonce bytea,
  request_auth_tag bytea,request_ciphertext bytea)
language plpgsql security definer set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id(); operation_candidate uuid;
  establishment_candidate uuid; binding renave.operation_authorization_binding;
  claimed renave.operation_outbox; pending renave.operation;
  sent_operation renave.operation; sent_outbox renave.operation_outbox;
  dispatch_now timestamptz;
begin
  if active_tenant is null or p_outbox_id is null or p_lease_owner is null
    or p_lease_token is null then return; end if;
  select x.operation_id into operation_candidate from renave.operation_outbox x
    where x.tenant_id=active_tenant and x.id=p_outbox_id;
  select o.establishment_id into establishment_candidate from renave.operation o
    where o.tenant_id=active_tenant and o.id=operation_candidate;
  if establishment_candidate is null then return; end if;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=operation_candidate;
  if not found then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||establishment_candidate::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||establishment_candidate::text||':'||
      binding.service_nature||':'||binding.jurisdiction_uf,700070));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||establishment_candidate::text,170017));
  select x.* into claimed from renave.operation_outbox x
    where x.tenant_id=active_tenant and x.id=p_outbox_id for update;
  select o.* into pending from renave.operation o where o.tenant_id=active_tenant
    and o.id=operation_candidate for update;
  if not found or pending.establishment_id<>establishment_candidate then return; end if;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=operation_candidate for share;
  if not found then return; end if;
  perform 1 from renave.tenant t where t.id=active_tenant
    and t.status='active' for share;
  if not found then return; end if;
  perform 1 from renave.establishment e where e.tenant_id=active_tenant
    and e.id=establishment_candidate and e.status='active' for share;
  if not found then return; end if;
  perform 1 from renave.establishment_regulatory_jurisdiction x
    where x.tenant_id=active_tenant and x.establishment_id=establishment_candidate for share;
  perform 1 from renave.credential_service_scope x where x.tenant_id=active_tenant
    and x.establishment_id=establishment_candidate for share;
  perform 1 from renave.credential_link x where x.tenant_id=active_tenant
    and x.establishment_id=establishment_candidate for share;
  perform 1 from renave.operator_identity_profile x where x.tenant_id=active_tenant
    and x.id=binding.operator_profile_id for share;
  perform 1 from renave.tenant_user u where u.tenant_id=active_tenant
    and u.status='active' and u.subject=(select p.subject
      from renave.operator_identity_profile p where p.tenant_id=active_tenant
        and p.id=binding.operator_profile_id) for share;
  if not found then return; end if;
  perform 1 from renave.tenant_role_grant g where g.tenant_id=active_tenant
    and g.role='renave_operator' and g.subject=(select p.subject
      from renave.operator_identity_profile p where p.tenant_id=active_tenant
        and p.id=binding.operator_profile_id) for share;
  if not found then return; end if;
  perform 1 from renave.establishment_role_scope r
    where r.tenant_id=active_tenant and r.role='renave_operator'
      and r.establishment_id=establishment_candidate
      and r.subject=(select p.subject from renave.operator_identity_profile p
        where p.tenant_id=active_tenant and p.id=binding.operator_profile_id)
    for share;
  if not found then return; end if;
  perform 1 from renave.establishment_renave_profile x where x.tenant_id=active_tenant
    and x.id=binding.establishment_profile_id for share;
  dispatch_now:=pg_catalog.clock_timestamp();
  if claimed.id is null or claimed.operation_id<>operation_candidate
    or claimed.event_type<>'SEND_MUTATION' or claimed.delivery_status<>'LEASED'
    or claimed.lease_owner is distinct from p_lease_owner
    or claimed.lease_token is distinct from p_lease_token
    or claimed.lease_expires_at is null or claimed.lease_expires_at<=dispatch_now
    or pending.status<>'PENDING_SEND'
    or not renave_runtime.operation_authorization_binding_is_current(
      pending.id,dispatch_now) then return; end if;
  update renave.operation o set status='SENT',version=pending.version+1,
    sent_at=dispatch_now,last_error_code=null,updated_at=dispatch_now
    where o.tenant_id=active_tenant and o.id=pending.id returning o.* into sent_operation;
  insert into renave.operation_transition(tenant_id,operation_id,version,
    previous_status,status,reason_code,actor_hash,changed_at)
  values(active_tenant,sent_operation.id,sent_operation.version,'PENDING_SEND',
    'SENT','DISPATCH_BEGUN',pending.actor_subject_hash,dispatch_now);
  update renave.operation_outbox x set lease_expires_at=dispatch_now+interval '300 seconds',
    updated_at=dispatch_now where x.tenant_id=active_tenant and x.id=claimed.id
    returning x.* into sent_outbox;
  return query select sent_outbox.id,sent_operation.id,sent_operation.tenant_id,
    sent_operation.establishment_id,sent_operation.correlation_id,
    sent_operation.kind,sent_operation.mutation_family,sent_operation.version,
    sent_operation.sent_at,sent_outbox.attempt_count,sent_outbox.lease_owner,
    sent_outbox.lease_token,sent_outbox.lease_expires_at,
    sent_operation.idempotency_key_digest,sent_operation.vehicle_key_digest,
    sent_operation.actor_subject_hash,sent_operation.request_sha256,
    sent_operation.request_size,sent_operation.request_schema_version,
    sent_operation.request_key_id,sent_operation.request_nonce,
    sent_operation.request_auth_tag,sent_operation.request_ciphertext;
end$$;

revoke all on table renave.operation_authorization_binding from public,
  renave_app,renave_credential_scope_provisioner,renave_identity_app,
  renave_maintenance_app,renave_operation_worker,renave_operation_promoter,
  renave_profile_provisioner,renave_profile_reader,renave_platform_reader,
  renave_platform_provisioner;
revoke all on table renave.operation_promotion_decision from public,
  renave_app,renave_credential_scope_provisioner,renave_identity_app,
  renave_maintenance_app,renave_operation_worker,renave_operation_promoter,
  renave_profile_provisioner,renave_profile_reader,renave_platform_reader,
  renave_platform_provisioner;
revoke all on function renave.operation_authorization_binding_reject_change(),
  renave.operation_promotion_decision_reject_change(),
  renave_runtime.operation_authorization_binding_is_current(uuid,timestamptz),
  renave.begin_operation_send_dispatch_without_authorization_v0029(uuid,uuid,uuid),
  renave.begin_operation_send_dispatch(uuid,uuid,uuid)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on function renave.resolve_verified_renave_principals_v0072(text,uuid,bytea)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave.resolve_verified_renave_principals_v0072(text,uuid,bytea)
to renave_app;
revoke all on function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,
  text,uuid,bigint,uuid,bigint)
from public,renave_credential_scope_provisioner,renave_identity_app,
  renave_maintenance_app,renave_operation_worker,renave_operation_promoter,
  renave_profile_provisioner,renave_profile_reader,renave_platform_reader,
  renave_platform_provisioner;
grant execute on function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,
  text,uuid,bigint,uuid,bigint) to renave_app;
revoke all on function renave_admin.promote_held_local_operation(
  uuid,bytea,bytea,bytea)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant usage on schema renave_admin to renave_operation_promoter;
revoke create on schema renave_admin from renave_operation_promoter;
revoke all on schema renave from renave_operation_promoter;
grant execute on function renave_admin.promote_held_local_operation(
  uuid,bytea,bytea,bytea)
to renave_operation_promoter;

alter function renave_runtime.api_contract_ready()
  rename to held_local_promotion_previous_contract_v0071;
revoke all on function renave_runtime.held_local_promotion_previous_contract_v0071()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select false$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;
create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
