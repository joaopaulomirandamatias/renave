-- 0010 — Relógio confiável e monitor operacional de evidências pendentes.
--
-- O scanner nunca lê ciphertext nem atravessa a RLS. Uma projeção global
-- mínima é mantida atomicamente por trigger. Pendência acima do SLA gera um
-- incidente, mas jamais altera, remove ou inventa o desfecho da evidência.

revoke insert on renave.protected_evidence from renave_app;
grant insert (
  id,
  tenant_id,
  establishment_id,
  action,
  request_key_id,
  request_nonce,
  request_auth_tag,
  request_ciphertext
) on renave.protected_evidence to renave_app;

create or replace function renave.protected_evidence_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  database_now timestamptz;
begin
  database_now := pg_catalog.clock_timestamp();
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.response_key_id := null;
    new.response_nonce := null;
    new.response_auth_tag := null;
    new.response_ciphertext := null;
    new.failure_code := null;
    new.created_at := database_now;
    new.finalized_at := null;
    new.updated_at := database_now;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.establishment_id is distinct from old.establishment_id
     or new.action is distinct from old.action
     or new.request_key_id is distinct from old.request_key_id
     or new.request_nonce is distinct from old.request_nonce
     or new.request_auth_tag is distinct from old.request_auth_tag
     or new.request_ciphertext is distinct from old.request_ciphertext
     or new.created_at is distinct from old.created_at then
    raise exception 'protected_evidence: identidade/request são imutáveis'
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.status <> 'pending' or new.status not in ('completed', 'failed') then
    raise exception 'protected_evidence: transição inválida'
      using errcode = 'integrity_constraint_violation';
  end if;

  new.updated_at := database_now;
  new.finalized_at := database_now;
  return new;
end
$$;

create schema renave_operations;
revoke all on schema renave_operations
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant usage on schema renave_operations to renave_maintenance_app;

create table renave_operations.evidence_state (
  evidence_id uuid primary key,
  tenant_id uuid not null,
  status text not null,
  created_at timestamptz not null,
  finalized_at timestamptz,
  updated_at timestamptz not null,
  constraint evidence_state_status_valid
    check (status in ('pending', 'completed', 'failed')),
  constraint evidence_state_finalization_valid check (
    (status = 'pending' and finalized_at is null)
    or (status in ('completed', 'failed') and finalized_at is not null)
  )
);

create index evidence_state_stale_pending_idx
  on renave_operations.evidence_state (created_at, evidence_id)
  where status = 'pending';

create table renave_operations.evidence_incident (
  evidence_id uuid primary key
    references renave_operations.evidence_state (evidence_id) on delete restrict,
  status text not null,
  reason text not null,
  detected_at timestamptz not null,
  resolved_at timestamptz,
  constraint evidence_incident_status_valid
    check (status in ('open', 'resolved')),
  constraint evidence_incident_reason_valid
    check (reason = 'pending_above_sla'),
  constraint evidence_incident_resolution_valid check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  )
);

create table renave_operations.evidence_monitor_policy (
  singleton boolean primary key default true check (singleton),
  pending_sla interval not null default interval '15 minutes',
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint evidence_monitor_policy_sla_valid check (
    pending_sla >= interval '1 second'
    and pending_sla <= interval '7 days'
  )
);

insert into renave_operations.evidence_monitor_policy (singleton)
values (true);

revoke all on renave_operations.evidence_state,
  renave_operations.evidence_incident,
  renave_operations.evidence_monitor_policy
from public, renave_app, renave_identity_app, renave_maintenance_app;

create function renave_operations.sync_evidence_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into renave_operations.evidence_state (
    evidence_id, tenant_id, status, created_at, finalized_at, updated_at
  ) values (
    new.id, new.tenant_id, new.status, new.created_at,
    new.finalized_at, new.updated_at
  )
  on conflict (evidence_id) do update set
    status = excluded.status,
    finalized_at = excluded.finalized_at,
    updated_at = excluded.updated_at;

  if new.status in ('completed', 'failed') then
    update renave_operations.evidence_incident incident
       set status = 'resolved',
           resolved_at = pg_catalog.clock_timestamp()
     where incident.evidence_id = new.id
       and incident.status = 'open';
  end if;
  return new;
end
$$;

create trigger protected_evidence_operations_projection
  after insert or update of status on renave.protected_evidence
  for each row execute function renave_operations.sync_evidence_state();

-- FORCE RLS também vale para o dono. A suspensão ocorre somente nesta
-- migration transacional e é restaurada antes do commit.
alter table renave.protected_evidence no force row level security;
insert into renave_operations.evidence_state (
  evidence_id, tenant_id, status, created_at, finalized_at, updated_at
)
select id, tenant_id, status, created_at, finalized_at, updated_at
  from renave.protected_evidence;
alter table renave.protected_evidence force row level security;

create function renave_operations.scan_stale_protected_evidence(
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
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'batch_size deve estar entre 1 e 1000'
      using errcode = 'invalid_parameter_value';
  end if;

  select policy.pending_sla
    into strict configured_sla
    from renave_operations.evidence_monitor_policy policy
   where policy.singleton;

  return query
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
    (select pg_catalog.count(*)::integer from inserted),
    exists (
      select 1
        from renave_operations.evidence_state state
       where state.status = 'pending'
         and state.created_at <= database_now - configured_sla
         and not exists (
           select 1
             from renave_operations.evidence_incident incident
            where incident.evidence_id = state.evidence_id
         )
    ),
    coalesce((
      select pg_catalog.floor(
        extract(epoch from database_now - pg_catalog.min(state.created_at))
      )::bigint
        from renave_operations.evidence_state state
       where state.status = 'pending'
    ), 0::bigint);
end
$$;

revoke all on function
  renave_operations.sync_evidence_state(),
  renave_operations.scan_stale_protected_evidence(integer)
from public, renave_app, renave_identity_app, renave_maintenance_app;

grant execute on function
  renave_operations.scan_stale_protected_evidence(integer)
to renave_maintenance_app;
