-- 0005 — Isola o runtime OIDC e coleta registros expirados em lotes.
--
-- A migration 0004 concedia as rotinas ao papel geral `renave_app`. Esta
-- evolução transfere o acesso para `renave_identity_app`, reduzindo o impacto
-- de uma eventual falha SQL na camada de negócio.

revoke all on schema renave_identity from renave_app;
grant usage on schema renave_identity to renave_identity_app;

create function renave_identity.roles_are_valid(value text[])
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
  role_name text;
begin
  if pg_catalog.cardinality(value) > 100 then
    return false;
  end if;
  if pg_catalog.cardinality(value) > 0 and pg_catalog.array_ndims(value) <> 1 then
    return false;
  end if;
  foreach role_name in array value loop
    if role_name is null or pg_catalog.length(role_name) not between 1 and 128 then
      return false;
    end if;
  end loop;
  return true;
end
$$;

alter table renave_identity.auth_session
  drop constraint auth_session_roles_valid,
  add constraint auth_session_roles_valid
    check (renave_identity.roles_are_valid(roles));

create function renave_identity.purge_expired_identity_records(
  p_now_ms bigint,
  p_batch_size integer
)
returns table (
  login_attempts_deleted integer,
  sessions_deleted integer
)
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  with expired_attempts as (
    select attempt.ctid
      from renave_identity.login_attempt attempt
     where attempt.expires_at_ms <= p_now_ms
     order by attempt.expires_at_ms
     for update skip locked
     limit case when p_batch_size between 1 and 10000 then p_batch_size else 0 end
  ), deleted_attempts as (
    delete from renave_identity.login_attempt attempt
     using expired_attempts
     where attempt.ctid = expired_attempts.ctid
    returning 1
  ), expired_sessions as (
    select session.ctid
      from renave_identity.auth_session session
     where session.idle_expires_at_ms <= p_now_ms
        or session.absolute_expires_at_ms <= p_now_ms
     order by case
       when session.idle_expires_at_ms < session.absolute_expires_at_ms
         then session.idle_expires_at_ms
       else session.absolute_expires_at_ms
     end
     for update skip locked
     limit case when p_batch_size between 1 and 10000 then p_batch_size else 0 end
  ), deleted_sessions as (
    delete from renave_identity.auth_session session
     using expired_sessions
     where session.ctid = expired_sessions.ctid
    returning 1
  )
  select
    (select pg_catalog.count(*)::integer from deleted_attempts),
    (select pg_catalog.count(*)::integer from deleted_sessions)
$$;

revoke all on function renave_identity.roles_are_valid(text[])
from public, renave_app, renave_identity_app;

revoke all on function
  renave_identity.save_login_attempt(text, text, text, text, text, bigint, bigint),
  renave_identity.consume_login_attempt(text, bigint),
  renave_identity.save_auth_session(text, text, text, text, text[], bigint, bigint, bigint, bigint),
  renave_identity.get_auth_session(text, bigint),
  renave_identity.touch_auth_session(text, bigint, bigint),
  renave_identity.delete_auth_session(text),
  renave_identity.purge_expired_identity_records(bigint, integer)
from public, renave_app, renave_identity_app;

grant execute on function
  renave_identity.save_login_attempt(text, text, text, text, text, bigint, bigint),
  renave_identity.consume_login_attempt(text, bigint),
  renave_identity.save_auth_session(text, text, text, text, text[], bigint, bigint, bigint, bigint),
  renave_identity.get_auth_session(text, bigint),
  renave_identity.touch_auth_session(text, bigint, bigint),
  renave_identity.delete_auth_session(text),
  renave_identity.purge_expired_identity_records(bigint, integer)
to renave_identity_app;
