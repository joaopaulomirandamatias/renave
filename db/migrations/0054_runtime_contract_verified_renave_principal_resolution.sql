-- 0054 — Contrato de runtime após o resolvedor transacional de perfis.

alter function renave_runtime.api_contract_ready()
  rename to renave_profiles_contract_ready_v0052;
revoke all on function renave_runtime.renave_profiles_contract_ready_v0052()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function
  renave_runtime.renave_principal_resolution_catalog_fingerprint_v0054()
returns text language sql stable security definer set search_path = pg_catalog
as $$
  select renave_runtime.tenant_administration_catalog_fingerprint_v0048()
$$;

revoke all on function
  renave_runtime.renave_principal_resolution_catalog_fingerprint_v0054()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
  select
    (select migrations.checksum =
       '0b85d8e3e0956de568b5caed308bb6527d271e3ed2be40862b50d373d382a48d'
       from renave.schema_migrations migrations
      where migrations.version =
        '0053_verified_renave_principal_resolution')
    and renave_runtime
      .renave_principal_resolution_catalog_fingerprint_v0054() =
      'e53b298067c554263f57bd9e8cd3fb133bf9924b42035077a6eae83e3dcbcbe8'
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
