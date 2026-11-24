-- 0070 — Jurisdição regulatória verificada e autorização por serviço.
--
-- `credential_link` continua sendo apenas prova de identidade entre loja e
-- integradora. O preflight não prova natureza nem abrangência. Por isso estas
-- tabelas começam vazias: não existe backfill ou default permissivo.

create table renave.establishment_regulatory_jurisdiction (
  tenant_id uuid not null,
  establishment_id uuid not null,
  jurisdiction_uf text not null,
  status text not null,
  version bigint not null,
  generation bigint not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  evidence_digest bytea not null,
  decision_ticket_digest bytea not null,
  changed_by_digest bytea not null,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, establishment_id, jurisdiction_uf),
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint establishment_regulatory_jurisdiction_uf_valid check (
    jurisdiction_uf in (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    )
  ),
  constraint establishment_regulatory_jurisdiction_status_valid check (
    status in ('verified', 'suspended', 'revoked')
  ),
  constraint establishment_regulatory_jurisdiction_version_valid check (
    version > 0 and generation = version
  ),
  constraint establishment_regulatory_jurisdiction_window_valid check (
    valid_from < expires_at
    and expires_at <= valid_from + interval '366 days'
  ),
  constraint establishment_regulatory_jurisdiction_evidence_valid check (
    pg_catalog.octet_length(evidence_digest) = 32
    and pg_catalog.octet_length(decision_ticket_digest) = 32
    and pg_catalog.octet_length(changed_by_digest) = 32
  )
);

create table renave.establishment_regulatory_jurisdiction_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  establishment_id uuid not null,
  jurisdiction_uf text not null,
  version bigint not null,
  previous_status text,
  status text not null,
  generation bigint not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  evidence_digest bytea not null,
  decision_ticket_digest bytea not null,
  changed_by_digest bytea not null,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (tenant_id, establishment_id, jurisdiction_uf)
    references renave.establishment_regulatory_jurisdiction (
      tenant_id, establishment_id, jurisdiction_uf
    ) on delete restrict,
  constraint establishment_regulatory_jurisdiction_history_version_key
    unique (tenant_id, establishment_id, jurisdiction_uf, version),
  constraint establishment_regulatory_jurisdiction_history_uf_valid check (
    jurisdiction_uf in (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    )
  ),
  constraint establishment_regulatory_jurisdiction_history_status_valid check (
    status in ('verified', 'suspended', 'revoked')
    and (previous_status is null or previous_status in (
      'verified', 'suspended', 'revoked'
    ))
  ),
  constraint establishment_regulatory_jurisdiction_history_version_valid check (
    version > 0 and generation = version
  ),
  constraint establishment_regulatory_jurisdiction_history_window_valid check (
    valid_from < expires_at
    and expires_at <= valid_from + interval '366 days'
  ),
  constraint establishment_regulatory_jurisdiction_history_evidence_valid check (
    pg_catalog.octet_length(evidence_digest) = 32
    and pg_catalog.octet_length(decision_ticket_digest) = 32
    and pg_catalog.octet_length(changed_by_digest) = 32
  )
);

create table renave.credential_service_scope (
  tenant_id uuid not null,
  establishment_id uuid not null,
  service_nature text not null,
  jurisdiction_uf text not null,
  status text not null,
  version bigint not null,
  generation bigint not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  evidence_digest bytea not null,
  decision_ticket_digest bytea not null,
  changed_by_digest bytea not null,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (
    tenant_id, establishment_id, service_nature, jurisdiction_uf
  ),
  foreign key (tenant_id, establishment_id, jurisdiction_uf)
    references renave.establishment_regulatory_jurisdiction (
      tenant_id, establishment_id, jurisdiction_uf
    ) on delete restrict,
  constraint credential_service_scope_nature_valid check (
    service_nature in ('establishment', 'ite', 'manufacturer')
  ),
  constraint credential_service_scope_uf_valid check (
    jurisdiction_uf in (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    )
  ),
  constraint credential_service_scope_status_valid check (
    status in ('pending', 'enabled', 'suspended', 'revoked')
  ),
  constraint credential_service_scope_version_valid check (
    version > 0 and generation = version
  ),
  constraint credential_service_scope_window_valid check (
    valid_from < expires_at
    and expires_at <= valid_from + interval '366 days'
  ),
  constraint credential_service_scope_evidence_valid check (
    pg_catalog.octet_length(evidence_digest) = 32
    and pg_catalog.octet_length(decision_ticket_digest) = 32
    and pg_catalog.octet_length(changed_by_digest) = 32
  )
);

create table renave.credential_service_scope_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  establishment_id uuid not null,
  service_nature text not null,
  jurisdiction_uf text not null,
  version bigint not null,
  previous_status text,
  status text not null,
  generation bigint not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  evidence_digest bytea not null,
  decision_ticket_digest bytea not null,
  changed_by_digest bytea not null,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (
    tenant_id, establishment_id, service_nature, jurisdiction_uf
  ) references renave.credential_service_scope (
    tenant_id, establishment_id, service_nature, jurisdiction_uf
  ) on delete restrict,
  constraint credential_service_scope_history_version_key unique (
    tenant_id, establishment_id, service_nature, jurisdiction_uf, version
  ),
  constraint credential_service_scope_history_nature_valid check (
    service_nature in ('establishment', 'ite', 'manufacturer')
  ),
  constraint credential_service_scope_history_status_valid check (
    status in ('pending', 'enabled', 'suspended', 'revoked')
    and (previous_status is null or previous_status in (
      'pending', 'enabled', 'suspended', 'revoked'
    ))
  ),
  constraint credential_service_scope_history_version_valid check (
    version > 0 and generation = version
  ),
  constraint credential_service_scope_history_window_valid check (
    valid_from < expires_at
    and expires_at <= valid_from + interval '366 days'
  ),
  constraint credential_service_scope_history_evidence_valid check (
    pg_catalog.octet_length(evidence_digest) = 32
    and pg_catalog.octet_length(decision_ticket_digest) = 32
    and pg_catalog.octet_length(changed_by_digest) = 32
  )
);

create index establishment_regulatory_jurisdiction_history_timeline_idx
  on renave.establishment_regulatory_jurisdiction_history (
    tenant_id, establishment_id, jurisdiction_uf, version desc
  );
create index credential_service_scope_history_timeline_idx
  on renave.credential_service_scope_history (
    tenant_id, establishment_id, service_nature, jurisdiction_uf,
    version desc
  );

alter table renave.establishment_regulatory_jurisdiction
  enable row level security;
alter table renave.establishment_regulatory_jurisdiction
  force row level security;
alter table renave.establishment_regulatory_jurisdiction_history
  enable row level security;
alter table renave.establishment_regulatory_jurisdiction_history
  force row level security;
alter table renave.credential_service_scope enable row level security;
alter table renave.credential_service_scope force row level security;
alter table renave.credential_service_scope_history enable row level security;
alter table renave.credential_service_scope_history force row level security;

create policy establishment_regulatory_jurisdiction_isolation
  on renave.establishment_regulatory_jurisdiction
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy establishment_regulatory_jurisdiction_history_isolation
  on renave.establishment_regulatory_jurisdiction_history
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy credential_service_scope_isolation
  on renave.credential_service_scope
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));
create policy credential_service_scope_history_isolation
  on renave.credential_service_scope_history
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create function renave.regulatory_scope_history_reject_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'regulatory scope history é append-only'
    using errcode='insufficient_privilege';
end
$$;
create trigger establishment_regulatory_jurisdiction_history_append_only
  before update or delete
  on renave.establishment_regulatory_jurisdiction_history
  for each row execute function renave.regulatory_scope_history_reject_change();
create trigger credential_service_scope_history_append_only
  before update or delete on renave.credential_service_scope_history
  for each row execute function renave.regulatory_scope_history_reject_change();

create function renave_admin.transition_establishment_regulatory_jurisdiction(
  p_establishment_id uuid, p_jurisdiction_uf text, p_status text,
  p_valid_from timestamptz, p_expires_at timestamptz,
  p_evidence_digest bytea, p_decision_ticket_digest bytea,
  p_changed_by_digest bytea
)
returns renave.establishment_regulatory_jurisdiction
language plpgsql security definer set search_path=pg_catalog as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_item renave.establishment_regulatory_jurisdiction;
  next_item renave.establishment_regulatory_jurisdiction;
  next_version bigint;
begin
  if session_user <> 'renave_credential_scope_provisioner' then
    raise exception 'regulatory jurisdiction: papel offline obrigatório'
      using errcode='insufficient_privilege';
  end if;
  if active_tenant is null or p_establishment_id is null
     or p_jurisdiction_uf not in (
       'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
       'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
     )
     or p_status not in ('verified','suspended','revoked')
     or p_valid_from is null or p_expires_at is null
     or p_valid_from >= p_expires_at
     or p_expires_at > p_valid_from + interval '366 days'
     or pg_catalog.octet_length(p_evidence_digest) <> 32
     or pg_catalog.octet_length(p_decision_ticket_digest) <> 32
     or pg_catalog.octet_length(p_changed_by_digest) <> 32 then
    raise exception 'regulatory jurisdiction: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  perform 1 from renave.establishment establishment
   where establishment.tenant_id=active_tenant
     and establishment.id=p_establishment_id
     and establishment.status='active' for share;
  if not found then
    raise exception 'regulatory jurisdiction: estabelecimento indisponível'
      using errcode='insufficient_privilege';
  end if;
  -- O mesmo fence serializa autorização runtime e qualquer troca de UF.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text, 700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text || ':' ||
      p_jurisdiction_uf, 700071));
  select item.* into current_item
    from renave.establishment_regulatory_jurisdiction item
   where item.tenant_id=active_tenant
     and item.establishment_id=p_establishment_id
     and item.jurisdiction_uf=p_jurisdiction_uf for update;
  if found then
    if current_item.status='revoked' or not (case current_item.status
      when 'verified' then p_status in ('suspended','revoked')
      when 'suspended' then p_status in ('verified','revoked')
      else false end) then
      raise exception 'regulatory jurisdiction: transição inválida'
        using errcode='integrity_constraint_violation';
    end if;
    next_version := current_item.version + 1;
    update renave.establishment_regulatory_jurisdiction set
      status=p_status,version=next_version,generation=next_version,
      valid_from=p_valid_from,expires_at=p_expires_at,
      evidence_digest=p_evidence_digest,
      decision_ticket_digest=p_decision_ticket_digest,
      changed_by_digest=p_changed_by_digest,
      updated_at=pg_catalog.clock_timestamp()
    where tenant_id=active_tenant and establishment_id=p_establishment_id
      and jurisdiction_uf=p_jurisdiction_uf returning * into next_item;
  else
    next_version := 1;
    insert into renave.establishment_regulatory_jurisdiction (
      tenant_id,establishment_id,jurisdiction_uf,status,version,generation,
      valid_from,expires_at,evidence_digest,decision_ticket_digest,
      changed_by_digest
    ) values (
      active_tenant,p_establishment_id,p_jurisdiction_uf,p_status,1,1,
      p_valid_from,p_expires_at,p_evidence_digest,p_decision_ticket_digest,
      p_changed_by_digest
    ) returning * into next_item;
  end if;
  insert into renave.establishment_regulatory_jurisdiction_history (
    tenant_id,establishment_id,jurisdiction_uf,version,previous_status,status,
    generation,valid_from,expires_at,evidence_digest,decision_ticket_digest,
    changed_by_digest,changed_at
  ) values (
    active_tenant,p_establishment_id,p_jurisdiction_uf,next_version,
    current_item.status,next_item.status,next_item.generation,
    next_item.valid_from,next_item.expires_at,next_item.evidence_digest,
    next_item.decision_ticket_digest,next_item.changed_by_digest,
    next_item.updated_at
  );
  return next_item;
end
$$;

create function renave_admin.transition_credential_service_scope(
  p_establishment_id uuid, p_service_nature text, p_jurisdiction_uf text,
  p_status text, p_valid_from timestamptz, p_expires_at timestamptz,
  p_evidence_digest bytea, p_decision_ticket_digest bytea,
  p_changed_by_digest bytea
)
returns renave.credential_service_scope
language plpgsql security definer set search_path=pg_catalog as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_item renave.credential_service_scope;
  next_item renave.credential_service_scope;
  next_version bigint;
begin
  if session_user <> 'renave_credential_scope_provisioner' then
    raise exception 'credential service scope: papel offline obrigatório'
      using errcode='insufficient_privilege';
  end if;
  if active_tenant is null or p_establishment_id is null
     or p_service_nature not in ('establishment','ite','manufacturer')
     or p_jurisdiction_uf not in (
       'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
       'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
     )
     or p_status not in ('pending','enabled','suspended','revoked')
     or p_valid_from is null or p_expires_at is null
     or p_valid_from >= p_expires_at
     or p_expires_at > p_valid_from + interval '366 days'
     or pg_catalog.octet_length(p_evidence_digest) <> 32
     or pg_catalog.octet_length(p_decision_ticket_digest) <> 32
     or pg_catalog.octet_length(p_changed_by_digest) <> 32 then
    raise exception 'credential service scope: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  -- Compartilhado com a transição de jurisdição e o gate runtime.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text, 700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text || ':' ||
      p_service_nature || ':' || p_jurisdiction_uf, 700070));
  perform 1 from renave.establishment_regulatory_jurisdiction jurisdiction
   where jurisdiction.tenant_id=active_tenant
     and jurisdiction.establishment_id=p_establishment_id
     and jurisdiction.jurisdiction_uf=p_jurisdiction_uf for share;
  if not found then
    raise exception 'credential service scope: jurisdição ausente'
      using errcode='insufficient_privilege';
  end if;
  select item.* into current_item from renave.credential_service_scope item
   where item.tenant_id=active_tenant
     and item.establishment_id=p_establishment_id
     and item.service_nature=p_service_nature
     and item.jurisdiction_uf=p_jurisdiction_uf for update;
  if found then
    if current_item.status='revoked' or not (case current_item.status
      when 'pending' then p_status in ('enabled','revoked')
      when 'enabled' then p_status in ('suspended','revoked')
      when 'suspended' then p_status in ('enabled','revoked')
      else false end) then
      raise exception 'credential service scope: transição inválida'
        using errcode='integrity_constraint_violation';
    end if;
    next_version := current_item.version + 1;
    update renave.credential_service_scope set
      status=p_status,version=next_version,generation=next_version,
      valid_from=p_valid_from,expires_at=p_expires_at,
      evidence_digest=p_evidence_digest,
      decision_ticket_digest=p_decision_ticket_digest,
      changed_by_digest=p_changed_by_digest,
      updated_at=pg_catalog.clock_timestamp()
    where tenant_id=active_tenant and establishment_id=p_establishment_id
      and service_nature=p_service_nature
      and jurisdiction_uf=p_jurisdiction_uf returning * into next_item;
  else
    next_version := 1;
    insert into renave.credential_service_scope (
      tenant_id,establishment_id,service_nature,jurisdiction_uf,status,
      version,generation,valid_from,expires_at,evidence_digest,
      decision_ticket_digest,changed_by_digest
    ) values (
      active_tenant,p_establishment_id,p_service_nature,p_jurisdiction_uf,
      p_status,1,1,p_valid_from,p_expires_at,p_evidence_digest,
      p_decision_ticket_digest,p_changed_by_digest
    ) returning * into next_item;
  end if;
  insert into renave.credential_service_scope_history (
    tenant_id,establishment_id,service_nature,jurisdiction_uf,version,
    previous_status,status,generation,valid_from,expires_at,evidence_digest,
    decision_ticket_digest,changed_by_digest,changed_at
  ) values (
    active_tenant,p_establishment_id,p_service_nature,p_jurisdiction_uf,
    next_version,current_item.status,next_item.status,next_item.generation,
    next_item.valid_from,next_item.expires_at,next_item.evidence_digest,
    next_item.decision_ticket_digest,next_item.changed_by_digest,
    next_item.updated_at
  );
  return next_item;
end
$$;

revoke all on table
  renave.establishment_regulatory_jurisdiction,
  renave.establishment_regulatory_jurisdiction_history,
  renave.credential_service_scope,
  renave.credential_service_scope_history
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant select on table renave.establishment_regulatory_jurisdiction,
  renave.credential_service_scope to renave_app;

revoke all on sequence
  renave.establishment_regulatory_jurisdiction_history_id_seq,
  renave.credential_service_scope_history_id_seq
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

revoke all on function renave_admin.transition_establishment_regulatory_jurisdiction(
  uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea
), renave_admin.transition_credential_service_scope(
  uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea
) from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_reader,renave_platform_reader,
  renave_platform_provisioner;
grant execute on function
  renave_admin.transition_establishment_regulatory_jurisdiction(
    uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea
  ),
  renave_admin.transition_credential_service_scope(
    uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea
  ) to renave_credential_scope_provisioner;

grant usage on schema renave_admin to renave_credential_scope_provisioner;
revoke create on schema renave_admin from renave_credential_scope_provisioner;
revoke all on schema renave from renave_credential_scope_provisioner;

alter function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea
) rename to create_held_local_operation_without_regulatory_scope_v0049;
revoke all on function
  renave.create_held_local_operation_without_regulatory_scope_v0049(
    uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
    bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea
  ) from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave.create_held_local_operation(
  p_operation_id uuid,p_establishment_id uuid,p_kind text,
  p_mutation_family text,p_idempotency_key_digest bytea,
  p_vehicle_key_digest bytea,p_request_sha256 bytea,p_request_size integer,
  p_request_schema_version integer,p_request_key_id text,
  p_request_nonce bytea,p_request_auth_tag bytea,p_request_ciphertext bytea,
  p_actor_subject_hash bytea,p_correlation_id uuid,p_projection_kind text,
  p_projection_schema_version integer,p_projection_generation bigint,
  p_projection_size integer,p_projection_key_id text,p_projection_nonce bytea,
  p_projection_auth_tag bytea,p_projection_ciphertext bytea
)
returns table(operation_id uuid,operation_status text,replayed boolean,
  operation_created_at timestamptz)
language plpgsql security definer set search_path=pg_catalog as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  required_nature text;
  jurisdiction_count integer;
  effective_uf text;
begin
  if active_tenant is null then
    raise exception 'operation: tenant ausente'
      using errcode='insufficient_privilege';
  end if;
  if p_establishment_id is null then
    raise exception 'operation: identificador ausente'
      using errcode='invalid_parameter_value';
  end if;
  required_nature := case p_kind
    when 'USED_STOCK_ENTRY' then 'establishment' else null end;
  if required_nature is null then
    raise exception 'operation: tipo inválido'
      using errcode='invalid_parameter_value';
  end if;

  -- Adquirido antes da resolução da UF; o provisionador usa o mesmo fence.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text, 700069));

  select count(*)::integer,min(jurisdiction.jurisdiction_uf)
    into jurisdiction_count,effective_uf
    from renave.establishment_regulatory_jurisdiction jurisdiction
   where jurisdiction.tenant_id=active_tenant
     and jurisdiction.establishment_id=p_establishment_id
     and jurisdiction.status='verified'
     and jurisdiction.valid_from <= pg_catalog.statement_timestamp()
     and jurisdiction.expires_at > pg_catalog.statement_timestamp();
  if jurisdiction_count <> 1 then
    raise exception 'operation: jurisdição regulatória não verificada'
      using errcode='object_not_in_prerequisite_state';
  end if;
  perform 1
    from renave.establishment_regulatory_jurisdiction jurisdiction
   where jurisdiction.tenant_id=active_tenant
     and jurisdiction.establishment_id=p_establishment_id
     and jurisdiction.jurisdiction_uf=effective_uf
     and jurisdiction.status='verified'
     and jurisdiction.valid_from <= pg_catalog.statement_timestamp()
     and jurisdiction.expires_at > pg_catalog.statement_timestamp()
   for share;
  if not found then
    raise exception 'operation: jurisdição regulatória não verificada'
      using errcode='object_not_in_prerequisite_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text || ':' || p_establishment_id::text || ':' ||
      required_nature || ':' || effective_uf, 700070));
  perform 1 from renave.credential_service_scope scope
   where scope.tenant_id=active_tenant
     and scope.establishment_id=p_establishment_id
     and scope.service_nature=required_nature
     and scope.jurisdiction_uf=effective_uf
     and scope.status='enabled'
     and scope.valid_from <= pg_catalog.statement_timestamp()
     and scope.expires_at > pg_catalog.statement_timestamp()
   for share;
  if not found then
    raise exception 'operation: escopo credencial não habilitado'
      using errcode='object_not_in_prerequisite_state';
  end if;
  return query select * from
    renave.create_held_local_operation_without_regulatory_scope_v0049(
      p_operation_id,p_establishment_id,p_kind,p_mutation_family,
      p_idempotency_key_digest,p_vehicle_key_digest,p_request_sha256,
      p_request_size,p_request_schema_version,p_request_key_id,
      p_request_nonce,p_request_auth_tag,p_request_ciphertext,
      p_actor_subject_hash,p_correlation_id,p_projection_kind,
      p_projection_schema_version,p_projection_generation,p_projection_size,
      p_projection_key_id,p_projection_nonce,p_projection_auth_tag,
      p_projection_ciphertext
    );
end
$$;
revoke all on function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea
) from public,renave_credential_scope_provisioner,renave_identity_app,
  renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave.create_held_local_operation(
  uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,
  bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea
) to renave_app;

-- A 0058 fecha o catálogo histórico 0049–0056 e incluía a função de criação
-- original. Recompomos somente esse fingerprint: o snapshot legado continua
-- sendo calculado integralmente, e a substituição intencional só é normalizada
-- quando tanto a função antiga inacessível quanto o novo gate são exatos.
alter function renave_runtime.tenant_administration_catalog_fingerprint_v0048()
  rename to tenant_administration_catalog_fingerprint_without_regulatory_scope_v0048;
revoke all on function
  renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_scope_v0048()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.tenant_administration_catalog_fingerprint_v0048()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select case when
  renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_scope_v0048()=
    '205cf8483a3cf297b2023136a58a9af11a6f1f86eac1a0d215d5370571237c66'
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
          and function_item.provolatile='s'
          and function_item.proconfig='{search_path=pg_catalog}'::text[]
          and function_item.proacl::text=
            '{renave_migrator=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '8a4e9c59e465cbe35a24f9a63a59c5441ef58530c38a62fea56ee8e9775614ff'
        from pg_proc function_item join pg_roles owner
          on owner.oid=function_item.proowner
        where function_item.oid=
          'renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_scope_v0048()'::regprocedure)
  and (select function_item.proacl::text=
            '{renave_migrator=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '9aae4589bb54d3003e3ae8173525311b6c63a4cd97a270ab8c118cbc94d4feef'
        from pg_proc function_item where function_item.oid=
          'renave.create_held_local_operation_without_regulatory_scope_v0049(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure)
  and (select function_item.proacl::text=
            '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '52b18c85246082fbe9d5f95bb78495f285840b369622ce79c8effb8ec3477d27'
        from pg_proc function_item where function_item.oid=
          'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure)
then '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
else 'credential-service-scope-protected-catalog-drift' end
$$;
revoke all on function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
  rename to stock_entry_rate_limit_catalog_fingerprint_without_regulatory_scope_v0056;
revoke all on function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_without_regulatory_scope_v0056()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select case when
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_without_regulatory_scope_v0056()=
    '0b58f50ff82e96c96738898e5fd3f4c42bdb16981a60c038ab50b805557a1c45'
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
          and function_item.provolatile='s'
          and function_item.proconfig='{search_path=pg_catalog}'::text[]
          and function_item.proacl::text=
            '{renave_migrator=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '98fdc6cdc132e4fad120db26b126e53d3a9db38cc6dd78312d0d1efae56de2dc'
        from pg_proc function_item join pg_roles owner
          on owner.oid=function_item.proowner
        where function_item.oid=
          'renave_runtime.stock_entry_rate_limit_catalog_fingerprint_without_regulatory_scope_v0056()'::regprocedure)
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
          and function_item.provolatile='v'
          and function_item.proconfig='{search_path=pg_catalog}'::text[]
          and function_item.proacl::text=
            '{renave_migrator=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '9aae4589bb54d3003e3ae8173525311b6c63a4cd97a270ab8c118cbc94d4feef'
        from pg_proc function_item join pg_roles owner
          on owner.oid=function_item.proowner
        where function_item.oid=
          'renave.create_held_local_operation_without_regulatory_scope_v0049(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure)
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
          and function_item.provolatile='v'
          and function_item.proconfig='{search_path=pg_catalog}'::text[]
          and function_item.proacl::text=
            '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '52b18c85246082fbe9d5f95bb78495f285840b369622ce79c8effb8ec3477d27'
        from pg_proc function_item join pg_roles owner
          on owner.oid=function_item.proowner
        where function_item.oid=
          'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure)
then 'd5226c15ac4b48dbf8fb60c0d448f30f8d5af98ed56cf9f561d09f25d8b36d9a'
else 'credential-service-scope-catalog-drift' end
$$;
revoke all on function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- O novo papel e as duas rotinas fechadas alteram deliberadamente o snapshot
-- amplo de renave_admin da 0058. A ponte mantém todos os checks históricos e
-- só normaliza esse acréscimo quando o catálogo novo também está exato.
alter function renave_runtime.profile_administration_catalog_fingerprint_v0058()
  rename to profile_administration_catalog_fingerprint_without_credential_scope;
revoke all on function
  renave_runtime.profile_administration_catalog_fingerprint_without_credential_scope()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.profile_administration_catalog_fingerprint_v0058()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select case when
  renave_runtime.profile_administration_catalog_fingerprint_without_credential_scope()=
    '5cb288acbd00a1b3c5604ce702fe3323fa1b2205594fd3a00b639b26b483e4bc'
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
          and function_item.provolatile='s'
          and function_item.proconfig='{search_path=pg_catalog}'::text[]
          and function_item.proacl::text=
            '{renave_migrator=X/renave_migrator}'
          and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
            '82219d2efa80e8f07b59fab82538789e0e6e46878dd18a5e07b24a181ea2515f'
        from pg_proc function_item join pg_roles owner
          on owner.oid=function_item.proowner
        where function_item.oid=
          'renave_runtime.profile_administration_catalog_fingerprint_without_credential_scope()'::regprocedure)
then '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
else 'credential-service-scope-profile-catalog-drift' end
$$;
revoke all on function
  renave_runtime.profile_administration_catalog_fingerprint_v0058()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create or replace function
  renave_runtime.profile_administration_contract_ready_v0058()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
  and (select checksum='0e305b1d30e1526dd019a295bb7dc56687e6ff8b0ed8444c05a383e98ce0549f'
    from renave.schema_migrations where version='0051_verified_renave_profiles')
  and (select checksum='0b85d8e3e0956de568b5caed308bb6527d271e3ed2be40862b50d373d382a48d'
    from renave.schema_migrations where version='0053_verified_renave_principal_resolution')
  and (select checksum='a8c66f647e5f96c8718f42b2b2cd0eebd0ba8f7baf7b93adc43ba72f11da6992'
    from renave.schema_migrations where version='0057_renave_profile_administration')
  and renave_runtime.profile_administration_catalog_fingerprint_v0058()=
    '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
  and (select not rolsuper and not rolinherit and not rolcreaterole
      and not rolcreatedb and rolcanlogin and not rolreplication
      and not rolbypassrls from pg_roles
      where rolname='renave_profile_provisioner')
  and not has_schema_privilege('renave_profile_provisioner','renave','USAGE')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and (select count(*)=10 and bool_and(
        role_owner.rolname='renave_migrator' and function_item.prosecdef
        and function_item.prokind='f' and language_item.lanname='plpgsql'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and (function_item.proname||'('||oidvectortypes(function_item.proargtypes)||')')=any(array[
          'assert_profile_provisioner()','assert_profile_reader()',
          'stage_operator_pending(uuid, text, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'stage_establishment_pending(uuid, uuid, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'suspend_operator(uuid, text, bigint, bytea, text, bytea, text, bytea, text)',
          'suspend_establishment(uuid, uuid, bigint, bytea, text, bytea, text, bytea, text)',
          'get_operator_status(uuid, text)','get_establishment_status(uuid, uuid)',
          'transition_establishment_regulatory_jurisdiction(uuid, text, text, timestamp with time zone, timestamp with time zone, bytea, bytea, bytea)',
          'transition_credential_service_scope(uuid, text, text, text, timestamp with time zone, timestamp with time zone, bytea, bytea, bytea)'])
        and (select count(*)=case
              when function_item.proname in
                ('assert_profile_provisioner','assert_profile_reader') then 1
              else 2 end
             and bool_and(privilege.grantor=function_item.proowner
               and privilege.privilege_type='EXECUTE'
               and not privilege.is_grantable
               and (privilege.grantee=function_item.proowner
                 or (function_item.proname like 'transition_%'
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_credential_scope_provisioner'))
                 or (function_item.proname in
                   ('stage_operator_pending','stage_establishment_pending',
                    'suspend_operator','suspend_establishment')
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_profile_provisioner'))
                 or (function_item.proname in
                   ('get_operator_status','get_establishment_status')
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_profile_reader'))))
            from aclexplode(function_item.proacl) privilege)
      ) from pg_proc function_item
        join pg_namespace function_schema
          on function_schema.oid=function_item.pronamespace
        join pg_roles role_owner on role_owner.oid=function_item.proowner
        join pg_language language_item on language_item.oid=function_item.prolang
      where function_schema.nspname='renave_admin')
  and (select count(*)=1 and bool_and(
        privilege.grantor=default_acl.defaclrole
        and privilege.grantee=default_acl.defaclrole
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable)
      from pg_default_acl default_acl
        join pg_roles default_owner on default_owner.oid=default_acl.defaclrole
        cross join lateral aclexplode(default_acl.defaclacl) privilege
      where default_owner.rolname='renave_migrator'
        and default_acl.defaclobjtype='f' and default_acl.defaclnamespace=0)
  and not exists (select 1 from pg_default_acl default_acl
      join pg_roles default_owner on default_owner.oid=default_acl.defaclrole
      left join pg_namespace default_schema
        on default_schema.oid=default_acl.defaclnamespace
      cross join lateral aclexplode(default_acl.defaclacl) privilege
    where default_owner.rolname='renave_migrator'
      and default_acl.defaclobjtype='f'
      and (default_acl.defaclnamespace=0
        or default_schema.nspname='renave_admin')
      and not (privilege.grantor=default_acl.defaclrole
        and privilege.grantee=default_acl.defaclrole
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable))
  and (select count(*)=3 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_app'),
          (select oid from pg_roles where rolname='renave_identity_app')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.api_contract_ready()'))
  and (select count(*)=2 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_operation_worker')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure(
        'renave_runtime.operation_worker_contract_ready()'))
$$;
revoke all on function
  renave_runtime.profile_administration_contract_ready_v0058()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function renave_runtime.profile_reader_catalog_fingerprint_v0060()
  rename to profile_reader_catalog_fingerprint_without_credential_scope;
revoke all on function
  renave_runtime.profile_reader_catalog_fingerprint_without_credential_scope()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.profile_reader_catalog_fingerprint_v0060()
returns text language sql stable security definer set search_path=pg_catalog
as $$ select case when
  renave_runtime.profile_reader_catalog_fingerprint_without_credential_scope()=
    '0045a6c729ffb9d5a1d2d3437c10ffb731451565323a7b34d581e5e848cbdb30'
  then 'e1e98938b80524248f8e557477c00adb59bea11678b8402e6c25e4f26ccca211'
  else 'credential-service-scope-profile-reader-drift' end $$;
revoke all on function renave_runtime.profile_reader_catalog_fingerprint_v0060()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create or replace function renave_runtime.profile_reader_contract_ready_v0060()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  renave_runtime.profile_administration_contract_ready_v0058()
  and (select checksum='45d25c9b3bacc1e89feb20b450a84f942c59e05e2e1afed9ff84c62aecac949b'
    from renave.schema_migrations where version='0059_renave_profile_reader')
  and renave_runtime.profile_reader_catalog_fingerprint_v0060()=
    'e1e98938b80524248f8e557477c00adb59bea11678b8402e6c25e4f26ccca211'
  and (select count(*)=2 and bool_and(not rolsuper and not rolinherit
      and not rolcreaterole and not rolcreatedb and rolcanlogin
      and not rolreplication and not rolbypassrls) from pg_roles
    where rolname in ('renave_profile_provisioner','renave_profile_reader'))
  and not exists (select 1 from pg_auth_members membership
    where membership.member in (select oid from pg_roles where rolname in
      ('renave_profile_provisioner','renave_profile_reader'))
       or membership.roleid in (select oid from pg_roles where rolname in
      ('renave_profile_provisioner','renave_profile_reader')))
  and has_database_privilege('renave_profile_provisioner',current_database(),'CONNECT')
  and not has_database_privilege('renave_profile_provisioner',current_database(),'CREATE,TEMPORARY')
  and has_database_privilege('renave_profile_reader',current_database(),'CONNECT')
  and not has_database_privilege('renave_profile_reader',current_database(),'CREATE,TEMPORARY')
  and has_schema_privilege('renave_profile_provisioner','renave_admin','USAGE')
  and not has_schema_privilege('renave_profile_provisioner','renave_admin','CREATE')
  and has_schema_privilege('renave_profile_reader','renave_admin','USAGE')
  and not has_schema_privilege('renave_profile_reader','renave_admin','CREATE')
  and not has_schema_privilege('renave_profile_provisioner','renave','USAGE')
  and not has_schema_privilege('renave_profile_reader','renave','USAGE')
  and not has_table_privilege('renave_profile_reader',
    'renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_reader',
    'renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_reader',
    'renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
$$;
revoke all on function renave_runtime.profile_reader_contract_ready_v0060()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
  rename to vehicle_lookup_catalog_fingerprint_without_credential_scope;
revoke all on function
  renave_runtime.vehicle_lookup_catalog_fingerprint_without_credential_scope()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
returns text language sql stable security definer set search_path=pg_catalog
as $$ select case when
  renave_runtime.vehicle_lookup_catalog_fingerprint_without_credential_scope()=
    '7720cb34561d3480f4c0119c498741155e454c800ea2b387c9c8e740384fb2bd'
  then '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
  else 'credential-service-scope-vehicle-catalog-drift' end $$;
revoke all on function renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function renave_runtime.platform_console_catalog_fingerprint_v0064()
  rename to platform_console_catalog_fingerprint_without_credential_scope;
revoke all on function
  renave_runtime.platform_console_catalog_fingerprint_without_credential_scope()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.platform_console_catalog_fingerprint_v0064()
returns text language sql stable security definer set search_path=pg_catalog
as $$ select case when
  renave_runtime.platform_console_catalog_fingerprint_without_credential_scope()=
    '939f46561de11d2a1038cc6929729d26d8175c37cab4cd1cbcceeb68ec4f8a90'
  then 'a5c46b031ea30cd7671348eff6243f74491c33d19bdc053a79c1b987cba39012'
  else 'credential-service-scope-platform-catalog-drift' end $$;
revoke all on function renave_runtime.platform_console_catalog_fingerprint_v0064()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()
  rename to identity_recent_mfa_catalog_fingerprint_without_credential_scope;
revoke all on function
  renave_runtime.identity_recent_mfa_catalog_fingerprint_without_credential_scope()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()
returns text language sql stable security definer set search_path=pg_catalog
as $$ select case when
  renave_runtime.identity_recent_mfa_catalog_fingerprint_without_credential_scope()=
    '61e3bf448e9b6952fca1481caab6267b48530787c585517f00c7bbeffe4e7f75'
  then '5fb9ec168abf86dfb5ae23478309808242244b5070ce46c981a76ba84c9b3f09'
  else 'credential-service-scope-identity-mfa-drift' end $$;
revoke all on function renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- A árvore estrutural 0070 é deliberadamente não pronta até a âncora 0071.
alter function renave_runtime.api_contract_ready()
  rename to credential_service_scope_previous_contract_v0069;
revoke all on function
  renave_runtime.credential_service_scope_previous_contract_v0069()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select false $$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;
create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
