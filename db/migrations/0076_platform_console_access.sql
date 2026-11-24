-- 0076 — Capability mínima e fail-closed do console global.
--
-- A função não expõe o grant, sua validade ou qualquer dado do operador. Ela
-- responde apenas se o digest possui autorização ativa no instante da chamada.

alter function renave_runtime.api_contract_ready()
  rename to platform_console_access_previous_contract_v0075;
revoke all on function
  renave_runtime.platform_console_access_previous_contract_v0075()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_platform.is_platform_operator_authorized(
  p_actor_digest bytea
)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog as $$
declare grant_active boolean;
begin
  perform renave_platform.assert_reader();
  if p_actor_digest is null or octet_length(p_actor_digest)<>32 then
    raise exception 'platform access: entrada inválida'
      using errcode='invalid_parameter_value';
  end if;
  select exists(
    select 1 from renave_platform.operator_grant grant_item
    where grant_item.actor_digest=p_actor_digest
      and grant_item.role='integrator_link_reviewer'
      and grant_item.status='active'
      and grant_item.valid_from<=clock_timestamp()
      and grant_item.expires_at>clock_timestamp()
  ) into grant_active;
  return grant_active;
end
$$;
revoke all on function
  renave_platform.is_platform_operator_authorized(bytea)
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function
  renave_platform.is_platform_operator_authorized(bytea)
to renave_platform_reader;

-- O fingerprint histórico inclui todas as funções de renave_platform. A nova
-- função é incorporada explicitamente e o valor público anterior é preservado
-- para que toda a cadeia antiga continue verificável.
create or replace function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_sc()=
    '00f159c879f455c5f626b9a7da63943ed07f5f104389dd5d482618900f8ceff6'
then '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
else 'platform-console-access-tenant-catalog-drift' end$$;

create or replace function
  renave_runtime.profile_administration_catalog_fingerprint_v0058()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.profile_administration_catalog_fingerprint_without_credential_s()=
    'fc6a3f4c441e328c539a2c854dfbb1c7c752500f08ecdca49ef41f53eb2edce7'
then '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
else 'platform-console-access-profile-catalog-drift' end$$;

create or replace function
  renave_runtime.profile_reader_catalog_fingerprint_v0060()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.profile_reader_catalog_fingerprint_without_credential_scope()=
    '0045a6c729ffb9d5a1d2d3437c10ffb731451565323a7b34d581e5e848cbdb30'
then 'e1e98938b80524248f8e557477c00adb59bea11678b8402e6c25e4f26ccca211'
else 'platform-console-access-profile-reader-drift' end$$;

create or replace function
  renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.vehicle_lookup_catalog_fingerprint_without_credential_scope()=
    'cc8807c497034a63735afa8417dfb635dde2f1bb0135de0798c73351a55c7a33'
then '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
else 'platform-console-access-vehicle-catalog-drift' end$$;

create or replace function
  renave_runtime.platform_console_catalog_fingerprint_v0064()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.platform_console_catalog_fingerprint_without_credential_scope()=
    '7a1effcccec12ad804f5266aae4cf5c36f7e9ea9a73dc0e886831ea0a0d4f1be'
then 'a5c46b031ea30cd7671348eff6243f74491c33d19bdc053a79c1b987cba39012'
else 'platform-console-access-catalog-drift' end$$;
revoke all on function
  renave_runtime.platform_console_catalog_fingerprint_v0064()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

revoke all on function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048(),
  renave_runtime.profile_administration_catalog_fingerprint_v0058(),
  renave_runtime.profile_reader_catalog_fingerprint_v0060(),
  renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- O contrato 0075 fixa o corpo da âncora v0048. A âncora mudou de corpo, mas
-- continua devolvendo o mesmo fingerprint histórico depois de incorporar a
-- nova função ao catálogo. A substituição é recusada se a origem não for
-- exatamente a esperada ou se a referência aparecer quantidade inesperada.
do $$
declare
  contract_source text;
  expected_old_hash constant text :=
    'cba6e1724c16c6f081f34348309fd598bc0f12c298c0dcbdfc448141b2b86af0';
  expected_new_hash constant text :=
    '93b996786a597597a724dc5b7af71b862906cd123ee558633a1812537d81d4b7';
begin
  select function_item.prosrc into strict contract_source
  from pg_proc function_item join pg_namespace namespace
    on namespace.oid=function_item.pronamespace
  where namespace.nspname='renave_runtime'
    and function_item.proname=
      'signed_operation_promotion_catalog_fingerprint_v0075'
    and function_item.pronargs=0;
  if encode(sha256(convert_to(contract_source,'UTF8')),'hex')<>
      '77be09b0b77ce3b91db280850dc0cd3b85c1009284bcc88c97ccf0ac7abb2d3c'
    or (length(contract_source)-length(replace(
      contract_source,expected_old_hash,'')))/length(expected_old_hash)<>1 then
    raise exception 'platform access: contrato histórico inesperado';
  end if;
  contract_source:=replace(
    contract_source,expected_old_hash,expected_new_hash);
  execute format(
    'create or replace function '
    'renave_runtime.signed_operation_promotion_catalog_fingerprint_v0075() '
    'returns boolean language sql stable security definer '
    'set search_path=pg_catalog as %L',contract_source);
end
$$;
revoke all on function
  renave_runtime.signed_operation_promotion_catalog_fingerprint_v0075()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- A árvore permanece deliberadamente fechada até a âncora 0077 validar corpo,
-- owner e ACL da nova função e reancorar o catálogo histórico da plataforma.
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

create or replace function renave_runtime.operation_promoter_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_promoter_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_promoter_contract_ready()
to renave_operation_promoter;
