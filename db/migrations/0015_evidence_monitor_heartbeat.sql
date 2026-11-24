-- 0015 — Heartbeat agregado do monitor de evidências.
--
-- Não contém identificadores de evidência, tenant, estabelecimento ou pessoa.
-- O papel de manutenção continua limitado a funções SECURITY DEFINER.

create table renave_operations.evidence_monitor_heartbeat (
  singleton boolean primary key default true check (singleton),
  last_success_at timestamptz,
  last_scanned_count integer not null default 0 check (last_scanned_count >= 0),
  last_incidents_created integer not null default 0 check (last_incidents_created >= 0),
  last_backlog_may_remain boolean not null default false,
  last_oldest_pending_age_seconds bigint not null default 0
    check (last_oldest_pending_age_seconds >= 0)
);

insert into renave_operations.evidence_monitor_heartbeat (singleton)
values (true);

revoke all on renave_operations.evidence_monitor_heartbeat
from public, renave_app, renave_identity_app, renave_maintenance_app;

create or replace function renave_operations.scan_stale_protected_evidence(
  p_batch_size integer
)
returns table (
  scanned_count integer,
  incidents_created integer,
  backlog_may_remain boolean,
  oldest_pending_age_seconds bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  database_now timestamptz := pg_catalog.clock_timestamp();
  configured_sla interval;
  result_scanned_count integer;
  result_incidents_created integer;
  result_backlog_may_remain boolean;
  result_oldest_pending_age_seconds bigint;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'batch_size deve estar entre 1 e 1000'
      using errcode = 'invalid_parameter_value';
  end if;

  select policy.pending_sla
    into strict configured_sla
    from renave_operations.evidence_monitor_policy policy
   where policy.singleton;

  with candidates as materialized (
    select state.evidence_id
      from renave_operations.evidence_state state
     where state.status = 'pending'
       and state.created_at <= database_now - configured_sla
       and not exists (
         select 1
           from renave_operations.evidence_incident incident
          where incident.evidence_id = state.evidence_id
       )
     order by state.created_at, state.evidence_id
     for update of state skip locked
     limit p_batch_size
  ), inserted as (
    insert into renave_operations.evidence_incident (
      evidence_id, status, reason, detected_at
    )
    select candidate.evidence_id, 'open', 'pending_above_sla', database_now
      from candidates candidate
    on conflict (evidence_id) do nothing
    returning evidence_id
  )
  select
    (select pg_catalog.count(*)::integer from candidates),
    (select pg_catalog.count(*)::integer from inserted)
    into result_scanned_count, result_incidents_created;

  select exists (
    select 1
      from renave_operations.evidence_state state
     where state.status = 'pending'
       and state.created_at <= database_now - configured_sla
       and not exists (
         select 1
           from renave_operations.evidence_incident incident
          where incident.evidence_id = state.evidence_id
       )
  ) into result_backlog_may_remain;

  select coalesce(
    pg_catalog.floor(
      extract(epoch from database_now - pg_catalog.min(state.created_at))
    )::bigint,
    0::bigint
  )
    into result_oldest_pending_age_seconds
    from renave_operations.evidence_state state
   where state.status = 'pending';

  insert into renave_operations.evidence_monitor_heartbeat (
    singleton,
    last_success_at,
    last_scanned_count,
    last_incidents_created,
    last_backlog_may_remain,
    last_oldest_pending_age_seconds
  ) values (
    true,
    database_now,
    result_scanned_count,
    result_incidents_created,
    result_backlog_may_remain,
    result_oldest_pending_age_seconds
  )
  on conflict (singleton) do update set
    last_success_at = excluded.last_success_at,
    last_scanned_count = excluded.last_scanned_count,
    last_incidents_created = excluded.last_incidents_created,
    last_backlog_may_remain = excluded.last_backlog_may_remain,
    last_oldest_pending_age_seconds = excluded.last_oldest_pending_age_seconds
  where renave_operations.evidence_monitor_heartbeat.last_success_at is null
     or excluded.last_success_at >=
        renave_operations.evidence_monitor_heartbeat.last_success_at;

  return query select
    result_scanned_count,
    result_incidents_created,
    result_backlog_may_remain,
    result_oldest_pending_age_seconds;
end
$$;

create function renave_operations.evidence_monitor_status(
  p_max_silence_seconds integer
)
returns table (
  last_success_at timestamptz,
  seconds_since_last_success bigint,
  heartbeat_stale boolean,
  open_incident_count bigint,
  last_scanned_count integer,
  last_incidents_created integer,
  last_backlog_may_remain boolean,
  last_oldest_pending_age_seconds bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_max_silence_seconds is null
     or p_max_silence_seconds < 1
     or p_max_silence_seconds > 86400 then
    raise exception 'max_silence_seconds deve estar entre 1 e 86400'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select
    heartbeat.last_success_at,
    case
      when heartbeat.last_success_at is null then null::bigint
      else pg_catalog.floor(
        extract(epoch from database_now - heartbeat.last_success_at)
      )::bigint
    end,
    heartbeat.last_success_at is null
      or heartbeat.last_success_at <
         database_now - pg_catalog.make_interval(secs => p_max_silence_seconds),
    (
      select pg_catalog.count(*)
        from renave_operations.evidence_incident incident
       where incident.status = 'open'
    ),
    heartbeat.last_scanned_count,
    heartbeat.last_incidents_created,
    heartbeat.last_backlog_may_remain,
    heartbeat.last_oldest_pending_age_seconds
  from renave_operations.evidence_monitor_heartbeat heartbeat
  where heartbeat.singleton;
end
$$;

revoke all on function
  renave_operations.scan_stale_protected_evidence(integer),
  renave_operations.evidence_monitor_status(integer)
from public, renave_app, renave_identity_app, renave_maintenance_app;

grant execute on function
  renave_operations.scan_stale_protected_evidence(integer),
  renave_operations.evidence_monitor_status(integer)
to renave_maintenance_app;
