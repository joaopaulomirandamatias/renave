-- 0032 — Contrato de runtime do recovery de SEND expirado, ainda owner-only.

alter function renave_runtime.api_contract_ready()
  rename to begin_dispatch_contract_ready_v0030;

revoke all on function
  renave_runtime.begin_dispatch_contract_ready_v0030()
from public, renave_app, renave_identity_app, renave_maintenance_app;

create function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected_ledger(version, checksum) as (
    values
      ('0030_runtime_contract_begin_dispatch', '9ca2eb5d552382b2725d93dada1da434fbd191e9fd5c2496d810a424714adfdb'),
      ('0031_operation_recover_expired_send', 'a2bf3cb442a371022b9a631bc5df938a80748fa4d8f6ebe566cd00a08a2f83f8')
  ),
  ledger_ready(ready) as (
    select pg_catalog.count(migrations.version) = 2
       and coalesce(
         pg_catalog.bool_and(migrations.checksum = expected_ledger.checksum),
         false
       )
      from expected_ledger
      left join renave.schema_migrations migrations
        on migrations.version = expected_ledger.version
  ),
  prior_contract_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 1
       and coalesce(
         pg_catalog.bool_and(
           functions.prosecdef
           and functions.provolatile = 's'
           and functions.prokind = 'f'
           and functions.proconfig = array['search_path=pg_catalog']::text[]
           and functions.probin is null
           and owners.rolname = 'renave_migrator'
           and languages.lanname = 'sql'
           and pg_catalog.pg_get_function_result(functions.oid) = 'boolean'
           and pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(functions.prosrc, 'UTF8')
             ),
             'hex'
           ) = '553729574913f86f2b1cd5f4a6cd380588698472f3540db7846ee91e5db2ed7b'
         ),
         false
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.begin_dispatch_contract_ready_v0030()'
     )
  ),
  prior_contract_privileges(ready) as (
    select pg_catalog.count(*) = 1
       and coalesce(
         pg_catalog.bool_and(
           privileges.grantee = functions.proowner
           and privileges.grantor = functions.proowner
           and privileges.privilege_type = 'EXECUTE'
           and not privileges.is_grantable
         ),
         false
       )
      from pg_catalog.pg_proc functions
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          functions.proacl,
          pg_catalog.acldefault('f', functions.proowner)
        )
      ) privileges
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.begin_dispatch_contract_ready_v0030()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.begin_dispatch_contract_ready_v0030()
  ),
  recovery_function_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 1
       and coalesce(
         pg_catalog.bool_and(
           functions.prosecdef
           and functions.provolatile = 'v'
           and functions.prokind = 'f'
           and functions.proretset
           and functions.proconfig = array['search_path=pg_catalog']::text[]
           and functions.probin is null
           and owners.rolname = 'renave_migrator'
           and languages.lanname = 'plpgsql'
           and pg_catalog.pg_get_function_result(functions.oid) =
             'TABLE(operation_id uuid, send_outbox_id uuid, reconcile_outbox_id uuid, operation_version bigint, recovered_at timestamp with time zone, reconcile_available_at timestamp with time zone)'
           and pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(functions.prosrc, 'UTF8')
             ),
             'hex'
           ) = 'ed93234364055d532fc156d64ac4aec212616fdee31e0407cbee445ed8ad909d'
         ),
         false
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave.recover_expired_operation_sends(integer)'
     )
  ),
  recovery_function_privileges(ready) as (
    select pg_catalog.count(*) = 1
       and coalesce(
         pg_catalog.bool_and(
           privileges.grantee = functions.proowner
           and privileges.grantor = functions.proowner
           and privileges.privilege_type = 'EXECUTE'
           and not privileges.is_grantable
         ),
         false
       )
      from pg_catalog.pg_proc functions
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          functions.proacl,
          pg_catalog.acldefault('f', functions.proowner)
        )
      ) privileges
     where functions.oid = pg_catalog.to_regprocedure(
       'renave.recover_expired_operation_sends(integer)'
     )
  )
  select ledger_ready.ready
     and prior_contract_metadata.ready
     and prior_contract_privileges.ready
     and prior_contract_result.ready
     and recovery_function_metadata.ready
     and recovery_function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         prior_contract_result, recovery_function_metadata,
         recovery_function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
