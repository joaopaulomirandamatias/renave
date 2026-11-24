-- 0062 — Contrato de runtime da consulta veicular e sua evidência protegida.

alter function renave_runtime.api_contract_ready()
  rename to profile_reader_contract_ready_v0060;
revoke all on function renave_runtime.profile_reader_contract_ready_v0060()
from public, renave_app, renave_identity_app, renave_maintenance_app,
  renave_operation_worker, renave_profile_provisioner, renave_profile_reader;

create function renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
returns text language sql stable security definer set search_path = pg_catalog
as $$
select encode(sha256(convert_to(jsonb_build_object(
  'previous', renave_runtime.profile_reader_catalog_fingerprint_v0060(),
  'ledger', coalesce((select jsonb_agg(jsonb_build_array(
      migration.version, migration.checksum) order by migration.version)
    from renave.schema_migrations migration
    where migration.version in (
      '0057_renave_profile_administration',
      '0059_renave_profile_reader',
      '0061_vehicle_lookup_evidence'
    )), '[]'::jsonb),
  'tables', coalesce((select jsonb_agg(jsonb_build_array(
      item.relname, item.relkind, item.relpersistence,
      item.relrowsecurity, item.relforcerowsecurity, owner.rolname,
      coalesce(item.relacl::text, '')) order by item.relname)
    from pg_class item
      join pg_namespace namespace_item on namespace_item.oid = item.relnamespace
      join pg_roles owner on owner.oid = item.relowner
    where namespace_item.nspname = 'renave'
      and item.relname in ('audit_event', 'protected_evidence')),
    '[]'::jsonb),
  'constraints', coalesce((select jsonb_agg(jsonb_build_array(
      table_item.relname, constraint_item.conname, constraint_item.contype,
      constraint_item.convalidated,
      pg_get_constraintdef(constraint_item.oid, false))
      order by table_item.relname, constraint_item.conname)
    from pg_constraint constraint_item
      join pg_class table_item on table_item.oid = constraint_item.conrelid
      join pg_namespace namespace_item
        on namespace_item.oid = table_item.relnamespace
    where namespace_item.nspname = 'renave'
      and table_item.relname in ('audit_event', 'protected_evidence')),
    '[]'::jsonb),
  'policies', coalesce((select jsonb_agg(jsonb_build_array(
      table_item.relname, policy_item.polname, policy_item.polcmd,
      policy_item.polpermissive, policy_item.polroles::text,
      pg_get_expr(policy_item.polqual, policy_item.polrelid, false),
      pg_get_expr(policy_item.polwithcheck, policy_item.polrelid, false))
      order by table_item.relname, policy_item.polname)
    from pg_policy policy_item
      join pg_class table_item on table_item.oid = policy_item.polrelid
      join pg_namespace namespace_item
        on namespace_item.oid = table_item.relnamespace
    where namespace_item.nspname = 'renave'
      and table_item.relname in ('audit_event', 'protected_evidence')),
    '[]'::jsonb),
  'app_column_privileges', coalesce((select jsonb_agg(jsonb_build_array(
      privilege.table_name, privilege.column_name, privilege.privilege_type,
      privilege.is_grantable) order by privilege.table_name,
      privilege.column_name, privilege.privilege_type)
    from information_schema.column_privileges privilege
    where privilege.grantee = 'renave_app'
      and privilege.table_schema = 'renave'
      and privilege.table_name in ('audit_event', 'protected_evidence')),
    '[]'::jsonb),
  'default_acl', coalesce((select jsonb_agg(jsonb_build_array(
      owner.rolname, coalesce(namespace_item.nspname, ''),
      default_acl.defaclobjtype, coalesce(default_acl.defaclacl::text, ''))
      order by owner.rolname, coalesce(namespace_item.nspname, ''),
      default_acl.defaclobjtype)
    from pg_default_acl default_acl
      join pg_roles owner on owner.oid = default_acl.defaclrole
      left join pg_namespace namespace_item
        on namespace_item.oid = default_acl.defaclnamespace
    where owner.rolname = 'renave_migrator'), '[]'::jsonb),
  'runtime_roles', coalesce((select jsonb_agg(jsonb_build_array(
      role_item.rolname, role_item.rolsuper, role_item.rolinherit,
      role_item.rolcreaterole, role_item.rolcreatedb, role_item.rolcanlogin,
      role_item.rolreplication, role_item.rolbypassrls,
      has_database_privilege(role_item.rolname, current_database(), 'CONNECT'),
      has_database_privilege(role_item.rolname, current_database(), 'CREATE'),
      has_database_privilege(role_item.rolname, current_database(), 'TEMPORARY'),
      coalesce(role_item.rolconfig::text, '')) order by role_item.rolname)
    from pg_roles role_item where role_item.rolname in (
      'renave_app', 'renave_identity_app', 'renave_maintenance_app',
      'renave_operation_worker', 'renave_profile_provisioner',
      'renave_profile_reader'
    )), '[]'::jsonb),
  'contract_functions', coalesce((select jsonb_agg(jsonb_build_array(
      function_item.proname, owner.rolname, function_item.prosecdef,
      function_item.provolatile, language_item.lanname,
      coalesce(function_item.proconfig::text, ''),
      coalesce(function_item.proacl::text, ''),
      case when function_item.proname = 'operation_worker_contract_ready'
        then encode(sha256(convert_to(function_item.prosrc, 'UTF8')), 'hex')
        else '' end) order by function_item.proname)
    from pg_proc function_item
      join pg_namespace namespace_item
        on namespace_item.oid = function_item.pronamespace
      join pg_roles owner on owner.oid = function_item.proowner
      join pg_language language_item on language_item.oid = function_item.prolang
    where namespace_item.nspname = 'renave_runtime'
      and function_item.proname in (
        'api_contract_ready', 'operation_worker_contract_ready'
      )), '[]'::jsonb)
)::text, 'UTF8')), 'hex')
$$;
revoke all on function
  renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
from public, renave_app, renave_identity_app, renave_maintenance_app,
  renave_operation_worker, renave_profile_provisioner, renave_profile_reader;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
select
  (select checksum =
      'f019a98b81572696b4f01a262479b097bb78f84713eb87836a246031dc9c4287'
    from renave.schema_migrations
    where version = '0061_vehicle_lookup_evidence')
  and renave_runtime.vehicle_lookup_catalog_fingerprint_v0062() =
    '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
$$;
revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
  renave_operation_worker, renave_profile_provisioner, renave_profile_reader;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
  renave_operation_worker, renave_profile_provisioner, renave_profile_reader;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
