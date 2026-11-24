-- 0034 — Contrato exato das conclusões SEND, ainda owner-only.

alter function renave_runtime.api_contract_ready()
  rename to expired_send_recovery_contract_ready_v0032;

revoke all on function
  renave_runtime.expired_send_recovery_contract_ready_v0032()
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
      ('0032_runtime_contract_expired_send_recovery', 'f8cf527eca18015eacc8de2eb8884062758870fd26a13dda55226dae47997fdb'),
      ('0033_operation_complete_send', '234d9dda4d15e4c235893ef8011833cdebc9e215f8c3d8a977c6b7e9f8e274da')
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
             pg_catalog.sha256(pg_catalog.convert_to(functions.prosrc, 'UTF8')),
             'hex'
           ) = 'bad4e0d6f1ed2808221ee0cdf6ae6128d7b4bbf81d92bf7e2b1334db8b338111'
         ),
         false
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.expired_send_recovery_contract_ready_v0032()'
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
         ), false
       )
      from pg_catalog.pg_proc functions
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.expired_send_recovery_contract_ready_v0032()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.expired_send_recovery_contract_ready_v0032()
  ),
  expected_functions(signature, result_type, body_hash) as (
    values
      (
        'renave.complete_operation_send_confirmed(uuid,uuid,uuid,bigint,bigint,text)',
        'TABLE(operation_id uuid, send_outbox_id uuid, operation_version bigint, completed_at timestamp with time zone)',
        '1ccc3cced1405dd990f1912f32f7fafe14b228a4910423de4ccae8f990bf17d4'
      ),
      (
        'renave.complete_operation_send_rejected(uuid,uuid,uuid,bigint,integer)',
        'TABLE(operation_id uuid, send_outbox_id uuid, operation_version bigint, completed_at timestamp with time zone)',
        '983d8281bb36cfa5505482dca54f371ac0931fe8c63d76b24e96a5b0e3172f4d'
      ),
      (
        'renave.complete_operation_send_outcome_unknown(uuid,uuid,uuid,bigint)',
        'TABLE(operation_id uuid, send_outbox_id uuid, reconcile_outbox_id uuid, operation_version bigint, completed_at timestamp with time zone, reconcile_available_at timestamp with time zone)',
        '2f2169cb94114c4e1442c39efed1914c50c8dfdf114bcd24f9e982ff05a75f9f'
      )
  ),
  completion_function_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 3
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
             expected_functions.result_type
           and pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(functions.prosrc, 'UTF8')),
             'hex'
           ) = expected_functions.body_hash
         ), false
       )
      from expected_functions
      left join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      left join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      left join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
  ),
  completion_function_privileges(ready) as (
    select pg_catalog.count(*) = 3
       and coalesce(
         pg_catalog.bool_and(
           privileges.grantee = functions.proowner
           and privileges.grantor = functions.proowner
           and privileges.privilege_type = 'EXECUTE'
           and not privileges.is_grantable
         ), false
       )
      from expected_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
  )
  select ledger_ready.ready
     and prior_contract_metadata.ready
     and prior_contract_privileges.ready
     and prior_contract_result.ready
     and completion_function_metadata.ready
     and completion_function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         prior_contract_result, completion_function_metadata,
         completion_function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
