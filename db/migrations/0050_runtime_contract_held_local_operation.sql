-- 0050 — Contrato de runtime após a fundação de operação local retida.
-- O snapshot v0048 calcula o catálogo corrente; esta função versionada o
-- ancora ao checksum da 0049 e às ACLs esperadas dos runtimes.

alter function renave_runtime.api_contract_ready()
  rename to tenant_administration_contract_ready_v0048;
revoke all on function
  renave_runtime.tenant_administration_contract_ready_v0048()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.held_local_operation_catalog_fingerprint_v0050()
returns text language sql stable security definer set search_path = pg_catalog
as $$
  select renave_runtime.tenant_administration_catalog_fingerprint_v0048()
$$;

revoke all on function
  renave_runtime.held_local_operation_catalog_fingerprint_v0050()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
  select
    (select migrations.checksum =
       '531c8cb74fdc690a5e91646b7fe97a63c4299927dff3e025b1e62bd8039b3ae8'
       from renave.schema_migrations migrations
      where migrations.version = '0049_held_local_operation')
    and renave_runtime.held_local_operation_catalog_fingerprint_v0050() =
      'cd93aff2903ad400caab6011cb949da90e9518ca8bd996b915b5372615937a46'
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
