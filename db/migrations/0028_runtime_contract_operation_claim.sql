-- 0028 — Contrato de runtime do claim/lease ainda sem grant de dispatcher.
--
-- A função anterior é preservada como contrato fechado da fundação 0025/0026.
-- O novo contrato atesta sua integridade antes de acrescentar os objetos 0027.

alter function renave_runtime.api_contract_ready()
  rename to operation_outbox_contract_ready_v0026;

revoke all on function
  renave_runtime.operation_outbox_contract_ready_v0026()
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
      ('0026_runtime_contract_operation_outbox', '01690d02de3da324d5380fd86524455088c1eb5b9943d2db1ea102280496ba36'),
      ('0027_operation_outbox_claim_lease', '9d951c0968c06e909869f68dcf4d6d0284635b1cc5a69414ea9256355ec17e68')
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
           and pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(functions.prosrc, 'UTF8')
             ),
             'hex'
           ) = '3a4abd2a7f65f51c3c08ecb2bf524481c791d8281d8948a2e8058f8526de2749'
         ),
         false
       )
       and not pg_catalog.has_function_privilege(
         'renave_app',
         'renave_runtime.operation_outbox_contract_ready_v0026()',
         'EXECUTE'
       )
       and not pg_catalog.has_function_privilege(
         'renave_identity_app',
         'renave_runtime.operation_outbox_contract_ready_v0026()',
         'EXECUTE'
       )
       and not pg_catalog.has_function_privilege(
         'renave_maintenance_app',
         'renave_runtime.operation_outbox_contract_ready_v0026()',
         'EXECUTE'
       )
       and not pg_catalog.has_function_privilege(
         'public',
         'renave_runtime.operation_outbox_contract_ready_v0026()',
         'EXECUTE'
       )
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.operation_outbox_contract_ready_v0026()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.operation_outbox_contract_ready_v0026()
  ),
  required_indexes(
    index_name, is_unique, expected_columns, expected_predicate
  ) as (
    values
      ('operation_outbox_lease_token_key', true, array['lease_token']::text[], '(lease_token IS NOT NULL)'),
      ('operation_outbox_expired_lease_idx', false, array['tenant_id', 'event_type', 'lease_expires_at', 'created_at', 'id']::text[], '(delivery_status = ''LEASED''::text)')
  ),
  indexes_ready(ready) as (
    select pg_catalog.count(indexes.oid) = 2
       and coalesce(
         pg_catalog.bool_and(
           metadata.indrelid = 'renave.operation_outbox'::regclass
           and metadata.indisunique = required_indexes.is_unique
           and metadata.indnatts = metadata.indnkeyatts
           and array(
             select pg_catalog.pg_get_indexdef(
               indexes.oid,
               positions.position,
               false
             )
               from pg_catalog.generate_series(
                 1,
                 metadata.indnkeyatts
               ) positions(position)
              order by positions.position
           ) = required_indexes.expected_columns
           and pg_catalog.pg_get_expr(
             metadata.indpred,
             metadata.indrelid,
             false
           ) = required_indexes.expected_predicate
           and not exists (
             select 1
               from pg_catalog.pg_constraint constraints
              where constraints.conindid = indexes.oid
           )
           and metadata.indisvalid
           and metadata.indisready
           and indexes.relam = (
             select methods.oid
               from pg_catalog.pg_am methods
              where methods.amname = 'btree'
           )
         ),
         false
       )
      from required_indexes
      left join pg_catalog.pg_namespace namespace
        on namespace.nspname = 'renave'
      left join pg_catalog.pg_class indexes
        on indexes.relnamespace = namespace.oid
       and indexes.relname = required_indexes.index_name
       and indexes.relkind = 'i'
      left join pg_catalog.pg_index metadata
        on metadata.indexrelid = indexes.oid
  ),
  required_functions(signature, source_sha256) as (
    values
      ('renave.claim_operation_send_leases(uuid,integer)', 'd2525da9b1db875a0ca75dddad52389cd590cfafd094e6132305b0f719835485'),
      ('renave.renew_operation_send_lease(uuid,uuid,uuid)', 'b7d4394e5b0683c264e902dde5a35870ccad69e9d09d98218a3af73b0ca9164c'),
      ('renave.release_operation_send_lease(uuid,uuid,uuid,integer)', '86ff70926da74ebd330d345b12b81eedc3ff7422249088324d70e6c907c04a47')
  ),
  functions_ready(ready) as (
    select pg_catalog.count(functions.oid) = 3
       and coalesce(
         pg_catalog.bool_and(
           functions.prosecdef
           and functions.provolatile = 'v'
           and functions.prokind = 'f'
           and functions.proconfig = array['search_path=pg_catalog']::text[]
           and functions.probin is null
           and owners.rolname = 'renave_migrator'
           and languages.lanname = 'plpgsql'
           and pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(functions.prosrc, 'UTF8')
             ),
             'hex'
           ) = required_functions.source_sha256
         ),
         false
       )
      from required_functions
      left join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          required_functions.signature
        )
      left join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      left join pg_catalog.pg_language languages
        on languages.oid = functions.prolang
  ),
  function_privileges(ready) as (
    select pg_catalog.count(*) = 3
       and coalesce(
         pg_catalog.bool_and(
           privileges.grantee = functions.proowner
           and privileges.grantor = functions.proowner
           and privileges.privilege_type = 'EXECUTE'
           and not privileges.is_grantable
         ),
         false
       )
      from required_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          required_functions.signature
        )
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          functions.proacl,
          pg_catalog.acldefault('f', functions.proowner)
        )
      ) privileges
  )
  select ledger_ready.ready
     and prior_contract_metadata.ready
     and prior_contract_result.ready
     and indexes_ready.ready
     and functions_ready.ready
     and function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_result,
         indexes_ready, functions_ready, function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
