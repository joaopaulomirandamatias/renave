-- 0053 — Resolução transacional dos perfis verificados exigidos pela operação.
--
-- A função não decripta, grava, promove nem libera operação. Ela retorna apenas
-- envelopes já cifrados e mantém locks compartilhados até o fim da transação.
-- A composição HTTP deverá decriptar e criar HELD_LOCAL dentro desta mesma
-- transação; não existe outbox nem caminho de envio nesta fatia.

create function renave.resolve_verified_renave_principals(
  p_subject text,
  p_establishment_id uuid,
  p_idempotency_key_digest bytea
)
returns table (
  active_tenant_id uuid,
  operator_profile_id uuid,
  operator_envelope_schema_version integer,
  operator_envelope_key_id text,
  operator_envelope_nonce bytea,
  operator_envelope_auth_tag bytea,
  operator_envelope_ciphertext bytea,
  operator_envelope_aad_sha256 bytea,
  operator_hmac_key_id text,
  operator_identity_hmac bytea,
  establishment_profile_id uuid,
  establishment_envelope_schema_version integer,
  establishment_envelope_key_id text,
  establishment_envelope_nonce bytea,
  establishment_envelope_auth_tag bytea,
  establishment_envelope_ciphertext bytea,
  establishment_envelope_aad_sha256 bytea,
  establishment_hmac_key_id text,
  establishment_email_hmac bytea
)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_link_status text;
  operator_profile renave.operator_identity_profile;
  establishment_profile renave.establishment_renave_profile;
begin
  if active_tenant is null then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;
  if p_subject is null
     or pg_catalog.btrim(p_subject) <> p_subject
     or pg_catalog.length(p_subject) not between 1 and 255
     or p_establishment_id is null
     or p_idempotency_key_digest is null
     or pg_catalog.octet_length(p_idempotency_key_digest) <> 32 then
    raise exception 'renave principals: entrada inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Ordem de locks canônica, igual à criação HELD_LOCAL:
  -- idempotência -> tenant -> usuário -> papel -> escopo -> estabelecimento
  -- -> vínculo -> perfil do operador -> perfil do estabelecimento.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      active_tenant::text || ':' ||
        pg_catalog.encode(p_idempotency_key_digest, 'hex'),
      250025
    )
  );

  perform 1
    from renave.tenant tenant
   where tenant.id = active_tenant
     and tenant.status = 'active'
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
    from renave.tenant_user user_account
   where user_account.tenant_id = active_tenant
     and user_account.subject = p_subject
     and user_account.status = 'active'
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
    from renave.tenant_role_grant role_grant
   where role_grant.tenant_id = active_tenant
     and role_grant.subject = p_subject
     and role_grant.role = 'renave_operator'
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
    from renave.establishment_role_scope role_scope
   where role_scope.tenant_id = active_tenant
     and role_scope.subject = p_subject
     and role_scope.role = 'renave_operator'
     and role_scope.establishment_id = p_establishment_id
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
    from renave.establishment establishment
   where establishment.tenant_id = active_tenant
     and establishment.id = p_establishment_id
     and establishment.status = 'active'
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  -- Compartilha a mesma serialização usada pelas transições do vínculo e por
  -- create_held_local_operation. A leitura ocorre novamente após o lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      active_tenant::text || ':' || p_establishment_id::text,
      170017
    )
  );
  select link.status
    into current_link_status
    from renave.credential_link link
   where link.tenant_id = active_tenant
     and link.establishment_id = p_establishment_id
   for share;
  if not found or current_link_status <> 'enabled' then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  select profile.*
    into operator_profile
    from renave.operator_identity_profile profile
   where profile.tenant_id = active_tenant
     and profile.subject = p_subject
     and profile.status = 'verified'
     and profile.envelope_schema_version = 1
     and pg_catalog.octet_length(profile.envelope_ciphertext) = 128
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  select profile.*
    into establishment_profile
    from renave.establishment_renave_profile profile
   where profile.tenant_id = active_tenant
     and profile.establishment_id = p_establishment_id
     and profile.status = 'verified'
     and profile.envelope_schema_version = 1
     and pg_catalog.octet_length(profile.envelope_ciphertext) = 512
   for share;
  if not found then
    raise exception 'renave principals: indisponíveis'
      using errcode = 'insufficient_privilege';
  end if;

  return query select
    active_tenant,
    operator_profile.id,
    operator_profile.envelope_schema_version,
    operator_profile.envelope_key_id,
    operator_profile.envelope_nonce,
    operator_profile.envelope_auth_tag,
    operator_profile.envelope_ciphertext,
    operator_profile.envelope_aad_sha256,
    operator_profile.hmac_key_id,
    operator_profile.identity_hmac,
    establishment_profile.id,
    establishment_profile.envelope_schema_version,
    establishment_profile.envelope_key_id,
    establishment_profile.envelope_nonce,
    establishment_profile.envelope_auth_tag,
    establishment_profile.envelope_ciphertext,
    establishment_profile.envelope_aad_sha256,
    establishment_profile.hmac_key_id,
    establishment_profile.email_hmac;
end
$$;

revoke all on function
  renave.resolve_verified_renave_principals(text, uuid, bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave.resolve_verified_renave_principals(text, uuid, bytea)
to renave_app;
