-- 0045 — Evidência mínima da garantia de autenticação OIDC.
--
-- Armazena somente o `acr` normalizado de um ID token já validado. Sessões
-- anteriores permanecem com NULL e, portanto, falham fechadas quando uma ação
-- exige MFA. O token e os demais claims do provedor nunca chegam ao banco.

alter table renave_identity.auth_session
  add column authentication_context text,
  add column mfa_verified_at_login boolean not null default false,
  add constraint auth_session_authentication_context_valid check (
    authentication_context is null
    or (
      pg_catalog.length(authentication_context) between 1 and 512
      and authentication_context ~ '^[!-~]+$'
    )
  ),
  add constraint auth_session_mfa_snapshot_context_valid check (
    not mfa_verified_at_login or authentication_context is not null
  );

-- Remove as assinaturas anteriores: não deve existir uma capacidade paralela
-- capaz de criar sessões sem declarar explicitamente a nova evidência.
revoke all on function
  renave_identity.save_auth_session(
    text, text, text, text, text[], bigint, bigint, bigint, bigint
  ),
  renave_identity.get_auth_session(text, bigint)
from public, renave_app, renave_identity_app;

drop function renave_identity.save_auth_session(
  text, text, text, text, text[], bigint, bigint, bigint, bigint
);
drop function renave_identity.get_auth_session(text, bigint);

create function renave_identity.save_auth_session(
  p_key_hash text,
  p_subject text,
  p_display_name text,
  p_email text,
  p_roles text[],
  p_authentication_context text,
  p_mfa_verified_at_login boolean,
  p_created_at_ms bigint,
  p_last_seen_at_ms bigint,
  p_idle_expires_at_ms bigint,
  p_absolute_expires_at_ms bigint
)
returns void
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  insert into renave_identity.auth_session (
    key_hash, subject, display_name, email, roles, authentication_context,
    mfa_verified_at_login, created_at_ms, last_seen_at_ms, idle_expires_at_ms,
    absolute_expires_at_ms
  ) values (
    p_key_hash, p_subject, p_display_name, p_email, p_roles,
    p_authentication_context, p_mfa_verified_at_login, p_created_at_ms,
    p_last_seen_at_ms, p_idle_expires_at_ms, p_absolute_expires_at_ms
  )
  on conflict (key_hash) do update set
    subject = excluded.subject,
    display_name = excluded.display_name,
    email = excluded.email,
    roles = excluded.roles,
    authentication_context = excluded.authentication_context,
    mfa_verified_at_login = excluded.mfa_verified_at_login,
    created_at_ms = excluded.created_at_ms,
    last_seen_at_ms = excluded.last_seen_at_ms,
    idle_expires_at_ms = excluded.idle_expires_at_ms,
    absolute_expires_at_ms = excluded.absolute_expires_at_ms
$$;

create function renave_identity.get_auth_session(
  p_key_hash text,
  p_now_ms bigint
)
returns table (
  subject text,
  display_name text,
  email text,
  roles text[],
  authentication_context text,
  mfa_verified_at_login boolean,
  created_at_ms bigint,
  last_seen_at_ms bigint,
  idle_expires_at_ms bigint,
  absolute_expires_at_ms bigint
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select session.subject, session.display_name, session.email, session.roles,
         session.authentication_context, session.mfa_verified_at_login,
         session.created_at_ms, session.last_seen_at_ms,
         session.idle_expires_at_ms, session.absolute_expires_at_ms
    from renave_identity.auth_session session
   where session.key_hash = p_key_hash
     and session.idle_expires_at_ms > p_now_ms
     and session.absolute_expires_at_ms > p_now_ms
$$;

revoke all on function
  renave_identity.save_auth_session(
    text, text, text, text, text[], text, boolean,
    bigint, bigint, bigint, bigint
  ),
  renave_identity.get_auth_session(text, bigint)
from public, renave_app, renave_identity_app;

grant execute on function
  renave_identity.save_auth_session(
    text, text, text, text, text[], text, boolean,
    bigint, bigint, bigint, bigint
  ),
  renave_identity.get_auth_session(text, bigint)
to renave_identity_app;
