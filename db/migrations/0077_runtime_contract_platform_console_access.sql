-- 0077 — Âncora executável da capability global do console.

drop function renave_runtime.api_contract_ready();

create function renave_runtime.platform_console_access_contract_ready_v0077()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum=
      'e0c79d452ca89dd0a19908c5247f76d9a53169bf6c5e2732fb7a1b6cbaaf871f'
    from renave.schema_migrations
    where version='0076_platform_console_access')
  and renave_runtime.platform_console_access_previous_contract_v0075()
  and (with expected(proname,body_hash) as(values
      ('tenant_administration_catalog_fingerprint_v0048',
        '93b996786a597597a724dc5b7af71b862906cd123ee558633a1812537d81d4b7'),
      ('profile_administration_catalog_fingerprint_v0058',
        'a38f4dc6da38ccf4ab16151b6afb9777732561ecb418b33e372413c7dcb65fb0'),
      ('profile_reader_catalog_fingerprint_v0060',
        '2177fd6e494496f398f745d965261026c1d5200989c010166845447394825c7c'),
      ('vehicle_lookup_catalog_fingerprint_v0062',
        'eacc08c5133e56f119af5a965b12563d610d1d3bc3c3c2b2bfcd73722f8876ea'),
      ('platform_console_catalog_fingerprint_v0064',
        '5d795fa4d62c65f1cf1146727d4cb72ea2a4cb283f90fbcbd5ddffc25a6f6d73'),
      ('signed_operation_promotion_catalog_fingerprint_v0075',
        '47f790fa23329509d15be54aaad1463b44ca05dedadfe490d892ff4b37360bc3'))
    select count(*)=6 and bool_and(owner.rolname='renave_migrator'
      and function_item.prosecdef and function_item.provolatile='s'
      and function_item.proconfig='{search_path=pg_catalog}'::text[]
      and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
      and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
        expected.body_hash)
    from expected join pg_proc function_item using(proname)
      join pg_namespace namespace on namespace.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
    where namespace.nspname='renave_runtime')
  and (select owner.rolname='renave_migrator'
        and function_item.prosecdef and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text=
          '{renave_migrator=X/renave_migrator,renave_platform_reader=X/renave_migrator}'
        and function_item.prorettype='boolean'::regtype
        and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
          '5b70d6947449b60d12aa34b8bffbe511b0164b83c3a2c101f2a8c635504a71cf'
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=
        'renave_platform.is_platform_operator_authorized(bytea)'::regprocedure)
  and has_schema_privilege(
    'renave_platform_reader','renave_platform','USAGE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_platform','CREATE')
  and has_function_privilege('renave_platform_reader',
    'renave_platform.is_platform_operator_authorized(bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_provisioner',
    'renave_platform.is_platform_operator_authorized(bytea)','EXECUTE')
  and not has_function_privilege('renave_app',
    'renave_platform.is_platform_operator_authorized(bytea)','EXECUTE')
  and not has_function_privilege('renave_identity_app',
    'renave_platform.is_platform_operator_authorized(bytea)','EXECUTE')
  and not exists (
    select 1 from information_schema.table_privileges privilege
    where privilege.grantee='renave_platform_reader')
$$;
revoke all on function
  renave_runtime.platform_console_access_contract_ready_v0077()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.platform_console_access_contract_ready_v0077()$$;
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
