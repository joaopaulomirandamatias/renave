-- 0036 — Contrato exato das leases de reconciliação, ainda owner-only.

alter function renave_runtime.api_contract_ready()
  rename to send_completion_contract_ready_v0034;
revoke all on function renave_runtime.send_completion_contract_ready_v0034()
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
      ('0034_runtime_contract_send_completion', 'a70dd76ce617c2ec403862d1e729ca7c601438bfe44f66fd3170ab8ba4bcfbaa'),
      ('0035_operation_reconciliation_lease', 'a2510ef45c81f8ccfb43852241e07c222ba6451bd66be5559e6faf5f7099b85f')
  ),
  ledger_ready(ready) as (
    select pg_catalog.count(migrations.version) = 2
       and coalesce(pg_catalog.bool_and(
         migrations.checksum = expected_ledger.checksum
       ), false)
      from expected_ledger
      left join renave.schema_migrations migrations
        on migrations.version = expected_ledger.version
  ),
  prior_contract_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 1
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef and functions.provolatile = 's'
         and functions.prokind = 'f'
         and functions.proconfig = array['search_path=pg_catalog']::text[]
         and functions.probin is null
         and owners.rolname = 'renave_migrator'
         and languages.lanname = 'sql'
         and pg_catalog.pg_get_function_result(functions.oid) = 'boolean'
         and pg_catalog.encode(pg_catalog.sha256(
           pg_catalog.convert_to(functions.prosrc, 'UTF8')
         ), 'hex') = 'ac2fca4b42c580b2b26bb9c05de5e2809ee57f5c7f420f66832cd81b0576b0ba'
       ), false)
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.send_completion_contract_ready_v0034()'
     )
  ),
  prior_contract_privileges(ready) as (
    select pg_catalog.count(*) = 1
       and coalesce(pg_catalog.bool_and(
         privileges.grantee = functions.proowner
         and privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
       ), false)
      from pg_catalog.pg_proc functions
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.send_completion_contract_ready_v0034()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.send_completion_contract_ready_v0034()
  ),
  expected_functions(signature, result_type, returns_set, body_hash) as (
    values
      (
        'renave.claim_operation_reconciliation_leases(uuid,integer)',
        'TABLE(outbox_id uuid, operation_id uuid, operation_version bigint, attempt_count integer, lease_token uuid, lease_expires_at timestamp with time zone)',
        true,
        '74edf8d8c0412e8d19a94be141ae82f94a8d364cd6754e8925dc242c14b32d9e'
      ),
      (
        'renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)',
        'boolean', false,
        'fa8e33ba6f7bb374bf2208b6cb019510e876a044d968a7f2a7208a8353124107'
      ),
      (
        'renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)',
        'boolean', false,
        'dfca6f6f5047f5fae5d282e35aabf9997ddbde9ff928f82251b4fc2d3e2e2fe2'
      ),
      (
        'renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)',
        'TABLE(outbox_id uuid, operation_id uuid, establishment_id uuid, correlation_id uuid, kind text, mutation_family text, operation_version bigint, sent_at timestamp with time zone, attempt_count integer, lease_expires_at timestamp with time zone)',
        true,
        'abc2be06156d9cf5fb4ebcd88e354d3559d76177355301827a4c2f72215a4603'
      )
  ),
  reconciliation_function_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 4
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef and functions.provolatile = 'v'
         and functions.prokind = 'f'
         and functions.proretset = expected_functions.returns_set
         and functions.proconfig = array['search_path=pg_catalog']::text[]
         and functions.probin is null
         and owners.rolname = 'renave_migrator'
         and languages.lanname = 'plpgsql'
         and pg_catalog.pg_get_function_result(functions.oid) =
           expected_functions.result_type
         and pg_catalog.encode(pg_catalog.sha256(
           pg_catalog.convert_to(functions.prosrc, 'UTF8')
         ), 'hex') = expected_functions.body_hash
       ), false)
      from expected_functions
      left join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      left join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      left join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
  ),
  reconciliation_function_privileges(ready) as (
    select pg_catalog.count(*) = 4
       and coalesce(pg_catalog.bool_and(
         privileges.grantee = functions.proowner
         and privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
       ), false)
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
     and reconciliation_function_metadata.ready
     and reconciliation_function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         prior_contract_result, reconciliation_function_metadata,
         reconciliation_function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
