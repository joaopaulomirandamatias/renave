-- 0030 — Contrato de runtime do fence beginDispatch, ainda owner-only.

alter function renave_runtime.api_contract_ready()
  rename to operation_claim_contract_ready_v0028;

revoke all on function
  renave_runtime.operation_claim_contract_ready_v0028()
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
      ('0028_runtime_contract_operation_claim', '97fcabf9ef9e9c2c5c9653b3fd00fd2a045b84e890158e6485531098bad3d80f'),
      ('0029_operation_begin_dispatch', '534eb03d0cc3e5b6597d60307322619b2fbfc004b794673b9b48e75a5996f28d')
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
           ) = '06e842372c409712a34012e0c6c404a5c77865c3eb9b2644753e138858254837'
         ),
         false
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.operation_claim_contract_ready_v0028()'
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
       'renave_runtime.operation_claim_contract_ready_v0028()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.operation_claim_contract_ready_v0028()
  ),
  dispatch_function_metadata(ready) as (
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
             'TABLE(outbox_id uuid, operation_id uuid, tenant_id uuid, establishment_id uuid, correlation_id uuid, kind text, mutation_family text, operation_version bigint, sent_at timestamp with time zone, attempt_count integer, lease_owner uuid, lease_token uuid, lease_expires_at timestamp with time zone, idempotency_key_digest bytea, vehicle_key_digest bytea, actor_subject_hash bytea, request_sha256 bytea, request_size integer, request_schema_version integer, request_key_id text, request_nonce bytea, request_auth_tag bytea, request_ciphertext bytea)'
           and pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(functions.prosrc, 'UTF8')
             ),
             'hex'
           ) = 'fe003a6018a06b9e1bb287312aed1388467118e1ad0b1440fd2a7d69197989b4'
         ),
         false
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'
     )
  ),
  dispatch_function_privileges(ready) as (
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
       'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'
     )
  )
  select ledger_ready.ready
     and prior_contract_metadata.ready
     and prior_contract_privileges.ready
     and prior_contract_result.ready
     and dispatch_function_metadata.ready
     and dispatch_function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         prior_contract_result, dispatch_function_metadata,
         dispatch_function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
