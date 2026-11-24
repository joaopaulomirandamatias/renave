-- 0051 — Perfis cifrados exigidos pelas operações RENAVE.
--
-- Esta fatia é deliberadamente somente leitura para os runtimes. Apenas o
-- owner/migrator pode inserir ou alterar perfis até existir uma cerimônia de
-- verificação própria. CPF e e-mail nunca são persistidos em texto aberto.

create table renave.operator_identity_profile (
  id                       uuid        not null default gen_random_uuid(),
  tenant_id                uuid        not null,
  subject                  text        not null,
  hmac_key_id              text        not null,
  identity_hmac            bytea       not null,
  envelope_schema_version  integer     not null,
  envelope_key_id          text        not null,
  envelope_nonce           bytea       not null,
  envelope_auth_tag        bytea       not null,
  envelope_ciphertext      bytea       not null,
  envelope_aad_sha256      bytea       not null,
  status                   text        not null,
  verification_source      text        not null,
  source_evidence_digest   bytea       not null,
  changed_by_subject_hash  bytea       not null,
  verified_by_subject_hash bytea,
  verified_at              timestamptz,
  version                  bigint      not null default 1,
  created_at               timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at               timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, subject),
  unique (tenant_id, id),
  -- Antes de rotacionar a chave HMAC, uma migration futura deve reindexar
  -- todos os digests ou manter aliases que preservem esta unicidade lógica.
  unique (tenant_id, identity_hmac),
  foreign key (tenant_id, subject)
    references renave.tenant_user (tenant_id, subject) on delete restrict,
  constraint operator_identity_profile_subject_valid check (
    pg_catalog.btrim(subject) = subject
    and pg_catalog.length(subject) between 1 and 255
  ),
  constraint operator_identity_profile_hmac_valid check (
    hmac_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(identity_hmac) = 32
  ),
  constraint operator_identity_profile_envelope_valid check (
    envelope_schema_version between 1 and 2147483647
    and envelope_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(envelope_nonce) = 12
    and pg_catalog.octet_length(envelope_auth_tag) = 16
    -- O produtor deve preencher antes de cifrar para não vazar o tamanho do CPF.
    and pg_catalog.octet_length(envelope_ciphertext)
      in (128, 256, 512, 1024, 2048, 4096)
    and pg_catalog.octet_length(envelope_aad_sha256) = 32
  ),
  constraint operator_identity_profile_status_valid check (
    status in ('pending', 'verified', 'suspended')
  ),
  constraint operator_identity_profile_source_valid check (
    verification_source in (
      'oidc_verified_claim', 'regulated_provider',
      'unverified_candidate', 'admin_attested', 'migration'
    )
  ),
  constraint operator_identity_profile_evidence_valid check (
    pg_catalog.octet_length(source_evidence_digest) = 32
    and pg_catalog.octet_length(changed_by_subject_hash) = 32
  ),
  constraint operator_identity_profile_verifier_valid check (
    verified_by_subject_hash is null
    or pg_catalog.octet_length(verified_by_subject_hash) = 32
  ),
  constraint operator_identity_profile_verification_state_valid check (
    (status = 'pending'
      and verified_at is null and verified_by_subject_hash is null)
    or (status = 'verified'
      and verified_at is not null and verified_by_subject_hash is not null)
    or (status = 'suspended'
      and ((verified_at is null and verified_by_subject_hash is null)
        or (verified_at is not null and verified_by_subject_hash is not null)))
  ),
  constraint operator_identity_profile_verified_source_valid check (
    status <> 'verified'
    or verification_source in ('oidc_verified_claim', 'regulated_provider')
  ),
  constraint operator_identity_profile_version_valid check (version > 0),
  constraint operator_identity_profile_timeline_valid check (
    updated_at >= created_at
  )
);

create table renave.establishment_renave_profile (
  id                       uuid        not null default gen_random_uuid(),
  tenant_id                uuid        not null,
  establishment_id         uuid        not null,
  hmac_key_id              text        not null,
  email_hmac               bytea       not null,
  envelope_schema_version  integer     not null,
  envelope_key_id          text        not null,
  envelope_nonce           bytea       not null,
  envelope_auth_tag        bytea       not null,
  envelope_ciphertext      bytea       not null,
  envelope_aad_sha256      bytea       not null,
  status                   text        not null,
  verification_source      text        not null,
  source_evidence_digest   bytea       not null,
  changed_by_subject_hash  bytea       not null,
  verified_by_subject_hash bytea,
  verified_at              timestamptz,
  version                  bigint      not null default 1,
  created_at               timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at               timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, establishment_id),
  unique (tenant_id, id),
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint establishment_renave_profile_hmac_valid check (
    hmac_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(email_hmac) = 32
  ),
  constraint establishment_renave_profile_envelope_valid check (
    envelope_schema_version between 1 and 2147483647
    and envelope_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and pg_catalog.octet_length(envelope_nonce) = 12
    and pg_catalog.octet_length(envelope_auth_tag) = 16
    -- O produtor deve preencher antes de cifrar para não vazar o tamanho do e-mail.
    and pg_catalog.octet_length(envelope_ciphertext)
      in (128, 256, 512, 1024, 2048, 4096)
    and pg_catalog.octet_length(envelope_aad_sha256) = 32
  ),
  constraint establishment_renave_profile_status_valid check (
    status in ('pending', 'verified', 'suspended')
  ),
  constraint establishment_renave_profile_source_valid check (
    verification_source in (
      'unverified_candidate', 'admin_mfa', 'mailbox_challenge',
      'serpro_registry', 'migration'
    )
  ),
  constraint establishment_renave_profile_verified_source_valid check (
    status <> 'verified'
    or verification_source in ('mailbox_challenge', 'serpro_registry')
  ),
  constraint establishment_renave_profile_evidence_valid check (
    pg_catalog.octet_length(source_evidence_digest) = 32
    and pg_catalog.octet_length(changed_by_subject_hash) = 32
  ),
  constraint establishment_renave_profile_verifier_valid check (
    verified_by_subject_hash is null
    or pg_catalog.octet_length(verified_by_subject_hash) = 32
  ),
  constraint establishment_renave_profile_verification_state_valid check (
    (status = 'pending'
      and verified_at is null and verified_by_subject_hash is null)
    or (status = 'verified'
      and verified_at is not null and verified_by_subject_hash is not null)
    or (status = 'suspended'
      and ((verified_at is null and verified_by_subject_hash is null)
        or (verified_at is not null and verified_by_subject_hash is not null)))
  ),
  constraint establishment_renave_profile_version_valid check (version > 0),
  constraint establishment_renave_profile_timeline_valid check (
    updated_at >= created_at
  )
);

create table renave.operator_identity_profile_history (
  id                       bigint      generated always as identity primary key,
  tenant_id                uuid        not null,
  profile_id               uuid        not null,
  version                  bigint      not null,
  previous_status          text,
  status                   text        not null,
  verification_source      text        not null,
  source_evidence_digest   bytea       not null,
  changed_by_subject_hash  bytea       not null,
  changed_at               timestamptz not null,
  foreign key (tenant_id, profile_id)
    references renave.operator_identity_profile (tenant_id, id)
    on delete restrict,
  unique (tenant_id, profile_id, version),
  constraint operator_identity_profile_history_status_valid check (
    status in ('pending', 'verified', 'suspended')
    and (previous_status is null
      or previous_status in ('pending', 'verified', 'suspended'))
  ),
  constraint operator_identity_profile_history_source_valid check (
    verification_source in (
      'oidc_verified_claim', 'regulated_provider',
      'unverified_candidate', 'admin_attested', 'migration'
    )
  ),
  constraint operator_identity_profile_history_digest_valid check (
    pg_catalog.octet_length(source_evidence_digest) = 32
    and pg_catalog.octet_length(changed_by_subject_hash) = 32
  )
);

create table renave.establishment_renave_profile_history (
  id                       bigint      generated always as identity primary key,
  tenant_id                uuid        not null,
  profile_id               uuid        not null,
  establishment_id         uuid        not null,
  version                  bigint      not null,
  previous_status          text,
  status                   text        not null,
  verification_source      text        not null,
  source_evidence_digest   bytea       not null,
  changed_by_subject_hash  bytea       not null,
  changed_at               timestamptz not null,
  foreign key (tenant_id, profile_id)
    references renave.establishment_renave_profile (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  unique (tenant_id, profile_id, version),
  constraint establishment_renave_profile_history_status_valid check (
    status in ('pending', 'verified', 'suspended')
    and (previous_status is null
      or previous_status in ('pending', 'verified', 'suspended'))
  ),
  constraint establishment_renave_profile_history_source_valid check (
    verification_source in (
      'unverified_candidate', 'admin_mfa', 'mailbox_challenge',
      'serpro_registry', 'migration'
    )
  ),
  constraint establishment_renave_profile_history_digest_valid check (
    pg_catalog.octet_length(source_evidence_digest) = 32
    and pg_catalog.octet_length(changed_by_subject_hash) = 32
  )
);

create index operator_identity_profile_history_timeline_idx
  on renave.operator_identity_profile_history (
    tenant_id, profile_id, version desc
  );
create index establishment_renave_profile_history_timeline_idx
  on renave.establishment_renave_profile_history (
    tenant_id, profile_id, version desc
  );

alter table renave.operator_identity_profile enable row level security;
alter table renave.operator_identity_profile force row level security;
alter table renave.establishment_renave_profile enable row level security;
alter table renave.establishment_renave_profile force row level security;
alter table renave.operator_identity_profile_history enable row level security;
alter table renave.operator_identity_profile_history force row level security;
alter table renave.establishment_renave_profile_history enable row level security;
alter table renave.establishment_renave_profile_history force row level security;

create policy operator_identity_profile_isolation
  on renave.operator_identity_profile
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy establishment_renave_profile_isolation
  on renave.establishment_renave_profile
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy operator_identity_profile_history_isolation
  on renave.operator_identity_profile_history
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy establishment_renave_profile_history_isolation
  on renave.establishment_renave_profile_history
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.operator_identity_profile_guard()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.version <> 1 then
      raise exception 'operator identity profile: versão inicial inválida'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.subject is distinct from old.subject
     or new.created_at is distinct from old.created_at then
    raise exception 'operator identity profile: identidade imutável'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.version <> old.version + 1 or new.updated_at <= old.updated_at then
    raise exception 'operator identity profile: versão inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.status <> old.status and not (case old.status
    when 'pending' then new.status in ('verified', 'suspended')
    when 'verified' then new.status = 'suspended'
    when 'suspended' then new.status in ('pending', 'verified')
    else false
  end) then
    raise exception 'operator identity profile: transição inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create function renave.establishment_renave_profile_guard()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.version <> 1 then
      raise exception 'establishment renave profile: versão inicial inválida'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.establishment_id is distinct from old.establishment_id
     or new.created_at is distinct from old.created_at then
    raise exception 'establishment renave profile: identidade imutável'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.version <> old.version + 1 or new.updated_at <= old.updated_at then
    raise exception 'establishment renave profile: versão inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.status <> old.status and not (case old.status
    when 'pending' then new.status in ('verified', 'suspended')
    when 'verified' then new.status = 'suspended'
    when 'suspended' then new.status in ('pending', 'verified')
    else false
  end) then
    raise exception 'establishment renave profile: transição inválida'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger operator_identity_profile_guard_trigger
  before insert or update on renave.operator_identity_profile
  for each row execute function renave.operator_identity_profile_guard();
create trigger establishment_renave_profile_guard_trigger
  before insert or update on renave.establishment_renave_profile
  for each row execute function renave.establishment_renave_profile_guard();

create function renave.operator_identity_profile_record_history()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  insert into renave.operator_identity_profile_history (
    tenant_id, profile_id, version, previous_status, status,
    verification_source, source_evidence_digest,
    changed_by_subject_hash, changed_at
  ) values (
    new.tenant_id, new.id, new.version,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, new.verification_source, new.source_evidence_digest,
    new.changed_by_subject_hash, new.updated_at
  );
  return new;
end
$$;

create function renave.establishment_renave_profile_record_history()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  insert into renave.establishment_renave_profile_history (
    tenant_id, profile_id, establishment_id, version, previous_status, status,
    verification_source, source_evidence_digest,
    changed_by_subject_hash, changed_at
  ) values (
    new.tenant_id, new.id, new.establishment_id, new.version,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, new.verification_source, new.source_evidence_digest,
    new.changed_by_subject_hash, new.updated_at
  );
  return new;
end
$$;

create trigger operator_identity_profile_history_trigger
  after insert or update on renave.operator_identity_profile
  for each row execute function renave.operator_identity_profile_record_history();
create trigger establishment_renave_profile_history_trigger
  after insert or update on renave.establishment_renave_profile
  for each row execute function renave.establishment_renave_profile_record_history();

create function renave.renave_profile_history_reject_change()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  raise exception 'renave profile history é append-only'
    using errcode = 'insufficient_privilege';
end
$$;

create trigger operator_identity_profile_history_append_only
  before update or delete on renave.operator_identity_profile_history
  for each row execute function renave.renave_profile_history_reject_change();
create trigger establishment_renave_profile_history_append_only
  before update or delete on renave.establishment_renave_profile_history
  for each row execute function renave.renave_profile_history_reject_change();

create function renave.get_operator_identity_profile_status(p_subject text)
returns table (
  profile_status text
)
language plpgsql stable security definer set search_path = pg_catalog
as $$
declare active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null then
    raise exception 'renave profile: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_subject is null or pg_catalog.btrim(p_subject) <> p_subject
     or pg_catalog.length(p_subject) not between 1 and 255 then
    raise exception 'renave profile: subject inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  return query
    select profile.status
      from renave.operator_identity_profile profile
      join renave.tenant_user user_account
        on user_account.tenant_id = profile.tenant_id
       and user_account.subject = profile.subject
      join renave.tenant tenant on tenant.id = profile.tenant_id
     where profile.tenant_id = active_tenant
       and profile.subject = p_subject
       and tenant.status = 'active'
       and user_account.status = 'active';
end
$$;

create function renave.get_establishment_renave_profile_status(
  p_establishment_id uuid
)
returns table (
  profile_status text
)
language plpgsql stable security definer set search_path = pg_catalog
as $$
declare active_tenant uuid := renave.current_tenant_id();
begin
  if active_tenant is null then
    raise exception 'renave profile: tenant ausente'
      using errcode = 'insufficient_privilege';
  end if;
  if p_establishment_id is null then
    raise exception 'renave profile: estabelecimento inválido'
      using errcode = 'invalid_parameter_value';
  end if;
  return query
    select profile.status
      from renave.establishment_renave_profile profile
      join renave.establishment establishment
        on establishment.tenant_id = profile.tenant_id
       and establishment.id = profile.establishment_id
      join renave.tenant tenant on tenant.id = profile.tenant_id
     where profile.tenant_id = active_tenant
       and profile.establishment_id = p_establishment_id
       and tenant.status = 'active'
       and establishment.status = 'active';
end
$$;

revoke all on renave.operator_identity_profile,
  renave.establishment_renave_profile,
  renave.operator_identity_profile_history,
  renave.establishment_renave_profile_history
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

revoke all on function renave.operator_identity_profile_guard(),
  renave.establishment_renave_profile_guard(),
  renave.operator_identity_profile_record_history(),
  renave.establishment_renave_profile_record_history(),
  renave.renave_profile_history_reject_change(),
  renave.get_operator_identity_profile_status(text),
  renave.get_establishment_renave_profile_status(uuid)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

grant execute on function renave.get_operator_identity_profile_status(text),
  renave.get_establishment_renave_profile_status(uuid)
to renave_app;
