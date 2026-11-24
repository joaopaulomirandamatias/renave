-- 0057 — Administração mínima de perfis RENAVE (somente pending/suspended).
--
-- O papel dedicado não recebe acesso a tabela. As rotinas SECURITY DEFINER
-- fixam status/source e nunca expõem função de promoção ou verificação.

create schema renave_admin authorization renave_migrator;
-- O default EXECUTE de funções nasce globalmente para PUBLIC no PostgreSQL;
-- por isso a revogação global é necessária antes do reforço por schema.
alter default privileges for role renave_migrator
  revoke execute on functions from public;
alter default privileges for role renave_migrator in schema renave_admin
  revoke execute on functions from public;
revoke all on schema renave_admin from public, renave_app,
  renave_identity_app, renave_maintenance_app, renave_operation_worker,
  renave_profile_provisioner;
grant usage on schema renave_admin to renave_profile_provisioner;

create table renave.profile_administration_ledger (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references renave.tenant(id) on delete restrict,
  target_type              text        not null,
  target_id                text        not null,
  profile_id               uuid        not null,
  provider                 text        not null,
  assertion_digest         bytea       not null,
  assertion_key_id         text        not null,
  value_hmac               bytea       not null,
  value_hmac_key_id        text        not null,
  issued_at                timestamptz not null,
  expires_at               timestamptz,
  consumed_at              timestamptz,
  revoked_at               timestamptz,
  requested_by_actor_hash  bytea       not null,
  requested_by_key_id      text        not null,
  decided_by_actor_hash    bytea,
  decided_by_key_id        text,
  status                   text        not null,
  created_at               timestamptz not null default clock_timestamp(),
  unique (provider, assertion_digest),
  constraint profile_administration_ledger_target_valid check (
    target_type in ('operator', 'establishment')
    and btrim(target_id) = target_id and length(target_id) between 1 and 255
  ),
  constraint profile_administration_ledger_provider_valid check (
    provider in ('unverified_candidate', 'administrative_suspension',
      'oidc_verified_claim', 'regulated_provider', 'mailbox_challenge',
      'serpro_registry')
  ),
  constraint profile_administration_ledger_digest_valid check (
    octet_length(assertion_digest) = 32
    and octet_length(value_hmac) = 32
    and octet_length(requested_by_actor_hash) = 32
    and (decided_by_actor_hash is null or octet_length(decided_by_actor_hash) = 32)
  ),
  constraint profile_administration_ledger_key_valid check (
    assertion_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and value_hmac_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and requested_by_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and (decided_by_key_id is null
      or decided_by_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  ),
  constraint profile_administration_ledger_status_valid check (
    status in ('received', 'rejected', 'consumed', 'revoked')
  ),
  constraint profile_administration_ledger_timeline_valid check (
    (expires_at is null or expires_at > issued_at)
    and (consumed_at is null or consumed_at >= issued_at)
    and (revoked_at is null or revoked_at >= issued_at)
    and ((status = 'received' and consumed_at is null and revoked_at is null
          and decided_by_actor_hash is null and decided_by_key_id is null)
      or (status = 'rejected' and consumed_at is null and revoked_at is null
          and decided_by_actor_hash is not null and decided_by_key_id is not null)
      or (status = 'consumed' and consumed_at is not null and revoked_at is null
          and decided_by_actor_hash is not null and decided_by_key_id is not null)
      or (status = 'revoked' and consumed_at is null and revoked_at is not null
          and decided_by_actor_hash is not null and decided_by_key_id is not null))
  )
);

create index profile_administration_ledger_target_idx
  on renave.profile_administration_ledger
    (tenant_id, target_type, target_id, created_at desc);

alter table renave.profile_administration_ledger enable row level security;
alter table renave.profile_administration_ledger force row level security;
create policy profile_administration_ledger_isolation
  on renave.profile_administration_ledger
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.profile_administration_ledger_reject_change()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  raise exception 'profile administration ledger é append-only'
    using errcode = 'insufficient_privilege';
end
$$;

create trigger profile_administration_ledger_append_only
  before update or delete on renave.profile_administration_ledger
  for each row execute function renave.profile_administration_ledger_reject_change();
create trigger profile_administration_ledger_reject_truncate
  before truncate on renave.profile_administration_ledger
  for each statement execute function renave.profile_administration_ledger_reject_change();

create function renave_admin.assert_profile_provisioner()
returns void language plpgsql stable security definer set search_path = pg_catalog
as $$
begin
  if session_user <> 'renave_profile_provisioner'
     or current_user <> 'renave_migrator' then
    raise exception 'profile administration: papel inválido'
      using errcode = 'insufficient_privilege';
  end if;
  if not coalesce(renave_runtime.api_contract_ready(), false) then
    raise exception 'profile administration: contrato de catálogo inválido'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

create function renave_admin.stage_operator_pending(
  p_tenant_id uuid, p_subject text, p_profile_id uuid,
  p_hmac_key_id text, p_identity_hmac bytea,
  p_envelope_schema_version integer, p_envelope_key_id text,
  p_envelope_nonce bytea, p_envelope_auth_tag bytea,
  p_envelope_ciphertext bytea, p_envelope_aad_sha256 bytea,
  p_assertion_digest bytea, p_assertion_key_id text,
  p_changed_by_digest bytea, p_changed_by_key_id text
)
returns table (profile_id uuid, profile_status text, profile_version bigint, replayed boolean)
language plpgsql volatile security definer set search_path = pg_catalog
as $$
declare
  existing_profile renave.operator_identity_profile;
  existing_assertion renave.profile_administration_ledger;
  now_at timestamptz := clock_timestamp();
  inserted_count integer;
begin
  perform renave_admin.assert_profile_provisioner();
  if p_tenant_id is null or p_profile_id is null then
    raise exception 'profile administration: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('renave.tenant_id', p_tenant_id::text, true);
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':operator:' || coalesce(p_subject, ''), 570057));

  perform 1 from renave.tenant t where t.id = p_tenant_id and t.status = 'active' for share;
  if not found then raise exception 'profile administration: target indisponível' using errcode='insufficient_privilege'; end if;
  perform 1 from renave.tenant_user u where u.tenant_id=p_tenant_id and u.subject=p_subject and u.status='active' for share;
  if not found then raise exception 'profile administration: target indisponível' using errcode='insufficient_privilege'; end if;

  select p.* into existing_profile from renave.operator_identity_profile p
   where p.tenant_id=p_tenant_id and p.subject=p_subject for update;
  if found and not (existing_profile.id=p_profile_id
      and existing_profile.status='pending'
      and existing_profile.identity_hmac=p_identity_hmac
      and existing_profile.source_evidence_digest=p_assertion_digest
      and existing_profile.changed_by_subject_hash=p_changed_by_digest) then
    raise exception 'profile administration: perfil já existe'
      using errcode='unique_violation';
  end if;

  insert into renave.profile_administration_ledger (
    tenant_id,target_type,target_id,profile_id,provider,
    assertion_digest,assertion_key_id,value_hmac,value_hmac_key_id,
    issued_at,expires_at,requested_by_actor_hash,requested_by_key_id,status
  ) values (
    p_tenant_id,'operator',p_subject,p_profile_id,'unverified_candidate',
    p_assertion_digest,p_assertion_key_id,p_identity_hmac,p_hmac_key_id,
    now_at,now_at + interval '24 hours',p_changed_by_digest,p_changed_by_key_id,'received'
  ) on conflict (provider,assertion_digest) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    select l.* into existing_assertion from renave.profile_administration_ledger l
     where l.provider='unverified_candidate' and l.assertion_digest=p_assertion_digest;
    if not found or existing_assertion.tenant_id<>p_tenant_id
       or existing_assertion.target_type<>'operator' or existing_assertion.target_id<>p_subject
       or existing_assertion.profile_id<>p_profile_id or existing_assertion.value_hmac<>p_identity_hmac
       or existing_assertion.value_hmac_key_id<>p_hmac_key_id
       or existing_assertion.assertion_key_id<>p_assertion_key_id
       or existing_assertion.requested_by_actor_hash<>p_changed_by_digest
       or existing_assertion.requested_by_key_id<>p_changed_by_key_id then
      raise exception 'profile administration: idempotência divergente'
        using errcode='integrity_constraint_violation';
    end if;
  end if;

  if existing_profile.id is null then
    insert into renave.operator_identity_profile (
      id,tenant_id,subject,hmac_key_id,identity_hmac,envelope_schema_version,
      envelope_key_id,envelope_nonce,envelope_auth_tag,envelope_ciphertext,
      envelope_aad_sha256,status,verification_source,source_evidence_digest,
      changed_by_subject_hash,verified_by_subject_hash,verified_at,version,
      created_at,updated_at
    ) values (
      p_profile_id,p_tenant_id,p_subject,p_hmac_key_id,p_identity_hmac,
      p_envelope_schema_version,p_envelope_key_id,p_envelope_nonce,p_envelope_auth_tag,
      p_envelope_ciphertext,p_envelope_aad_sha256,'pending','unverified_candidate',
      p_assertion_digest,p_changed_by_digest,null,null,1,now_at,now_at
    );
    return query select p_profile_id,'pending'::text,1::bigint,false;
  else
    return query select existing_profile.id,existing_profile.status,existing_profile.version,true;
  end if;
end
$$;

create function renave_admin.stage_establishment_pending(
  p_tenant_id uuid, p_establishment_id uuid, p_profile_id uuid,
  p_hmac_key_id text, p_email_hmac bytea,
  p_envelope_schema_version integer, p_envelope_key_id text,
  p_envelope_nonce bytea, p_envelope_auth_tag bytea,
  p_envelope_ciphertext bytea, p_envelope_aad_sha256 bytea,
  p_assertion_digest bytea, p_assertion_key_id text,
  p_changed_by_digest bytea, p_changed_by_key_id text
)
returns table (profile_id uuid, profile_status text, profile_version bigint, replayed boolean)
language plpgsql volatile security definer set search_path = pg_catalog
as $$
declare
  existing_profile renave.establishment_renave_profile;
  existing_assertion renave.profile_administration_ledger;
  now_at timestamptz := clock_timestamp();
  inserted_count integer;
begin
  perform renave_admin.assert_profile_provisioner();
  if p_tenant_id is null or p_establishment_id is null or p_profile_id is null then
    raise exception 'profile administration: entrada inválida' using errcode='invalid_parameter_value';
  end if;
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':establishment:' || p_establishment_id::text,570057));
  perform 1 from renave.tenant t where t.id=p_tenant_id and t.status='active' for share;
  if not found then raise exception 'profile administration: target indisponível' using errcode='insufficient_privilege'; end if;
  perform 1 from renave.establishment e where e.tenant_id=p_tenant_id and e.id=p_establishment_id and e.status='active' for share;
  if not found then raise exception 'profile administration: target indisponível' using errcode='insufficient_privilege'; end if;

  select p.* into existing_profile from renave.establishment_renave_profile p
   where p.tenant_id=p_tenant_id and p.establishment_id=p_establishment_id for update;
  if found and not (existing_profile.id=p_profile_id
      and existing_profile.status='pending' and existing_profile.email_hmac=p_email_hmac
      and existing_profile.source_evidence_digest=p_assertion_digest
      and existing_profile.changed_by_subject_hash=p_changed_by_digest) then
    raise exception 'profile administration: perfil já existe' using errcode='unique_violation';
  end if;

  insert into renave.profile_administration_ledger (
    tenant_id,target_type,target_id,profile_id,provider,
    assertion_digest,assertion_key_id,value_hmac,value_hmac_key_id,
    issued_at,expires_at,requested_by_actor_hash,requested_by_key_id,status
  ) values (
    p_tenant_id,'establishment',p_establishment_id::text,p_profile_id,'unverified_candidate',
    p_assertion_digest,p_assertion_key_id,p_email_hmac,p_hmac_key_id,
    now_at,now_at + interval '24 hours',p_changed_by_digest,p_changed_by_key_id,'received'
  ) on conflict (provider,assertion_digest) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count=0 then
    select l.* into existing_assertion from renave.profile_administration_ledger l
     where l.provider='unverified_candidate' and l.assertion_digest=p_assertion_digest;
    if not found or existing_assertion.tenant_id<>p_tenant_id
       or existing_assertion.target_type<>'establishment'
       or existing_assertion.target_id<>p_establishment_id::text
       or existing_assertion.profile_id<>p_profile_id or existing_assertion.value_hmac<>p_email_hmac
       or existing_assertion.value_hmac_key_id<>p_hmac_key_id
       or existing_assertion.assertion_key_id<>p_assertion_key_id
       or existing_assertion.requested_by_actor_hash<>p_changed_by_digest
       or existing_assertion.requested_by_key_id<>p_changed_by_key_id then
      raise exception 'profile administration: idempotência divergente' using errcode='integrity_constraint_violation';
    end if;
  end if;

  if existing_profile.id is null then
    insert into renave.establishment_renave_profile (
      id,tenant_id,establishment_id,hmac_key_id,email_hmac,envelope_schema_version,
      envelope_key_id,envelope_nonce,envelope_auth_tag,envelope_ciphertext,
      envelope_aad_sha256,status,verification_source,source_evidence_digest,
      changed_by_subject_hash,verified_by_subject_hash,verified_at,version,
      created_at,updated_at
    ) values (
      p_profile_id,p_tenant_id,p_establishment_id,p_hmac_key_id,p_email_hmac,
      p_envelope_schema_version,p_envelope_key_id,p_envelope_nonce,p_envelope_auth_tag,
      p_envelope_ciphertext,p_envelope_aad_sha256,'pending','unverified_candidate',
      p_assertion_digest,p_changed_by_digest,null,null,1,now_at,now_at
    );
    return query select p_profile_id,'pending'::text,1::bigint,false;
  else
    return query select existing_profile.id,existing_profile.status,existing_profile.version,true;
  end if;
end
$$;

create function renave_admin.suspend_operator(
  p_tenant_id uuid, p_subject text, p_expected_version bigint,
  p_reason_digest bytea, p_reason_key_id text,
  p_request_digest bytea, p_request_key_id text,
  p_changed_by_digest bytea, p_changed_by_key_id text
)
returns table (profile_id uuid, profile_status text, profile_version bigint, replayed boolean)
language plpgsql volatile security definer set search_path = pg_catalog
as $$
declare p renave.operator_identity_profile; now_at timestamptz:=clock_timestamp(); inserted_count integer; l renave.profile_administration_ledger;
begin
  perform renave_admin.assert_profile_provisioner();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':operator:'||coalesce(p_subject,''),570057));
  select x.* into p from renave.operator_identity_profile x where x.tenant_id=p_tenant_id and x.subject=p_subject for update;
  if not found then raise exception 'profile administration: perfil ausente' using errcode='no_data_found'; end if;
  if p.status='suspended' and p.version=p_expected_version+1
     and p.source_evidence_digest=p_reason_digest and p.changed_by_subject_hash=p_changed_by_digest then
    select x.* into l from renave.profile_administration_ledger x
     where x.provider='administrative_suspension' and x.assertion_digest=p_request_digest;
    if found and l.tenant_id=p_tenant_id and l.target_type='operator'
       and l.target_id=p_subject and l.profile_id=p.id
       and l.assertion_key_id=p_request_key_id
       and l.value_hmac=p_reason_digest and l.value_hmac_key_id=p_reason_key_id
       and l.requested_by_actor_hash=p_changed_by_digest
       and l.requested_by_key_id=p_changed_by_key_id then
      return query select p.id,p.status,p.version,true; return;
    end if;
    raise exception 'profile administration: suspensão divergente'
      using errcode='integrity_constraint_violation';
  end if;
  if p.version<>p_expected_version then raise exception 'profile administration: conflito de versão' using errcode='serialization_failure'; end if;
  if p.status='suspended' then raise exception 'profile administration: suspensão divergente' using errcode='integrity_constraint_violation'; end if;
  insert into renave.profile_administration_ledger (
    tenant_id,target_type,target_id,profile_id,provider,assertion_digest,assertion_key_id,
    value_hmac,value_hmac_key_id,issued_at,consumed_at,requested_by_actor_hash,
    requested_by_key_id,decided_by_actor_hash,decided_by_key_id,status
  ) values (p_tenant_id,'operator',p_subject,p.id,'administrative_suspension',
    p_request_digest,p_request_key_id,p_reason_digest,p_reason_key_id,now_at,now_at,
    p_changed_by_digest,p_changed_by_key_id,p_changed_by_digest,p_changed_by_key_id,'consumed')
  on conflict(provider,assertion_digest) do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    select x.* into l from renave.profile_administration_ledger x where x.provider='administrative_suspension' and x.assertion_digest=p_request_digest;
    if not found or l.tenant_id<>p_tenant_id or l.target_type<>'operator' or l.target_id<>p_subject or l.profile_id<>p.id
       or l.assertion_key_id<>p_request_key_id
       or l.value_hmac<>p_reason_digest or l.value_hmac_key_id<>p_reason_key_id
       or l.requested_by_actor_hash<>p_changed_by_digest or l.requested_by_key_id<>p_changed_by_key_id then
      raise exception 'profile administration: idempotência divergente' using errcode='integrity_constraint_violation';
    end if;
  end if;
  update renave.operator_identity_profile x set status='suspended',source_evidence_digest=p_reason_digest,
    changed_by_subject_hash=p_changed_by_digest,version=x.version+1,updated_at=now_at
   where x.tenant_id=p_tenant_id and x.subject=p_subject;
  return query select p.id,'suspended'::text,p.version+1,false;
end
$$;

create function renave_admin.suspend_establishment(
  p_tenant_id uuid, p_establishment_id uuid, p_expected_version bigint,
  p_reason_digest bytea, p_reason_key_id text,
  p_request_digest bytea, p_request_key_id text,
  p_changed_by_digest bytea, p_changed_by_key_id text
)
returns table (profile_id uuid, profile_status text, profile_version bigint, replayed boolean)
language plpgsql volatile security definer set search_path = pg_catalog
as $$
declare p renave.establishment_renave_profile; now_at timestamptz:=clock_timestamp(); inserted_count integer; l renave.profile_administration_ledger;
begin
  perform renave_admin.assert_profile_provisioner();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':establishment:'||coalesce(p_establishment_id::text,''),570057));
  select x.* into p from renave.establishment_renave_profile x where x.tenant_id=p_tenant_id and x.establishment_id=p_establishment_id for update;
  if not found then raise exception 'profile administration: perfil ausente' using errcode='no_data_found'; end if;
  if p.status='suspended' and p.version=p_expected_version+1
     and p.source_evidence_digest=p_reason_digest and p.changed_by_subject_hash=p_changed_by_digest then
    select x.* into l from renave.profile_administration_ledger x
     where x.provider='administrative_suspension' and x.assertion_digest=p_request_digest;
    if found and l.tenant_id=p_tenant_id and l.target_type='establishment'
       and l.target_id=p_establishment_id::text and l.profile_id=p.id
       and l.assertion_key_id=p_request_key_id
       and l.value_hmac=p_reason_digest and l.value_hmac_key_id=p_reason_key_id
       and l.requested_by_actor_hash=p_changed_by_digest
       and l.requested_by_key_id=p_changed_by_key_id then
      return query select p.id,p.status,p.version,true; return;
    end if;
    raise exception 'profile administration: suspensão divergente'
      using errcode='integrity_constraint_violation';
  end if;
  if p.version<>p_expected_version then raise exception 'profile administration: conflito de versão' using errcode='serialization_failure'; end if;
  if p.status='suspended' then raise exception 'profile administration: suspensão divergente' using errcode='integrity_constraint_violation'; end if;
  insert into renave.profile_administration_ledger (
    tenant_id,target_type,target_id,profile_id,provider,assertion_digest,assertion_key_id,
    value_hmac,value_hmac_key_id,issued_at,consumed_at,requested_by_actor_hash,
    requested_by_key_id,decided_by_actor_hash,decided_by_key_id,status
  ) values (p_tenant_id,'establishment',p_establishment_id::text,p.id,'administrative_suspension',
    p_request_digest,p_request_key_id,p_reason_digest,p_reason_key_id,now_at,now_at,
    p_changed_by_digest,p_changed_by_key_id,p_changed_by_digest,p_changed_by_key_id,'consumed')
  on conflict(provider,assertion_digest) do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    select x.* into l from renave.profile_administration_ledger x where x.provider='administrative_suspension' and x.assertion_digest=p_request_digest;
    if not found or l.tenant_id<>p_tenant_id or l.target_type<>'establishment' or l.target_id<>p_establishment_id::text or l.profile_id<>p.id
       or l.assertion_key_id<>p_request_key_id
       or l.value_hmac<>p_reason_digest or l.value_hmac_key_id<>p_reason_key_id
       or l.requested_by_actor_hash<>p_changed_by_digest or l.requested_by_key_id<>p_changed_by_key_id then
      raise exception 'profile administration: idempotência divergente' using errcode='integrity_constraint_violation';
    end if;
  end if;
  update renave.establishment_renave_profile x set status='suspended',source_evidence_digest=p_reason_digest,
    changed_by_subject_hash=p_changed_by_digest,version=x.version+1,updated_at=now_at
   where x.tenant_id=p_tenant_id and x.establishment_id=p_establishment_id;
  return query select p.id,'suspended'::text,p.version+1,false;
end
$$;

create function renave_admin.get_operator_status(p_tenant_id uuid,p_subject text)
returns table(profile_id uuid,profile_status text,profile_version bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform renave_admin.assert_profile_provisioner();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  return query select p.id,p.status,p.version,p.updated_at from renave.operator_identity_profile p
    where p.tenant_id=p_tenant_id and p.subject=p_subject;
end $$;

create function renave_admin.get_establishment_status(p_tenant_id uuid,p_establishment_id uuid)
returns table(profile_id uuid,profile_status text,profile_version bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform renave_admin.assert_profile_provisioner();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  return query select p.id,p.status,p.version,p.updated_at from renave.establishment_renave_profile p
    where p.tenant_id=p_tenant_id and p.establishment_id=p_establishment_id;
end $$;

revoke all on renave.profile_administration_ledger from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner;
revoke all on all functions in schema renave_admin from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner;
grant execute on function
  renave_admin.stage_operator_pending(uuid,text,uuid,text,bytea,integer,text,bytea,bytea,bytea,bytea,bytea,text,bytea,text),
  renave_admin.stage_establishment_pending(uuid,uuid,uuid,text,bytea,integer,text,bytea,bytea,bytea,bytea,bytea,text,bytea,text),
  renave_admin.suspend_operator(uuid,text,bigint,bytea,text,bytea,text,bytea,text),
  renave_admin.suspend_establishment(uuid,uuid,bigint,bytea,text,bytea,text,bytea,text),
  renave_admin.get_operator_status(uuid,text),
  renave_admin.get_establishment_status(uuid,uuid)
to renave_profile_provisioner;

-- Não existe função verify/promote/consume neste ciclo. Os providers listados
-- no ledger são apenas vocabulário reservado para uma cerimônia futura.
