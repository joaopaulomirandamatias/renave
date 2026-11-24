-- 0066 — Vincula cada sessão ao issuer validado e ao auth_time real do IdP.
--
-- Linhas legadas permanecem com issuer NULL e falham fechadas no serviço de
-- identidade. O instante MFA nunca é derivado de created_at/last_seen_at.

alter table renave_identity.auth_session
  add column issuer text,
  add column mfa_authenticated_at_ms bigint,
  add constraint auth_session_issuer_valid check (
    issuer is null
    or (
      pg_catalog.length(issuer) between 1 and 2048
      and issuer ~ '^https?://[!-~]+$'
    )
  ),
  add constraint auth_session_mfa_authenticated_at_valid check (
    mfa_authenticated_at_ms is null
    or (
      mfa_verified_at_login
      and authentication_context is not null
      and mfa_authenticated_at_ms > 0
      and mfa_authenticated_at_ms <= created_at_ms
    )
  );

revoke all on function
  renave_identity.save_auth_session(
    text,text,text,text,text[],text,boolean,bigint,bigint,bigint,bigint
  ),
  renave_identity.get_auth_session(text,bigint)
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

drop function renave_identity.save_auth_session(
  text,text,text,text,text[],text,boolean,bigint,bigint,bigint,bigint
);
drop function renave_identity.get_auth_session(text,bigint);

create function renave_identity.save_auth_session(
  p_key_hash text,
  p_issuer text,
  p_subject text,
  p_display_name text,
  p_email text,
  p_roles text[],
  p_authentication_context text,
  p_mfa_verified_at_login boolean,
  p_mfa_authenticated_at_ms bigint,
  p_created_at_ms bigint,
  p_last_seen_at_ms bigint,
  p_idle_expires_at_ms bigint,
  p_absolute_expires_at_ms bigint
)
returns void language sql volatile security definer set search_path=pg_catalog
as $$
  insert into renave_identity.auth_session (
    key_hash,issuer,subject,display_name,email,roles,authentication_context,
    mfa_verified_at_login,mfa_authenticated_at_ms,created_at_ms,
    last_seen_at_ms,idle_expires_at_ms,absolute_expires_at_ms
  ) values (
    p_key_hash,p_issuer,p_subject,p_display_name,p_email,p_roles,
    p_authentication_context,p_mfa_verified_at_login,
    p_mfa_authenticated_at_ms,p_created_at_ms,p_last_seen_at_ms,
    p_idle_expires_at_ms,p_absolute_expires_at_ms
  ) on conflict (key_hash) do update set
    issuer=excluded.issuer,subject=excluded.subject,
    display_name=excluded.display_name,email=excluded.email,roles=excluded.roles,
    authentication_context=excluded.authentication_context,
    mfa_verified_at_login=excluded.mfa_verified_at_login,
    mfa_authenticated_at_ms=excluded.mfa_authenticated_at_ms,
    created_at_ms=excluded.created_at_ms,last_seen_at_ms=excluded.last_seen_at_ms,
    idle_expires_at_ms=excluded.idle_expires_at_ms,
    absolute_expires_at_ms=excluded.absolute_expires_at_ms
$$;

create function renave_identity.get_auth_session(
  p_key_hash text,p_now_ms bigint
)
returns table (
  issuer text,subject text,display_name text,email text,roles text[],
  authentication_context text,mfa_verified_at_login boolean,
  mfa_authenticated_at_ms bigint,created_at_ms bigint,last_seen_at_ms bigint,
  idle_expires_at_ms bigint,absolute_expires_at_ms bigint
)
language sql stable security definer set search_path=pg_catalog as $$
  select session.issuer,session.subject,session.display_name,session.email,
    session.roles,session.authentication_context,
    session.mfa_verified_at_login,session.mfa_authenticated_at_ms,
    session.created_at_ms,session.last_seen_at_ms,session.idle_expires_at_ms,
    session.absolute_expires_at_ms
  from renave_identity.auth_session session
  where session.key_hash=p_key_hash
    and session.idle_expires_at_ms>p_now_ms
    and session.absolute_expires_at_ms>p_now_ms
$$;

revoke all on function
  renave_identity.save_auth_session(
    text,text,text,text,text,text[],text,boolean,bigint,bigint,bigint,bigint,bigint
  ),
  renave_identity.get_auth_session(text,bigint)
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

grant execute on function
  renave_identity.save_auth_session(
    text,text,text,text,text,text[],text,boolean,bigint,bigint,bigint,bigint,bigint
  ),
  renave_identity.get_auth_session(text,bigint)
to renave_identity_app;
