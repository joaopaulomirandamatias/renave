-- 0007 — O banco define o relógio da purga e endurece nomes de papéis OIDC.
--
-- O papel de identidade não pode fornecer um timestamp futuro para encerrar
-- sessões ainda válidas. A função usa clock_timestamp() no próprio cluster.

drop function renave_identity.purge_expired_identity_records(bigint, integer);

create or replace function renave_identity.roles_are_valid(value text[])
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
    if role_name is null
       or role_name !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' then
      return false;
    end if;
  end loop;
  return true;
end
$$;

create function renave_identity.purge_expired_identity_records(
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
  with cutoff as (
    select pg_catalog.floor(
      extract(epoch from pg_catalog.clock_timestamp()) * 1000
    )::bigint as now_ms
  ), expired_attempts as (
    select attempt.ctid
      from renave_identity.login_attempt attempt, cutoff
     where attempt.expires_at_ms <= cutoff.now_ms
     order by attempt.expires_at_ms
     for update of attempt skip locked
     limit case when p_batch_size between 1 and 10000 then p_batch_size else 0 end
  ), deleted_attempts as (
    delete from renave_identity.login_attempt attempt
     using expired_attempts
     where attempt.ctid = expired_attempts.ctid
    returning 1
  ), expired_sessions as (
    select session.ctid
      from renave_identity.auth_session session, cutoff
     where session.idle_expires_at_ms <= cutoff.now_ms
        or session.absolute_expires_at_ms <= cutoff.now_ms
     order by case
       when session.idle_expires_at_ms < session.absolute_expires_at_ms
         then session.idle_expires_at_ms
       else session.absolute_expires_at_ms
     end
     for update of session skip locked
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

revoke all on function
  renave_identity.purge_expired_identity_records(integer)
from public, renave_app, renave_identity_app;

grant execute on function
  renave_identity.purge_expired_identity_records(integer)
to renave_identity_app;
