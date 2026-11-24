-- 0065 — Probe de runtime isolada para o leitor do console global.

create function renave_runtime.platform_reader_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
select
  session_user = 'renave_platform_reader'
  and current_user = 'renave_migrator'
  and renave_runtime.api_contract_ready()
  and exists (
    select 1
      from pg_proc function_item
      join pg_namespace namespace
        on namespace.oid = function_item.pronamespace
      cross join lateral aclexplode(
        coalesce(function_item.proacl, acldefault('f', function_item.proowner))
      ) privilege
      join pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'renave_runtime'
       and function_item.proname = 'platform_reader_contract_ready'
       and pg_get_function_identity_arguments(function_item.oid) = ''
       and privilege.privilege_type = 'EXECUTE'
       and grantee.rolname = 'renave_platform_reader'
       and not privilege.is_grantable
  )
  and not exists (
    select 1
      from pg_proc function_item
      join pg_namespace namespace
        on namespace.oid = function_item.pronamespace
      cross join lateral aclexplode(
        coalesce(function_item.proacl, acldefault('f', function_item.proowner))
      ) privilege
     where namespace.nspname = 'renave_runtime'
       and function_item.proname = 'platform_reader_contract_ready'
       and pg_get_function_identity_arguments(function_item.oid) = ''
       and privilege.privilege_type = 'EXECUTE'
       and privilege.grantee not in (
         function_item.proowner,
         (select oid from pg_roles where rolname = 'renave_platform_reader')
       )
  )
$$;

revoke all on function renave_runtime.platform_reader_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
  renave_operation_worker, renave_profile_provisioner, renave_profile_reader,
  renave_platform_reader, renave_platform_provisioner;

grant usage on schema renave_runtime to renave_platform_reader;
grant execute on function renave_runtime.platform_reader_contract_ready()
to renave_platform_reader;
