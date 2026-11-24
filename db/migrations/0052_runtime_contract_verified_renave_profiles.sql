-- 0052 — Contrato de runtime após os perfis cifrados RENAVE.

alter function renave_runtime.api_contract_ready()
  rename to held_local_operation_contract_ready_v0050;
revoke all on function
  renave_runtime.held_local_operation_contract_ready_v0050()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.renave_profiles_catalog_fingerprint_v0052()
returns text language sql stable security definer set search_path = pg_catalog
as $$
  select renave_runtime.tenant_administration_catalog_fingerprint_v0048()
$$;

revoke all on function
  renave_runtime.renave_profiles_catalog_fingerprint_v0052()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
  select
    (select migrations.checksum =
       '0e305b1d30e1526dd019a295bb7dc56687e6ff8b0ed8444c05a383e98ce0549f'
       from renave.schema_migrations migrations
      where migrations.version = '0051_verified_renave_profiles')
    and renave_runtime.renave_profiles_catalog_fingerprint_v0052() =
      '624861c59620034c0579954ca93b3da5fa35e1798fc87ad131be017e4c445835'
    and (select pg_catalog.count(*) = 2
           and pg_catalog.bool_and(
             privilege.grantor = contract.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               contract.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_operation_worker')
             )
           )
          from pg_catalog.pg_proc contract
          cross join lateral pg_catalog.aclexplode(contract.proacl) privilege
         where contract.oid = pg_catalog.to_regprocedure(
           'renave_runtime.operation_worker_contract_ready()'
         ))
    and (select pg_catalog.count(*) = 3
           and pg_catalog.bool_and(
             privilege.grantor = contract.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               contract.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_app'),
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_identity_app')
             )
           )
          from pg_catalog.pg_proc contract
          cross join lateral pg_catalog.aclexplode(contract.proacl) privilege
         where contract.oid = pg_catalog.to_regprocedure(
           'renave_runtime.api_contract_ready()'
         ))
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
