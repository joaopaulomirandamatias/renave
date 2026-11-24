-- 0063 — Fronteira global mínima do console da integradora.
--
-- A projeção não atravessa FORCE RLS: triggers do dono copiam somente nomes,
-- IDs, estado local do vínculo e timestamps. Reader e provisioner não recebem
-- acesso às tabelas; apenas EXECUTE em rotinas fechadas e mutuamente exclusivas.

create schema renave_platform;
revoke all on schema renave_platform from public, renave_app,
  renave_identity_app, renave_maintenance_app, renave_operation_worker,
  renave_profile_provisioner, renave_profile_reader,
  renave_platform_reader, renave_platform_provisioner;

-- Gate deliberadamente fechado enquanto somente a migration 0063 existe.
-- A 0064 substitui o corpo depois de instalar e validar o contrato completo.
create function renave_platform.contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select false $$;
revoke all on function renave_platform.contract_ready() from public,
  renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create table renave_platform.operator_grant (
  actor_digest bytea primary key,
  role text not null default 'integrator_link_reviewer',
  status text not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  ticket_digest bytea not null,
  changed_by_digest bytea not null,
  granted_at timestamptz not null,
  revoked_at timestamptz,
  revocation_ticket_digest bytea,
  constraint platform_operator_actor_digest_valid
    check (octet_length(actor_digest) = 32),
  constraint platform_operator_role_valid
    check (role = 'integrator_link_reviewer'),
  constraint platform_operator_status_valid
    check (status in ('active', 'revoked')),
  constraint platform_operator_window_valid
    check (expires_at > valid_from),
  constraint platform_operator_ticket_digest_valid
    check (octet_length(ticket_digest) = 32),
  constraint platform_operator_changed_by_digest_valid
    check (octet_length(changed_by_digest) = 32),
  constraint platform_operator_revocation_consistent check (
    (status = 'active' and revoked_at is null
      and revocation_ticket_digest is null)
    or
    (status = 'revoked' and revoked_at is not null
      and octet_length(revocation_ticket_digest) = 32)
  )
);

create table renave_platform.operator_grant_revision (
  revision bigint generated always as identity primary key,
  actor_digest bytea not null,
  action text not null,
  role text not null,
  status text not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  decision_ticket_digest bytea not null,
  changed_by_digest bytea not null,
  decided_at timestamptz not null,
  constraint platform_grant_revision_actor_valid
    check (octet_length(actor_digest) = 32),
  constraint platform_grant_revision_action_valid
    check (action in ('grant', 'revoke')),
  constraint platform_grant_revision_role_valid
    check (role = 'integrator_link_reviewer'),
  constraint platform_grant_revision_status_valid check (
    (action = 'grant' and status = 'active')
    or (action = 'revoke' and status = 'revoked')
  ),
  constraint platform_grant_revision_window_valid
    check (expires_at > valid_from),
  constraint platform_grant_revision_ticket_valid
    check (octet_length(decision_ticket_digest) = 32),
  constraint platform_grant_revision_changed_by_valid
    check (octet_length(changed_by_digest) = 32)
);

create index platform_grant_revision_actor_idx
  on renave_platform.operator_grant_revision (actor_digest, revision);

create table renave_platform.credential_link_projection (
  tenant_id uuid not null,
  tenant_display_name text not null,
  tenant_status text not null,
  establishment_id uuid not null,
  trade_name text not null,
  establishment_status text not null,
  link_status text not null,
  updated_at timestamptz not null,
  primary key (tenant_id, establishment_id),
  constraint platform_projection_tenant_name_valid
    check (btrim(tenant_display_name) <> ''),
  constraint platform_projection_tenant_status_valid
    check (tenant_status in ('active', 'suspended')),
  constraint platform_projection_trade_name_valid
    check (btrim(trade_name) <> ''),
  constraint platform_projection_establishment_status_valid
    check (establishment_status in ('active', 'inactive')),
  constraint platform_projection_link_status_valid check (
    link_status in (
      'not_started', 'pending', 'confirmed', 'enabled',
      'deactivated', 'rejected'
    )
  )
);

create index platform_credential_link_queue_idx
  on renave_platform.credential_link_projection (
    tenant_status, establishment_status,
    (case link_status
      when 'pending' then 0
      when 'confirmed' then 1
      when 'not_started' then 2
      when 'rejected' then 3
      when 'deactivated' then 4
      when 'enabled' then 5
      else 6 end),
    updated_at, tenant_id, establishment_id
  );

create table renave_platform.audit_chain_head (
  singleton boolean primary key default true check (singleton),
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_hash bytea not null default decode(repeat('00', 32), 'hex')
    check (octet_length(last_hash) = 32),
  event_count bigint not null default 0 check (event_count >= 0)
);

insert into renave_platform.audit_chain_head (singleton) values (true);

create table renave_platform.audit_event (
  sequence bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  actor_digest bytea not null check (octet_length(actor_digest) = 32),
  actor_ip inet not null,
  trace_digest bytea not null check (octet_length(trace_digest) = 32),
  reason_ticket_digest bytea not null
    check (octet_length(reason_ticket_digest) = 32),
  action text not null check (action in (
    'platform.operator.grant', 'platform.operator.revoke',
    'platform.credential-link-queue.read'
  )),
  outcome text not null check (outcome in ('succeeded', 'rejected')),
  target_digest bytea check (
    target_digest is null or octet_length(target_digest) = 32
  ),
  result_count integer not null check (result_count >= 0),
  truncated boolean not null,
  previous_hash bytea not null check (octet_length(previous_hash) = 32),
  event_hash bytea not null check (octet_length(event_hash) = 32)
);

create index platform_audit_timeline_idx
  on renave_platform.audit_event (occurred_at desc, sequence desc);

create function renave_platform.audit_event_reject_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'platform audit é append-only'
    using errcode='insufficient_privilege';
end
$$;

create trigger platform_audit_append_only
  before update or delete on renave_platform.audit_event
  for each row execute function renave_platform.audit_event_reject_change();

create trigger platform_audit_append_only_truncate
  before truncate on renave_platform.audit_event
  for each statement execute function renave_platform.audit_event_reject_change();

create function renave_platform.operator_grant_revision_reject_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'platform grant revision é append-only'
    using errcode='insufficient_privilege';
end
$$;

create trigger platform_grant_revision_append_only
  before update or delete on renave_platform.operator_grant_revision
  for each row execute function
    renave_platform.operator_grant_revision_reject_change();

create trigger platform_grant_revision_append_only_truncate
  before truncate on renave_platform.operator_grant_revision
  for each statement execute function
    renave_platform.operator_grant_revision_reject_change();

create function renave_platform.append_audit_event(
  p_actor_digest bytea, p_actor_ip inet, p_trace_digest bytea,
  p_reason_ticket_digest bytea,
  p_action text, p_outcome text, p_target_digest bytea,
  p_result_count integer, p_truncated boolean
)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  next_sequence bigint;
  previous_digest bytea;
  event_time timestamptz := clock_timestamp();
  next_digest bytea;
begin
  if p_actor_digest is null or octet_length(p_actor_digest) <> 32
     or p_actor_ip is null
     or p_trace_digest is null or octet_length(p_trace_digest) <> 32
     or p_reason_ticket_digest is null
     or octet_length(p_reason_ticket_digest) <> 32
     or p_action not in (
       'platform.operator.grant', 'platform.operator.revoke',
       'platform.credential-link-queue.read')
     or p_outcome not in ('succeeded', 'rejected')
     or (p_target_digest is not null and octet_length(p_target_digest) <> 32)
     or p_result_count is null or p_result_count < 0
     or p_truncated is null then
    raise exception 'platform audit: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('renave_platform.audit', 6301));
  select last_hash into previous_digest
    from renave_platform.audit_chain_head where singleton for update;

  select nextval(pg_get_serial_sequence(
    'renave_platform.audit_event', 'sequence')) into next_sequence;
  next_digest := sha256(convert_to(jsonb_build_object(
    'sequence',next_sequence,
    'occurredAtEpochMicros',(extract(epoch from event_time)*1000000)::bigint,
    'actorDigest',encode(p_actor_digest,'hex'),
    'actorIp',p_actor_ip::text,
    'traceDigest',encode(p_trace_digest,'hex'),
    'reasonTicketDigest',encode(p_reason_ticket_digest,'hex'),
    'action',p_action,'outcome',p_outcome,
    'targetDigest',case when p_target_digest is null then null
      else encode(p_target_digest,'hex') end,
    'resultCount',p_result_count,'truncated',p_truncated,
    'previousHash',encode(previous_digest,'hex'))::text,'UTF8'));

  insert into renave_platform.audit_event (
    sequence,occurred_at,actor_digest,actor_ip,trace_digest,
    reason_ticket_digest,action,outcome,target_digest,result_count,truncated,
    previous_hash,event_hash
  ) overriding system value values (
    next_sequence,event_time,p_actor_digest,p_actor_ip,p_trace_digest,
    p_reason_ticket_digest,p_action,p_outcome,p_target_digest,
    p_result_count,p_truncated,
    previous_digest,next_digest
  );
  update renave_platform.audit_chain_head
    set last_sequence=next_sequence,last_hash=next_digest,
        event_count=event_count+1
    where singleton;
end
$$;

create function renave_platform.assert_provisioner()
returns void language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if session_user <> 'renave_platform_provisioner'
     or current_user <> 'renave_migrator'
     or not coalesce(renave_platform.contract_ready(),false) then
    raise exception 'platform provisioner: acesso negado'
      using errcode='insufficient_privilege';
  end if;
end
$$;

create function renave_platform.grant_operator(
  p_actor_digest bytea, p_valid_from timestamptz, p_expires_at timestamptz,
  p_ticket_digest bytea, p_changed_by_digest bytea,
  p_actor_ip inet, p_trace_digest bytea
)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare now_at timestamptz := clock_timestamp();
begin
  perform renave_platform.assert_provisioner();
  -- Entrada malformada não constitui decisão autorizativa: falha antes de
  -- qualquer mutação ou auditoria. Decisões válidas são auditadas abaixo.
  if p_actor_digest is null or octet_length(p_actor_digest) <> 32
     or p_ticket_digest is null or octet_length(p_ticket_digest) <> 32
     or p_changed_by_digest is null or octet_length(p_changed_by_digest) <> 32
     or p_valid_from is null or p_expires_at is null
     or p_valid_from > now_at + interval '5 minutes'
     or p_expires_at <= greatest(p_valid_from,now_at)
     or p_expires_at > now_at + interval '366 days' then
    raise exception 'platform grant: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  insert into renave_platform.operator_grant (
    actor_digest,role,status,valid_from,expires_at,ticket_digest,
    changed_by_digest,granted_at,revoked_at,revocation_ticket_digest
  ) values (
    p_actor_digest,'integrator_link_reviewer','active',p_valid_from,p_expires_at,
    p_ticket_digest,p_changed_by_digest,now_at,null,null
  ) on conflict (actor_digest) do update set
    role='integrator_link_reviewer',status='active',
    valid_from=excluded.valid_from,expires_at=excluded.expires_at,
    ticket_digest=excluded.ticket_digest,
    changed_by_digest=excluded.changed_by_digest,granted_at=excluded.granted_at,
    revoked_at=null,revocation_ticket_digest=null;
  insert into renave_platform.operator_grant_revision (
    actor_digest,action,role,status,valid_from,expires_at,
    decision_ticket_digest,changed_by_digest,decided_at
  ) values (
    p_actor_digest,'grant','integrator_link_reviewer','active',
    p_valid_from,p_expires_at,p_ticket_digest,p_changed_by_digest,now_at
  );
  perform renave_platform.append_audit_event(
    p_changed_by_digest,p_actor_ip,p_trace_digest,p_ticket_digest,
    'platform.operator.grant','succeeded',p_actor_digest,0,false);
end
$$;

create function renave_platform.revoke_operator(
  p_actor_digest bytea, p_ticket_digest bytea, p_changed_by_digest bytea,
  p_actor_ip inet, p_trace_digest bytea
)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare changed boolean;
begin
  perform renave_platform.assert_provisioner();
  -- Como exceptions revertem a transação inteira, a validação antecede toda
  -- ação; revogações válidas, inclusive sem grant ativo, chegam à auditoria.
  if p_actor_digest is null or octet_length(p_actor_digest) <> 32
     or p_ticket_digest is null or octet_length(p_ticket_digest) <> 32
     or p_changed_by_digest is null or octet_length(p_changed_by_digest) <> 32 then
    raise exception 'platform revoke: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  update renave_platform.operator_grant set
    status='revoked',revoked_at=clock_timestamp(),
    revocation_ticket_digest=p_ticket_digest,
    changed_by_digest=p_changed_by_digest
  where actor_digest=p_actor_digest and status='active';
  changed := found;
  if changed then
    insert into renave_platform.operator_grant_revision (
      actor_digest,action,role,status,valid_from,expires_at,
      decision_ticket_digest,changed_by_digest,decided_at
    ) select actor_digest,'revoke',role,status,valid_from,expires_at,
        p_ticket_digest,p_changed_by_digest,revoked_at
      from renave_platform.operator_grant
      where actor_digest=p_actor_digest;
  end if;
  perform renave_platform.append_audit_event(
    p_changed_by_digest,p_actor_ip,p_trace_digest,p_ticket_digest,
    'platform.operator.revoke',
    case when changed then 'succeeded' else 'rejected' end,
    p_actor_digest,0,false);
  return changed;
end
$$;

create function renave_platform.sync_tenant_projection()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' then
    delete from renave_platform.credential_link_projection
      where tenant_id=old.id;
    return old;
  end if;
  update renave_platform.credential_link_projection set
    tenant_display_name=new.display_name,tenant_status=new.status
    where tenant_id=new.id;
  return new;
end
$$;

create trigger platform_tenant_projection
  after update or delete on renave.tenant
  for each row execute function renave_platform.sync_tenant_projection();

create function renave_platform.sync_establishment_projection()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare tenant_name text; tenant_state text; current_link text; link_time timestamptz;
begin
  if tg_op='DELETE' then
    delete from renave_platform.credential_link_projection
      where tenant_id=old.tenant_id and establishment_id=old.id;
    return old;
  end if;
  if tg_op='UPDATE' then
    update renave_platform.credential_link_projection set
      trade_name=new.trade_name,establishment_status=new.status
      where tenant_id=new.tenant_id and establishment_id=new.id;
    if found then return new; end if;
  end if;
  select t.display_name,t.status into tenant_name,tenant_state
    from renave.tenant t where t.id=new.tenant_id;
  select l.status,l.updated_at into current_link,link_time
    from renave.credential_link l
    where l.tenant_id=new.tenant_id and l.establishment_id=new.id;
  insert into renave_platform.credential_link_projection (
    tenant_id,tenant_display_name,tenant_status,establishment_id,trade_name,
    establishment_status,link_status,updated_at
  ) values (
    new.tenant_id,tenant_name,tenant_state,new.id,new.trade_name,new.status,
    coalesce(current_link,'not_started'),coalesce(link_time,new.updated_at)
  ) on conflict (tenant_id,establishment_id) do update set
    tenant_display_name=excluded.tenant_display_name,
    tenant_status=excluded.tenant_status,trade_name=excluded.trade_name,
    establishment_status=excluded.establishment_status,
    link_status=excluded.link_status,updated_at=excluded.updated_at;
  return new;
end
$$;

create trigger platform_establishment_projection
  after insert or update or delete on renave.establishment
  for each row execute function renave_platform.sync_establishment_projection();

create function renave_platform.sync_credential_link_projection()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' then
    update renave_platform.credential_link_projection set
      link_status='not_started',updated_at=clock_timestamp()
      where tenant_id=old.tenant_id and establishment_id=old.establishment_id;
    return old;
  end if;
  update renave_platform.credential_link_projection set
    link_status=new.status,updated_at=new.updated_at
    where tenant_id=new.tenant_id and establishment_id=new.establishment_id;
  return new;
end
$$;

create trigger platform_credential_link_projection
  after insert or update or delete on renave.credential_link
  for each row execute function renave_platform.sync_credential_link_projection();

-- Backfill transacional; FORCE RLS é restaurado antes do COMMIT.
alter table renave.tenant no force row level security;
alter table renave.establishment no force row level security;
alter table renave.credential_link no force row level security;
insert into renave_platform.credential_link_projection (
  tenant_id,tenant_display_name,tenant_status,establishment_id,trade_name,
  establishment_status,link_status,updated_at
)
select t.id,t.display_name,t.status,e.id,e.trade_name,e.status,
  coalesce(l.status,'not_started'),coalesce(l.updated_at,e.updated_at)
from renave.tenant t join renave.establishment e on e.tenant_id=t.id
left join renave.credential_link l
  on l.tenant_id=e.tenant_id and l.establishment_id=e.id;
alter table renave.credential_link force row level security;
alter table renave.establishment force row level security;
alter table renave.tenant force row level security;

create function renave_platform.assert_reader()
returns void language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if session_user <> 'renave_platform_reader'
     or current_user <> 'renave_migrator'
     or not coalesce(renave_platform.contract_ready(),false) then
    raise exception 'platform reader: acesso negado'
      using errcode='insufficient_privilege';
  end if;
end
$$;

create function renave_platform.list_credential_link_queue(
  p_actor_digest bytea, p_reason_ticket_digest bytea,
  p_actor_ip inet, p_trace_digest bytea,
  p_after_priority integer default null,
  p_after_updated_at timestamptz default null,
  p_after_tenant_id uuid default null,
  p_after_establishment_id uuid default null,
  p_limit integer default 100
)
returns table (
  authorized boolean, tenant_id uuid, tenant_display_name text,
  establishment_id uuid, trade_name text, link_status text,
  link_updated_at timestamptz, cursor_priority integer, truncated boolean
)
language plpgsql security definer set search_path=pg_catalog as $$
declare
  grant_active boolean;
  page renave_platform.credential_link_projection[];
  item renave_platform.credential_link_projection;
  page_truncated boolean;
  result_count integer;
  cursor_complete boolean := p_after_priority is not null
    and p_after_updated_at is not null and p_after_tenant_id is not null
    and p_after_establishment_id is not null;
begin
  perform renave_platform.assert_reader();
  -- Justificativa, ator e cursor inválidos falham antes da leitura/auditoria.
  -- Autorização válida ou negada sempre persiste o evento antes do retorno.
  if p_actor_digest is null or octet_length(p_actor_digest) <> 32
     or p_reason_ticket_digest is null
     or octet_length(p_reason_ticket_digest) <> 32
     or p_actor_ip is null
     or p_trace_digest is null or octet_length(p_trace_digest) <> 32
     or p_limit is null or p_limit < 1 or p_limit > 500
     or (num_nonnulls(p_after_priority,p_after_updated_at,p_after_tenant_id,
           p_after_establishment_id) not in (0,4))
     or (cursor_complete and p_after_priority not between 0 and 5) then
    raise exception 'platform queue: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;

  select exists(select 1 from renave_platform.operator_grant g
    where g.actor_digest=p_actor_digest and g.role='integrator_link_reviewer'
      and g.status='active' and g.valid_from <= clock_timestamp()
      and g.expires_at > clock_timestamp()) into grant_active;
  if not grant_active then
    perform renave_platform.append_audit_event(
      p_actor_digest,p_actor_ip,p_trace_digest,p_reason_ticket_digest,
      'platform.credential-link-queue.read','rejected',null,0,false);
    return query select false,null::uuid,null::text,null::uuid,null::text,
      null::text,null::timestamptz,null::integer,false;
    return;
  end if;

  select array_agg(row(
      row_item.tenant_id,row_item.tenant_display_name,row_item.tenant_status,
      row_item.establishment_id,row_item.trade_name,
      row_item.establishment_status,row_item.link_status,row_item.updated_at
    )::renave_platform.credential_link_projection
    order by row_item.priority,row_item.updated_at,
      row_item.tenant_id,row_item.establishment_id)
    into page
  from (
    select p.*,
      case p.link_status when 'pending' then 0 when 'confirmed' then 1
        when 'not_started' then 2 when 'rejected' then 3
        when 'deactivated' then 4 when 'enabled' then 5 else 6 end as priority
    from renave_platform.credential_link_projection p
    where p.tenant_status='active' and p.establishment_status='active'
      and (not cursor_complete or
        (case p.link_status when 'pending' then 0 when 'confirmed' then 1
          when 'not_started' then 2 when 'rejected' then 3
          when 'deactivated' then 4 when 'enabled' then 5 else 6 end,
         p.updated_at,p.tenant_id,p.establishment_id) >
        (p_after_priority,p_after_updated_at,p_after_tenant_id,
         p_after_establishment_id))
    order by priority,p.updated_at,p.tenant_id,p.establishment_id
    limit p_limit+1
  ) row_item;
  result_count := least(coalesce(cardinality(page),0),p_limit);
  page_truncated := coalesce(cardinality(page),0) > p_limit;
  perform renave_platform.append_audit_event(
    p_actor_digest,p_actor_ip,p_trace_digest,p_reason_ticket_digest,
    'platform.credential-link-queue.read','succeeded',null,
    result_count,page_truncated);
  if result_count=0 then
    return query select true,null::uuid,null::text,null::uuid,null::text,
      null::text,null::timestamptz,null::integer,false;
    return;
  end if;
  foreach item in array page[1:result_count] loop
    authorized:=true; tenant_id:=item.tenant_id;
    tenant_display_name:=item.tenant_display_name;
    establishment_id:=item.establishment_id; trade_name:=item.trade_name;
    link_status:=item.link_status; link_updated_at:=item.updated_at;
    cursor_priority:=case item.link_status when 'pending' then 0
      when 'confirmed' then 1 when 'not_started' then 2
      when 'rejected' then 3 when 'deactivated' then 4
      when 'enabled' then 5 else 6 end;
    truncated:=page_truncated;
    return next;
  end loop;
end
$$;

revoke all on all tables in schema renave_platform from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on all sequences in schema renave_platform from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on all functions in schema renave_platform from public,renave_app,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
revoke all on schema renave,renave_directory,renave_admin
  from renave_platform_reader,renave_platform_provisioner;
revoke all on all tables in schema renave,renave_directory,renave_admin
  from renave_platform_reader,renave_platform_provisioner;
revoke all on all sequences in schema renave,renave_directory,renave_admin
  from renave_platform_reader,renave_platform_provisioner;
