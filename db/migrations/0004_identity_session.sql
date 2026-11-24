-- 0004 — Persistência global de tentativas OIDC e sessões opacas.
--
-- O login acontece antes de existir tenant ativo, portanto estas tabelas não
-- pertencem à RLS de negócio. Identificadores entregues ao navegador chegam
-- ao adapter já como SHA-256/base64url; cookies e tokens OIDC nunca são
-- persistidos. O code_verifier PKCE é efêmero e necessário ao callback.

create schema renave_identity;
revoke all on schema renave_identity from public, renave_app;
grant usage on schema renave_identity to renave_app;

create table renave_identity.login_attempt (
  key_hash       text   primary key,
  code_verifier  text   not null,
  nonce_hash     text   not null,
  binding_hash   text   not null,
  return_to      text   not null,
  created_at_ms  bigint not null,
  expires_at_ms  bigint not null,
  constraint login_attempt_key_hash_valid check (key_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint login_attempt_verifier_valid check (
    pg_catalog.length(code_verifier) between 43 and 128
    and code_verifier ~ '^[A-Za-z0-9._~-]+$'
  ),
  constraint login_attempt_nonce_hash_valid check (nonce_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint login_attempt_binding_hash_valid check (binding_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint login_attempt_return_to_valid check (
    pg_catalog.length(return_to) between 1 and 512
    and return_to like '/%'
    and return_to not like '//%'
    and pg_catalog.strpos(return_to, E'\\') = 0
  ),
  constraint login_attempt_time_valid check (
    created_at_ms > 0 and expires_at_ms > created_at_ms
  )
);

create index login_attempt_expiry_idx
  on renave_identity.login_attempt (expires_at_ms);

create table renave_identity.auth_session (
  key_hash                text   primary key,
  subject                 text   not null,
  display_name            text,
  email                   text,
  roles                   text[] not null default '{}',
  created_at_ms            bigint not null,
  last_seen_at_ms          bigint not null,
  idle_expires_at_ms       bigint not null,
  absolute_expires_at_ms   bigint not null,
  constraint auth_session_key_hash_valid check (key_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint auth_session_subject_valid check (
    pg_catalog.btrim(subject) = subject and pg_catalog.length(subject) between 1 and 255
  ),
  constraint auth_session_name_valid check (
    display_name is null or pg_catalog.length(display_name) between 1 and 512
  ),
  constraint auth_session_email_valid check (
    email is null or pg_catalog.length(email) between 1 and 512
  ),
  constraint auth_session_roles_valid check (
    pg_catalog.cardinality(roles) <= 100
    and pg_catalog.array_position(roles, null) is null
    and pg_catalog.length(pg_catalog.array_to_string(roles, ',')) <= 12899
  ),
  constraint auth_session_time_valid check (
    created_at_ms > 0
    and last_seen_at_ms >= created_at_ms
    and idle_expires_at_ms > last_seen_at_ms
    and absolute_expires_at_ms > created_at_ms
    and idle_expires_at_ms <= absolute_expires_at_ms
  )
);

create index auth_session_idle_expiry_idx
  on renave_identity.auth_session (idle_expires_at_ms);
create index auth_session_absolute_expiry_idx
  on renave_identity.auth_session (absolute_expires_at_ms);

create function renave_identity.save_login_attempt(
  p_key_hash text,
  p_code_verifier text,
  p_nonce_hash text,
  p_binding_hash text,
  p_return_to text,
  p_created_at_ms bigint,
  p_expires_at_ms bigint
)
returns void
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  insert into renave_identity.login_attempt (
    key_hash, code_verifier, nonce_hash, binding_hash, return_to,
    created_at_ms, expires_at_ms
  ) values (
    p_key_hash, p_code_verifier, p_nonce_hash, p_binding_hash, p_return_to,
    p_created_at_ms, p_expires_at_ms
  )
  on conflict (key_hash) do update set
    code_verifier = excluded.code_verifier,
    nonce_hash = excluded.nonce_hash,
    binding_hash = excluded.binding_hash,
    return_to = excluded.return_to,
    created_at_ms = excluded.created_at_ms,
    expires_at_ms = excluded.expires_at_ms
$$;

create function renave_identity.consume_login_attempt(
  p_key_hash text,
  p_now_ms bigint
)
returns table (
  code_verifier text,
  nonce_hash text,
  binding_hash text,
  return_to text,
  created_at_ms bigint,
  expires_at_ms bigint
)
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  with consumed as (
    delete from renave_identity.login_attempt attempt
     where attempt.key_hash = p_key_hash
    returning attempt.code_verifier, attempt.nonce_hash, attempt.binding_hash,
              attempt.return_to, attempt.created_at_ms, attempt.expires_at_ms
  )
  select consumed.code_verifier, consumed.nonce_hash, consumed.binding_hash,
         consumed.return_to, consumed.created_at_ms, consumed.expires_at_ms
    from consumed
   where consumed.expires_at_ms > p_now_ms
$$;

create function renave_identity.save_auth_session(
  p_key_hash text,
  p_subject text,
  p_display_name text,
  p_email text,
  p_roles text[],
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
    key_hash, subject, display_name, email, roles, created_at_ms,
    last_seen_at_ms, idle_expires_at_ms, absolute_expires_at_ms
  ) values (
    p_key_hash, p_subject, p_display_name, p_email, p_roles, p_created_at_ms,
    p_last_seen_at_ms, p_idle_expires_at_ms, p_absolute_expires_at_ms
  )
  on conflict (key_hash) do update set
    subject = excluded.subject,
    display_name = excluded.display_name,
    email = excluded.email,
    roles = excluded.roles,
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
         session.created_at_ms, session.last_seen_at_ms,
         session.idle_expires_at_ms, session.absolute_expires_at_ms
    from renave_identity.auth_session session
   where session.key_hash = p_key_hash
     and session.idle_expires_at_ms > p_now_ms
     and session.absolute_expires_at_ms > p_now_ms
$$;

create function renave_identity.touch_auth_session(
  p_key_hash text,
  p_last_seen_at_ms bigint,
  p_idle_expires_at_ms bigint
)
returns void
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  update renave_identity.auth_session session
     set last_seen_at_ms = p_last_seen_at_ms,
         idle_expires_at_ms = p_idle_expires_at_ms
   where session.key_hash = p_key_hash
     and session.idle_expires_at_ms > p_last_seen_at_ms
     and session.absolute_expires_at_ms > p_last_seen_at_ms
     and session.last_seen_at_ms <= p_last_seen_at_ms
     and p_idle_expires_at_ms > p_last_seen_at_ms
     and p_idle_expires_at_ms <= session.absolute_expires_at_ms
$$;

create function renave_identity.delete_auth_session(p_key_hash text)
returns void
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  delete from renave_identity.auth_session session
   where session.key_hash = p_key_hash
$$;

revoke all on renave_identity.login_attempt,
  renave_identity.auth_session from public, renave_app;

revoke all on function
  renave_identity.save_login_attempt(text, text, text, text, text, bigint, bigint),
  renave_identity.consume_login_attempt(text, bigint),
  renave_identity.save_auth_session(text, text, text, text, text[], bigint, bigint, bigint, bigint),
  renave_identity.get_auth_session(text, bigint),
  renave_identity.touch_auth_session(text, bigint, bigint),
  renave_identity.delete_auth_session(text)
from public, renave_app;

grant execute on function
  renave_identity.save_login_attempt(text, text, text, text, text, bigint, bigint),
  renave_identity.consume_login_attempt(text, bigint),
  renave_identity.save_auth_session(text, text, text, text, text[], bigint, bigint, bigint, bigint),
  renave_identity.get_auth_session(text, bigint),
  renave_identity.touch_auth_session(text, bigint, bigint),
  renave_identity.delete_auth_session(text)
to renave_app;
