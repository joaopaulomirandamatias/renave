-- 0067 — Contrato fechado do issuer persistido e da prova MFA recente.

alter function renave_runtime.api_contract_ready()
  rename to platform_reader_probe_contract_ready_v0065;
revoke all on function
  renave_runtime.platform_reader_probe_contract_ready_v0065()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()
returns text language sql stable security definer set search_path=pg_catalog as $$
select encode(sha256(convert_to(jsonb_build_object(
  'previous',renave_runtime.platform_console_catalog_fingerprint_v0064(),
  'ledger',coalesce((select jsonb_agg(jsonb_build_array(
      migration.version,migration.checksum) order by migration.version)
    from renave.schema_migrations migration
    where migration.version in (
      '0065_platform_reader_runtime_probe',
      '0066_identity_issuer_recent_mfa'
    )),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(
      column_item.column_name,column_item.data_type,column_item.is_nullable,
      coalesce(column_item.column_default,'')) order by column_item.column_name)
    from information_schema.columns column_item
    where column_item.table_schema='renave_identity'
      and column_item.table_name='auth_session'
      and column_item.column_name in ('issuer','mfa_authenticated_at_ms')),
    '[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(
      constraint_item.conname,constraint_item.contype,
      constraint_item.convalidated,
      pg_get_constraintdef(constraint_item.oid,false))
      order by constraint_item.conname)
    from pg_constraint constraint_item
    where constraint_item.conrelid='renave_identity.auth_session'::regclass
      and constraint_item.conname in (
        'auth_session_issuer_valid',
        'auth_session_mfa_authenticated_at_valid'
      )),'[]'::jsonb),
  'identity_functions',coalesce((select jsonb_agg(jsonb_build_array(
      function_item.proname,
      pg_get_function_identity_arguments(function_item.oid),
      pg_get_function_result(function_item.oid),function_item.prosecdef,
      function_item.provolatile,language_item.lanname,owner.rolname,
      coalesce(function_item.proconfig::text,''),
      coalesce(function_item.proacl::text,''),
      encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex'))
      order by function_item.proname)
    from pg_proc function_item
      join pg_namespace namespace_item
        on namespace_item.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
      join pg_language language_item
        on language_item.oid=function_item.prolang
    where namespace_item.nspname='renave_identity'
      and function_item.proname in ('save_auth_session','get_auth_session')),
    '[]'::jsonb),
  'reader_probe',coalesce((select jsonb_agg(jsonb_build_array(
      function_item.proname,
      pg_get_function_identity_arguments(function_item.oid),
      pg_get_function_result(function_item.oid),function_item.prosecdef,
      function_item.provolatile,language_item.lanname,owner.rolname,
      coalesce(function_item.proconfig::text,''),
      coalesce(function_item.proacl::text,''),
      encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')))
    from pg_proc function_item
      join pg_namespace namespace_item
        on namespace_item.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
      join pg_language language_item
        on language_item.oid=function_item.prolang
    where namespace_item.nspname='renave_runtime'
      and function_item.proname='platform_reader_contract_ready'),
    '[]'::jsonb)
)::text,'UTF8')),'hex')
$$;
revoke all on function
  renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum=
      'ce6458f8de9abce9878182aa8c9d18e28b572fd5e87dd12f67f19ac0ee1cbb1d'
    from renave.schema_migrations
    where version='0065_platform_reader_runtime_probe')
  and (select checksum=
      '9828fe01caa84e0673dae4359c2c7425f026740aacbc507ed61cbd29e266c1dc'
    from renave.schema_migrations
    where version='0066_identity_issuer_recent_mfa')
  and renave_runtime.identity_recent_mfa_catalog_fingerprint_v0067()=
    '5fb9ec168abf86dfb5ae23478309808242244b5070ce46c981a76ba84c9b3f09'
  and (select count(*)=2 and bool_and(
      not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb
      and rolcanlogin and not rolreplication and not rolbypassrls)
    from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner'))
  and has_database_privilege(
    'renave_platform_reader',current_database(),'CONNECT')
  and not has_database_privilege(
    'renave_platform_reader',current_database(),'CREATE')
  and not has_database_privilege(
    'renave_platform_reader',current_database(),'TEMPORARY')
  and has_database_privilege(
    'renave_platform_provisioner',current_database(),'CONNECT')
  and not has_database_privilege(
    'renave_platform_provisioner',current_database(),'CREATE')
  and not has_database_privilege(
    'renave_platform_provisioner',current_database(),'TEMPORARY')
  and not exists (select 1 from pg_auth_members m where m.member in
    (select oid from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner'))
    or m.roleid in (select oid from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner')))
  and has_schema_privilege(
    'renave_platform_reader','renave_platform','USAGE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_platform','CREATE')
  and has_schema_privilege(
    'renave_platform_provisioner','renave_platform','USAGE')
  and not has_schema_privilege(
    'renave_platform_provisioner','renave_platform','CREATE')
  and not has_schema_privilege('renave_platform_reader','renave','USAGE')
  and not has_schema_privilege('renave_platform_provisioner','renave','USAGE')
  and not exists (
    select 1 from information_schema.table_privileges privilege
    where privilege.grantee in
      ('renave_platform_reader','renave_platform_provisioner')
  )
  and has_function_privilege('renave_platform_reader',
    'renave_platform.list_credential_link_queue(bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_platform_reader',
    'renave_platform.grant_operator(bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_reader',
    'renave_platform.revoke_operator(bytea,bytea,bytea,inet,bytea)','EXECUTE')
  and has_function_privilege('renave_platform_provisioner',
    'renave_platform.grant_operator(bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)','EXECUTE')
  and has_function_privilege('renave_platform_provisioner',
    'renave_platform.revoke_operator(bytea,bytea,bytea,inet,bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_provisioner',
    'renave_platform.list_credential_link_queue(bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)','EXECUTE')
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
