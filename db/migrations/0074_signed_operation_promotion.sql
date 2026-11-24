-- 0074 — Decisão assinada e vinculada para promoção operacional one-shot.
-- A credencial do promotor continua sendo uma autoridade de workload; o
-- artefato assinado nunca substitui o isolamento do Job e do seu DSN.

create schema renave_promotion authorization renave_migrator;
revoke all on schema renave_promotion from public;
grant usage on schema renave_promotion to renave_operation_promoter;
revoke create on schema renave_promotion from renave_operation_promoter;

create table renave_promotion.operation_promotion_identity (
  singleton boolean primary key default true check(singleton),
  environment text not null check(environment in('homologation','production')),
  logical_database_id uuid not null unique,
  configured_at timestamptz not null default pg_catalog.clock_timestamp());
revoke all on table renave_promotion.operation_promotion_identity from public;

create function renave_promotion.configure_operation_promotion_identity(
  p_environment text,p_logical_database_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
  if session_user<>'renave_migrator' or p_environment not in('homologation','production')
    or p_logical_database_id is null then
    raise exception 'operation promotion identity: indisponível'
      using errcode='insufficient_privilege';
  end if;
  insert into renave_promotion.operation_promotion_identity(
    singleton,environment,logical_database_id)
  values(true,p_environment,p_logical_database_id);
exception when unique_violation then
  raise exception 'operation promotion identity: indisponível'
    using errcode='object_not_in_prerequisite_state';
end$$;
revoke all on function renave_promotion.configure_operation_promotion_identity(
  text,uuid) from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create table renave_promotion.operation_promotion_signed_artifact (
  tenant_id uuid not null,operation_id uuid not null,outbox_id uuid not null,
  decision_id uuid not null,artifact_digest bytea not null,
  authorization_binding_digest bytea not null,
  executor_workload_digest bytea not null,evidence_manifest_digest bytea not null,
  changed_by_digest bytea not null,issuer_key_id text not null,
  policy_version text not null,environment text not null,
  logical_database_id uuid not null,issued_at timestamptz not null,
  not_before timestamptz not null,expires_at timestamptz not null,
  registered_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(tenant_id,operation_id),unique(decision_id),unique(outbox_id),
  foreign key(tenant_id,operation_id)
    references renave.operation(tenant_id,id) on delete restrict,
  constraint operation_promotion_signed_artifact_digests_valid check(
    pg_catalog.octet_length(artifact_digest)=32
    and pg_catalog.octet_length(authorization_binding_digest)=32
    and pg_catalog.octet_length(executor_workload_digest)=32
    and pg_catalog.octet_length(evidence_manifest_digest)=32
    and pg_catalog.octet_length(changed_by_digest)=32),
  constraint operation_promotion_signed_artifact_text_valid check(
    issuer_key_id~'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and policy_version~'^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'
    and environment in('homologation','production')),
  constraint operation_promotion_signed_artifact_time_valid check(
    issued_at<=not_before and not_before<expires_at
    and expires_at<=issued_at+interval '24 hours'));
alter table renave_promotion.operation_promotion_signed_artifact enable row level security;
alter table renave_promotion.operation_promotion_signed_artifact force row level security;
revoke all on table renave_promotion.operation_promotion_signed_artifact
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create policy operation_promotion_signed_artifact_isolation
  on renave_promotion.operation_promotion_signed_artifact
  using(tenant_id=(select renave.current_tenant_id()))
  with check(tenant_id=(select renave.current_tenant_id()));
create trigger operation_promotion_signed_artifact_append_only
  before update or delete on renave_promotion.operation_promotion_signed_artifact
  for each row execute function renave.operation_promotion_decision_reject_change();
create trigger operation_promotion_signed_artifact_reject_truncate
  before truncate on renave_promotion.operation_promotion_signed_artifact
  for each statement execute function renave.operation_promotion_decision_reject_change();

-- A primitiva v0072 permanece ancorada para compatibilidade histórica. A sua
-- credencial é exclusiva do workload endurecido; operadores nunca recebem o
-- DSN. O caminho produtivo usa este wrapper e registra o artefato vinculado.
create function renave_promotion.promote_held_local_operation(
  p_operation_id uuid,p_environment text,p_logical_database_id uuid,
  p_decision_id uuid,p_issued_at timestamptz,p_not_before timestamptz,
  p_expires_at timestamptz,p_issuer_key_id text,p_policy_version text,
  p_authorization_binding_digest bytea,p_executor_workload_digest bytea,
  p_artifact_digest bytea,p_evidence_manifest_digest bytea,
  p_changed_by_digest bytea,p_service_nature text,p_jurisdiction_uf text,
  p_jurisdiction_generation bigint,p_scope_generation bigint,
  p_credential_link_version bigint,p_operator_profile_id uuid,
  p_operator_profile_version bigint,p_establishment_profile_id uuid,
  p_establishment_profile_version bigint)
returns table(operation_id uuid,operation_status text,replayed boolean,
  outbox_id uuid,promoted_at timestamptz)
language plpgsql security definer set search_path=pg_catalog as $$
declare active_tenant uuid:=renave.current_tenant_id();
  target_establishment_id uuid; operator_subject text; auth_now timestamptz;
  binding renave.operation_authorization_binding; operation_item renave.operation;
  identity_item renave_promotion.operation_promotion_identity;
  artifact renave_promotion.operation_promotion_signed_artifact; promoted record;
begin
  if session_user<>'renave_operation_promoter' or active_tenant is null
    or p_operation_id is null or p_decision_id is null
    or p_environment not in('homologation','production')
    or p_logical_database_id is null or p_issued_at is null
    or p_not_before is null or p_expires_at is null
    or p_issued_at>p_not_before or p_not_before>=p_expires_at
    or p_expires_at>p_issued_at+interval '24 hours'
    or p_issuer_key_id!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_policy_version!~'^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'
    or pg_catalog.octet_length(p_authorization_binding_digest)<>32
    or pg_catalog.octet_length(p_executor_workload_digest)<>32
    or pg_catalog.octet_length(p_artifact_digest)<>32
    or pg_catalog.octet_length(p_evidence_manifest_digest)<>32
    or pg_catalog.octet_length(p_changed_by_digest)<>32 then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state';
  end if;
  select i.* into identity_item
    from renave_promotion.operation_promotion_identity i where i.singleton=true;
  if not found or identity_item.environment<>p_environment
    or identity_item.logical_database_id<>p_logical_database_id then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state';
  end if;
  select o.establishment_id into target_establishment_id from renave.operation o
    where o.tenant_id=active_tenant and o.id=p_operation_id;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=p_operation_id;
  if target_establishment_id is null or not found then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text,700069));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text||':'||
      binding.service_nature||':'||binding.jurisdiction_uf,700070));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    active_tenant::text||':'||target_establishment_id::text,170017));
  select o.* into operation_item from renave.operation o
    where o.tenant_id=active_tenant and o.id=p_operation_id for update;
  select b.* into binding from renave.operation_authorization_binding b
    where b.tenant_id=active_tenant and b.operation_id=p_operation_id for share;
  perform 1 from renave.tenant t where t.id=active_tenant
    and t.status='active' for share;
  perform 1 from renave.establishment e where e.tenant_id=active_tenant
    and e.id=target_establishment_id and e.status='active' for share;
  perform 1 from renave.establishment_regulatory_jurisdiction x
    where x.tenant_id=active_tenant
      and x.establishment_id=target_establishment_id for share;
  perform 1 from renave.credential_service_scope x
    where x.tenant_id=active_tenant
      and x.establishment_id=target_establishment_id for share;
  perform 1 from renave.credential_link x where x.tenant_id=active_tenant
    and x.establishment_id=target_establishment_id for share;
  select x.subject into operator_subject from renave.operator_identity_profile x
    where x.tenant_id=active_tenant and x.id=binding.operator_profile_id
    for share;
  perform 1 from renave.tenant_user u where u.tenant_id=active_tenant
    and u.status='active' and u.subject=operator_subject for share;
  perform 1 from renave.tenant_role_grant g where g.tenant_id=active_tenant
    and g.role='renave_operator' and g.subject=operator_subject for share;
  perform 1 from renave.establishment_role_scope r
    where r.tenant_id=active_tenant and r.role='renave_operator'
      and r.establishment_id=target_establishment_id
      and r.subject=operator_subject for share;
  perform 1 from renave.establishment_renave_profile x
    where x.tenant_id=active_tenant
      and x.id=binding.establishment_profile_id for share;
  auth_now:=pg_catalog.clock_timestamp();
  if operation_item.id is null or binding.operation_id is null
    or operation_item.establishment_id<>target_establishment_id
    or operation_item.status not in('HELD_LOCAL','PENDING_SEND')
    or auth_now<p_not_before or auth_now>=p_expires_at
    or binding.service_nature<>p_service_nature
    or binding.jurisdiction_uf<>p_jurisdiction_uf
    or binding.jurisdiction_generation<>p_jurisdiction_generation
    or binding.scope_generation<>p_scope_generation
    or binding.credential_link_version<>p_credential_link_version
    or binding.operator_profile_id<>p_operator_profile_id
    or binding.operator_profile_version<>p_operator_profile_version
    or binding.establishment_profile_id<>p_establishment_profile_id
    or binding.establishment_profile_version<>p_establishment_profile_version then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state';
  end if;
  if operation_item.status='PENDING_SEND' then
    select a.* into artifact from renave_promotion.operation_promotion_signed_artifact a
      where a.tenant_id=active_tenant and a.operation_id=p_operation_id for share;
    if not found or artifact.decision_id<>p_decision_id
      or artifact.artifact_digest<>p_artifact_digest
      or artifact.authorization_binding_digest<>p_authorization_binding_digest
      or artifact.executor_workload_digest<>p_executor_workload_digest
      or artifact.evidence_manifest_digest<>p_evidence_manifest_digest
      or artifact.changed_by_digest<>p_changed_by_digest
      or artifact.issuer_key_id<>p_issuer_key_id
      or artifact.policy_version<>p_policy_version
      or artifact.environment<>p_environment
      or artifact.logical_database_id<>p_logical_database_id
      or artifact.issued_at<>p_issued_at or artifact.not_before<>p_not_before
      or artifact.expires_at<>p_expires_at then
      raise exception 'operation promotion: indisponível'
        using errcode='object_not_in_prerequisite_state';
    end if;
  end if;
  select * into promoted from renave_admin.promote_held_local_operation(
    p_operation_id,p_artifact_digest,p_evidence_manifest_digest,
    p_changed_by_digest);
  if promoted.operation_id is null then
    raise exception 'operation promotion: indisponível'
      using errcode='object_not_in_prerequisite_state';
  end if;
  if not promoted.replayed then
    insert into renave_promotion.operation_promotion_signed_artifact(
      tenant_id,operation_id,outbox_id,decision_id,artifact_digest,
      authorization_binding_digest,executor_workload_digest,
      evidence_manifest_digest,changed_by_digest,issuer_key_id,policy_version,
      environment,logical_database_id,issued_at,not_before,expires_at,
      registered_at) values(active_tenant,p_operation_id,promoted.outbox_id,
      p_decision_id,p_artifact_digest,p_authorization_binding_digest,
      p_executor_workload_digest,p_evidence_manifest_digest,p_changed_by_digest,
      p_issuer_key_id,p_policy_version,p_environment,p_logical_database_id,
      p_issued_at,p_not_before,p_expires_at,auth_now);
  end if;
  return query select promoted.operation_id,promoted.operation_status,
    promoted.replayed,promoted.outbox_id,promoted.promoted_at;
end$$;

revoke all on function renave_promotion.promote_held_local_operation(
  uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,
  bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_promotion.promote_held_local_operation(
  uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,
  bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)
to renave_operation_promoter;

-- As novas relações vivem em schema isolado, mas os fingerprints históricos
-- medem o catálogo global. Reancoramos apenas os três agregadores afetados e
-- preservamos os valores públicos que os contratos anteriores esperam.
create or replace function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_sc()=
    '6567ffb1901bca9561c4410783162a0a754917fae1a54fbc1330a59b74410d13'
then '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
else 'signed-operation-promotion-tenant-catalog-drift' end$$;

create or replace function
  renave_runtime.profile_administration_catalog_fingerprint_v0058()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.profile_administration_catalog_fingerprint_without_credential_s()=
    'fc6a3f4c441e328c539a2c854dfbb1c7c752500f08ecdca49ef41f53eb2edce7'
then '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
else 'signed-operation-promotion-profile-catalog-drift' end$$;

create or replace function
  renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.vehicle_lookup_catalog_fingerprint_without_credential_scope()=
    'cc8807c497034a63735afa8417dfb635dde2f1bb0135de0798c73351a55c7a33'
then '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
else 'signed-operation-promotion-vehicle-catalog-drift' end$$;

alter function renave_runtime.api_contract_ready()
  rename to signed_operation_promotion_previous_contract_v0073;
revoke all on function
  renave_runtime.signed_operation_promotion_previous_contract_v0073()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select false$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;
create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
