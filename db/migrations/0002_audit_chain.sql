-- 0002 — Trilha de auditoria append-only, isolada por tenant e encadeada.
--
-- Cada evento recebe o hash do evento anterior do mesmo tenant. Um advisory
-- lock transacional por tenant serializa inserções concorrentes e impede
-- bifurcação da cadeia. A aplicação só recebe SELECT e INSERT em colunas de
-- entrada; sequence, horário, previous_hash e event_hash são do banco.

create table renave.audit_event (
  sequence                      bigint      generated always as identity,
  chain_position                bigint      not null,
  id                            uuid        primary key default gen_random_uuid(),
  tenant_id                     uuid        not null references renave.tenant (id) on delete restrict,
  establishment_id              uuid        not null,
  occurred_at                   timestamptz not null default pg_catalog.clock_timestamp(),
  actor_subject                 text        not null,
  actor_ip                      inet        not null,
  action                        text        not null,
  outcome                       text        not null,
  cnpj_sent                     text,
  cnpj_confirmed                text,
  integrator_cnpj_confirmed     text,
  request_sha256                text,
  response_sha256               text,
  certificate_thumbprint_sha256 text,
  payload_reference             text,
  trace_id                      text,
  previous_hash                 text        not null,
  event_hash                    text        not null,
  constraint audit_event_sequence_key unique (sequence),
  constraint audit_event_chain_position_key unique (tenant_id, chain_position),
  constraint audit_event_chain_position_valid check (chain_position > 0),
  constraint audit_event_establishment_fk
    foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint audit_event_actor_not_blank check (pg_catalog.btrim(actor_subject) <> ''),
  constraint audit_event_action_format check (action ~ '^[a-z][a-z0-9_.:-]{2,99}$'),
  constraint audit_event_outcome_valid check (
    outcome in ('attempted', 'succeeded', 'rejected', 'outcome_unknown', 'reconciled', 'manual_review')
  ),
  constraint audit_event_cnpj_sent_valid check (
    cnpj_sent is null or (cnpj_sent = renave.normalize_cnpj(cnpj_sent) and renave.cnpj_is_valid(cnpj_sent))
  ),
  constraint audit_event_cnpj_confirmed_valid check (
    cnpj_confirmed is null or (cnpj_confirmed = renave.normalize_cnpj(cnpj_confirmed) and renave.cnpj_is_valid(cnpj_confirmed))
  ),
  constraint audit_event_integrator_cnpj_valid check (
    integrator_cnpj_confirmed is null or (
      integrator_cnpj_confirmed = renave.normalize_cnpj(integrator_cnpj_confirmed)
      and renave.cnpj_is_valid(integrator_cnpj_confirmed)
    )
  ),
  constraint audit_event_request_hash_valid check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint audit_event_response_hash_valid check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'),
  constraint audit_event_certificate_hash_valid check (
    certificate_thumbprint_sha256 is null or certificate_thumbprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_event_previous_hash_valid check (previous_hash ~ '^[0-9a-f]{64}$'),
  constraint audit_event_hash_valid check (event_hash ~ '^[0-9a-f]{64}$'),
  constraint audit_event_payload_reference_not_blank check (
    payload_reference is null or pg_catalog.btrim(payload_reference) <> ''
  ),
  constraint audit_event_trace_not_blank check (trace_id is null or pg_catalog.btrim(trace_id) <> ''),
  constraint audit_event_renave_evidence check (
    action !~ '^renave\.' or (
      cnpj_sent is not null
      and request_sha256 is not null
      and certificate_thumbprint_sha256 is not null
      and payload_reference is not null
    )
  ),
  constraint audit_event_renave_success_identity check (
    action !~ '^renave\.'
    or outcome not in ('succeeded', 'reconciled')
    or (cnpj_confirmed is not null and integrator_cnpj_confirmed is not null)
  )
);

create table renave.audit_chain_head (
  tenant_id     uuid   primary key references renave.tenant (id) on delete restrict,
  last_sequence bigint not null default 0,
  last_hash     text   not null default pg_catalog.repeat('0', 64),
  event_count   bigint not null default 0,
  constraint audit_chain_head_sequence_valid check (last_sequence >= 0),
  constraint audit_chain_head_count_valid check (event_count >= 0),
  constraint audit_chain_head_hash_valid check (last_hash ~ '^[0-9a-f]{64}$')
);

create index audit_event_tenant_time_idx
  on renave.audit_event (tenant_id, occurred_at desc, sequence desc);
create index audit_event_establishment_time_idx
  on renave.audit_event (tenant_id, establishment_id, occurred_at desc);

alter table renave.audit_event enable row level security;
alter table renave.audit_event force row level security;
alter table renave.audit_chain_head enable row level security;
alter table renave.audit_chain_head force row level security;

create policy audit_event_isolation on renave.audit_event
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy audit_chain_head_isolation on renave.audit_chain_head
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.compute_audit_event_hash(item renave.audit_event)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'sequence', item.sequence,
          'chainPosition', item.chain_position,
          'id', item.id,
          'tenantId', item.tenant_id,
          'establishmentId', item.establishment_id,
          'occurredAtEpochMicros', (extract(epoch from item.occurred_at) * 1000000)::bigint,
          'actorSubject', item.actor_subject,
          'actorIp', item.actor_ip,
          'action', item.action,
          'outcome', item.outcome,
          'cnpjSent', item.cnpj_sent,
          'cnpjConfirmed', item.cnpj_confirmed,
          'integratorCnpjConfirmed', item.integrator_cnpj_confirmed,
          'requestSha256', item.request_sha256,
          'responseSha256', item.response_sha256,
          'certificateThumbprintSha256', item.certificate_thumbprint_sha256,
          'payloadReference', item.payload_reference,
          'traceId', item.trace_id,
          'previousHash', item.previous_hash
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

create function renave.audit_event_before_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.tenant_id::text, 7265110002)
  );

  if new.tenant_id is distinct from renave.current_tenant_id() then
    raise exception 'audit_event: tenant divergente do contexto'
      using errcode = 'insufficient_privilege';
  end if;

  insert into renave.audit_chain_head (tenant_id)
  values (new.tenant_id)
  on conflict (tenant_id) do nothing;

  select last_hash, event_count + 1
    into new.previous_hash, new.chain_position
    from renave.audit_chain_head
   where tenant_id = new.tenant_id
   for update;

  new.event_hash := renave.compute_audit_event_hash(new);

  update renave.audit_chain_head
     set last_sequence = new.sequence,
         last_hash = new.event_hash,
         event_count = event_count + 1
   where tenant_id = new.tenant_id;
  return new;
end;
$$;

create function renave.audit_event_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'audit_event é append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_event_hash_chain
  before insert on renave.audit_event
  for each row execute function renave.audit_event_before_insert();

create trigger audit_event_append_only
  before update or delete on renave.audit_event
  for each row execute function renave.audit_event_reject_change();

create function renave.verify_current_tenant_audit_chain()
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  with chain as (
    select event,
           coalesce(
           pg_catalog.lag((event).event_hash) over (order by (event).chain_position),
             pg_catalog.repeat('0', 64)
           ) as expected_previous_hash
      from renave.audit_event event
  )
  select
    not exists (
      select 1 from chain
       where (event).previous_hash <> expected_previous_hash
          or (event).event_hash <> renave.compute_audit_event_hash(event)
    )
    and coalesce(
      (select event_count from renave.audit_chain_head),
      0
    ) = (select pg_catalog.count(*) from chain)
    and coalesce(
      (select last_sequence from renave.audit_chain_head),
      0
    ) = coalesce(
      (select (event).sequence from chain order by (event).chain_position desc limit 1),
      0
    )
    and coalesce(
      (select last_hash from renave.audit_chain_head),
      pg_catalog.repeat('0', 64)
    ) = coalesce(
      (select (event).event_hash from chain order by (event).chain_position desc limit 1),
      pg_catalog.repeat('0', 64)
    )
$$;

revoke all on renave.audit_event, renave.audit_chain_head from public;
grant select on renave.audit_event to renave_app;
grant select on renave.audit_chain_head to renave_app;
grant insert (
  tenant_id,
  establishment_id,
  actor_subject,
  actor_ip,
  action,
  outcome,
  cnpj_sent,
  cnpj_confirmed,
  integrator_cnpj_confirmed,
  request_sha256,
  response_sha256,
  certificate_thumbprint_sha256,
  payload_reference,
  trace_id
) on renave.audit_event to renave_app;
grant usage, select on sequence renave.audit_event_sequence_seq to renave_app;

revoke all on function renave.compute_audit_event_hash(renave.audit_event) from public;
revoke all on function renave.audit_event_before_insert() from public;
revoke all on function renave.audit_event_reject_change() from public;
revoke all on function renave.verify_current_tenant_audit_chain() from public;
grant execute on function renave.verify_current_tenant_audit_chain() to renave_app;
grant execute on function renave.compute_audit_event_hash(renave.audit_event) to renave_app;
