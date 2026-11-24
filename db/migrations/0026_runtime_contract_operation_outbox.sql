-- 0026 — Contrato de runtime fechado sobre a fundação operation/outbox.
--
-- Além da cadeia de checksums, o runtime confirma os controles estruturais
-- que tornam a migration 0025 segura. Esta migration não cria claim, worker,
-- rota mutável ou qualquer capacidade de despacho.

create or replace function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected(version, checksum) as (
    values
      ('0009_tenant_directory', '95139964cbc1419a54d740483d2a4e0aaece5b7be7eaa77b7e9f88a33e524653'),
      ('0010_protected_evidence_operations', 'e6cb7e1b5fdd3ada707cf641974b5280bcf9b3d50a78a91db8c7ed4741e9e319'),
      ('0011_login_rate_limit', 'a49d1a66d095c83f20f4ab8cccd0166e789dbf78143f4387592a2b9a68886348'),
      ('0012_runtime_contract', '0e4e7d69c7298540e70f46e606b97c18b7f193fbd814b09b8e6e765c1a70c913'),
      ('0013_serpro_query_limit', '0b781d990d1d79634a075184fb9f4679c047f7bb0d3be160b99d66535f67027c'),
      ('0014_runtime_contract_checksums', '4430bf61f001ba3deec314e2d5b1ec59c2ee3c77c51c3bc3be0ffc4e2c75043c'),
      ('0015_evidence_monitor_heartbeat', '1f90b6af29d9346e1efafc155fc5f7d8d7d356d0010b64e0d02f82453ebc4e78'),
      ('0016_maintenance_runtime_contract', '8625526936ca47a6f69e84cc1dcf5a49ae73b82bd2aed2b56c0945b37cc55d5d'),
      ('0017_credential_link', 'b7899f4193257dd18ce0a39b455a838963f54ac0d2d95bc1158032e408111783'),
      ('0018_identity_preflight_evidence', '713514e4cf22ef0b2d87715fa4e6e35e63fe4994998ced797e1ff4253fe2a6b1'),
      ('0019_evidence_open_incident_index', 'd268a7dec9b0c4eb62ad7f4e7fa807277078b79fa6ac758ddf2a530efe98b50c'),
      ('0020_runtime_contract_current', '9edaa3afbb75216e6ba5b545597f6c5809076d67e445fe501a63a15643e40e8b'),
      ('0021_credential_link_preflight_transitions', 'cbfd30a5bc0ed240ed5e2c67c55141dc7776b68bc129ef47353f963b612f2714'),
      ('0022_runtime_contract_preflight', 'a2d8efa5f633eebb3bd72b5db8ebb5bca5c580f2f72a652e54660387097356dd'),
      ('0023_stock_query_evidence', '763d30ec469f348c52d7a4d467f6c907b7d6d1ec5f8e7706ddb04a97984da68a'),
      ('0024_runtime_contract_stock_query', 'ce99a4f8d496d9f8f631c0e6d0e923e5609ece1bf3c9520e07eb28c0d69e94a7'),
      ('0025_operation_outbox', 'e4826d56134c617bd8a0854b6730150fd236262e5b9beaec7a90a902b6586833')
  ),
  ledger_ready(ready) as (
    select pg_catalog.count(migrations.version) = 17
       and coalesce(
         pg_catalog.bool_and(migrations.checksum = expected.checksum),
         false
       )
      from expected
      left join renave.schema_migrations migrations
        on migrations.version = expected.version
  ),
  required_tables(name) as (
    values ('operation'), ('operation_outbox'), ('operation_transition')
  ),
  tables_ready(ready) as (
    select pg_catalog.count(objects.oid) = 3
       and coalesce(
         pg_catalog.bool_and(
           objects.relkind = 'r'
           and objects.relpersistence = 'p'
           and objects.relrowsecurity
           and objects.relforcerowsecurity
           and owners.rolname = 'renave_migrator'
         ),
         false
       )
      from required_tables
      left join pg_catalog.pg_namespace namespace
        on namespace.nspname = 'renave'
      left join pg_catalog.pg_class objects
        on objects.relnamespace = namespace.oid
       and objects.relname = required_tables.name
      left join pg_catalog.pg_roles owners on owners.oid = objects.relowner
  ),
  required_policies(table_name, policy_name, canonical_expression) as (
    values
      ('operation', 'operation_isolation', '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'),
      ('operation_outbox', 'operation_outbox_isolation', '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'),
      ('operation_transition', 'operation_transition_isolation', '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))')
  ),
  policies_ready(ready) as (
    select pg_catalog.count(policies.oid) = 3
       and coalesce(
         pg_catalog.bool_and(
           policies.polpermissive
           and policies.polcmd = '*'
           and policies.polroles = array[0]::oid[]
           and (
             select pg_catalog.count(*) = 1
               from pg_catalog.pg_policy table_policies
              where table_policies.polrelid = objects.oid
           )
           and pg_catalog.pg_get_expr(
             policies.polqual,
             policies.polrelid,
             false
           ) = required_policies.canonical_expression
           and pg_catalog.pg_get_expr(
             policies.polwithcheck,
             policies.polrelid,
             false
           ) = required_policies.canonical_expression
         ),
         false
       )
      from required_policies
      left join pg_catalog.pg_namespace namespace
        on namespace.nspname = 'renave'
      left join pg_catalog.pg_class objects
        on objects.relnamespace = namespace.oid
       and objects.relname = required_policies.table_name
      left join pg_catalog.pg_policy policies
        on policies.polrelid = objects.oid
       and policies.polname = required_policies.policy_name
  ),
  required_indexes(
    table_name, index_name, is_unique, expected_columns,
    expected_predicate, constraint_type
  ) as (
    values
      ('operation', 'operation_tenant_idempotency_key', true, array['tenant_id', 'idempotency_key_digest']::text[], null::text, 'u'::text),
      ('operation', 'operation_active_vehicle_family_key', true, array['tenant_id', 'vehicle_key_digest', 'mutation_family']::text[], '(status = ANY (ARRAY[''PENDING_SEND''::text, ''SENT''::text, ''PENDING_RECONCILIATION''::text, ''MANUAL_REVIEW''::text]))', null::text),
      ('operation_outbox', 'operation_outbox_event_key', true, array['tenant_id', 'operation_id', 'event_type']::text[], null::text, 'u'::text),
      ('operation_outbox', 'operation_outbox_ready_idx', false, array['tenant_id', 'event_type', 'available_at', 'created_at', 'id']::text[], '(delivery_status = ''READY''::text)', null::text),
      ('operation_transition', 'operation_transition_version_key', true, array['tenant_id', 'operation_id', 'version']::text[], null::text, 'u'::text),
      ('operation_transition', 'operation_transition_timeline_idx', false, array['tenant_id', 'operation_id', 'version']::text[], null::text, null::text)
  ),
  indexes_ready(ready) as (
    select pg_catalog.count(indexes.oid) = 6
       and coalesce(
         pg_catalog.bool_and(
           index_metadata.indrelid = tables.oid
           and index_metadata.indisunique = required_indexes.is_unique
           and index_metadata.indnatts = index_metadata.indnkeyatts
           and array(
             select pg_catalog.pg_get_indexdef(
               indexes.oid,
               positions.position,
               false
             )
               from pg_catalog.generate_series(
                 1,
                 index_metadata.indnkeyatts
               ) positions(position)
              order by positions.position
           ) = required_indexes.expected_columns
           and pg_catalog.pg_get_expr(
             index_metadata.indpred,
             index_metadata.indrelid,
             false
           ) is not distinct from required_indexes.expected_predicate
           and case
             when required_indexes.constraint_type is null then not exists (
               select 1
                 from pg_catalog.pg_constraint constraints
                where constraints.conindid = indexes.oid
             )
             else exists (
               select 1
                 from pg_catalog.pg_constraint constraints
                where constraints.conindid = indexes.oid
                  and constraints.conrelid = tables.oid
                  and constraints.contype::text =
                    required_indexes.constraint_type
             )
           end
           and index_metadata.indisvalid
           and index_metadata.indisready
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
      left join pg_catalog.pg_class tables
        on tables.relnamespace = namespace.oid
       and tables.relname = required_indexes.table_name
      left join pg_catalog.pg_class indexes
        on indexes.relnamespace = namespace.oid
       and indexes.relname = required_indexes.index_name
       and indexes.relkind = 'i'
      left join pg_catalog.pg_index index_metadata
        on index_metadata.indexrelid = indexes.oid
  ),
  required_triggers(
    table_name, trigger_name, function_signature, trigger_type
  ) as (
    values
      ('operation', 'operation_guard', 'renave.operation_guard()', 23),
      ('operation', 'operation_reject_delete', 'renave.operation_storage_reject_removal()', 11),
      ('operation', 'operation_reject_truncate', 'renave.operation_storage_reject_removal()', 34),
      ('operation_outbox', 'operation_outbox_guard', 'renave.operation_outbox_guard()', 19),
      ('operation_outbox', 'operation_outbox_reject_delete', 'renave.operation_storage_reject_removal()', 11),
      ('operation_outbox', 'operation_outbox_reject_truncate', 'renave.operation_storage_reject_removal()', 34),
      ('operation_transition', 'operation_transition_append_only', 'renave.operation_transition_reject_change()', 27),
      ('operation_transition', 'operation_transition_reject_truncate', 'renave.operation_storage_reject_removal()', 34)
  ),
  triggers_ready(ready) as (
    select pg_catalog.count(triggers.oid) = 8
       and coalesce(
         pg_catalog.bool_and(
           triggers.tgenabled = 'O'
           and triggers.tgqual is null
           and triggers.tgattr = ''::int2vector
         ),
         false
       )
      from required_triggers
      left join pg_catalog.pg_namespace namespace
        on namespace.nspname = 'renave'
      left join pg_catalog.pg_class objects
        on objects.relnamespace = namespace.oid
       and objects.relname = required_triggers.table_name
      left join pg_catalog.pg_trigger triggers
        on triggers.tgrelid = objects.oid
       and triggers.tgname = required_triggers.trigger_name
       and not triggers.tgisinternal
       and triggers.tgfoid = pg_catalog.to_regprocedure(
         required_triggers.function_signature
       )
       and triggers.tgtype = required_triggers.trigger_type
  ),
  required_functions(
    signature, security_definer, language_name, volatility, app_can_execute,
    source_sha256
  ) as (
    values
      ('renave.create_operation_with_outbox(uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid)', true, 'plpgsql', 'v', true, 'a6de2245a35bf8d26f0697101210c16dee53aaacdf13c4bed2c87a46c272bf6f'),
      ('renave.get_operation_summary(uuid)', true, 'sql', 's', true, '511cd8583fc7b92f35b8e550403de469950b9161a650c964a5cac4c5cff096f4'),
      ('renave.operation_guard()', false, 'plpgsql', 'v', false, 'b1057cc6c9464df443b267e2359d785758e156e9d76bc4eaf980c7aebddf1c6a'),
      ('renave.operation_outbox_guard()', false, 'plpgsql', 'v', false, 'a8c8913a4e727660ec04b490477bd04cea61633f30987223a727a307998c952a'),
      ('renave.operation_transition_reject_change()', false, 'plpgsql', 'v', false, 'c0a6bed45cc83f65e8adab7b2e1b9abbe9790b9bdbe604c43d9a5760a4c642df'),
      ('renave.operation_storage_reject_removal()', false, 'plpgsql', 'v', false, '35bd000fac00db47f84d89b38bfdae1e09bb61186c95e794432a3b22fc9bb417')
  ),
  functions_ready(ready) as (
    select pg_catalog.count(functions.oid) = 6
       and coalesce(
         pg_catalog.bool_and(
           functions.prosecdef = required_functions.security_definer
           and owners.rolname = 'renave_migrator'
           and languages.lanname = required_functions.language_name
           and functions.provolatile = required_functions.volatility
           and functions.prokind = 'f'
           and functions.proconfig = array['search_path=pg_catalog']::text[]
           and functions.probin is null
           -- O SHA-256 de prosrc evita a formatação versionada de
           -- pg_get_functiondef. proconfig e probin são comparados de forma
           -- exata e separada; os valores vêm da 0025 no PostgreSQL 17 fixado.
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
  direct_table_privileges(ready) as (
    select not coalesce(
      pg_catalog.bool_or(
        pg_catalog.has_table_privilege(
          principals.name,
          objects.oid,
          privileges.name
        )
      ),
      false
    )
      from (values
        ('renave_app'),
        ('renave_identity_app'),
        ('renave_maintenance_app'),
        ('public')
      ) principals(name)
      cross join (values
        ('operation'),
        ('operation_outbox'),
        ('operation_transition')
      ) tables(name)
      cross join (values
        ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
        ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
      ) privileges(name)
      join pg_catalog.pg_namespace namespace on namespace.nspname = 'renave'
      join pg_catalog.pg_class objects
        on objects.relnamespace = namespace.oid
       and objects.relname = tables.name
  ),
  direct_column_privileges(ready) as (
    select not coalesce(
      pg_catalog.bool_or(
        pg_catalog.has_any_column_privilege(
          principals.name,
          objects.oid,
          privileges.name
        )
      ),
      false
    )
      from (values
        ('renave_app'),
        ('renave_identity_app'),
        ('renave_maintenance_app'),
        ('public')
      ) principals(name)
      cross join (values
        ('operation'),
        ('operation_outbox'),
        ('operation_transition')
      ) tables(name)
      cross join (values
        ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
      ) privileges(name)
      join pg_catalog.pg_namespace namespace on namespace.nspname = 'renave'
      join pg_catalog.pg_class objects
        on objects.relnamespace = namespace.oid
       and objects.relname = tables.name
  ),
  function_privileges(ready) as (
    select pg_catalog.count(*) = 24
       and pg_catalog.bool_and(
         pg_catalog.has_function_privilege(
           principals.name,
           required_functions.signature,
           'EXECUTE'
         ) = (
           principals.name = 'renave_app'
           and required_functions.app_can_execute
         )
       )
      from required_functions
      cross join (values
        ('renave_app'),
        ('renave_identity_app'),
        ('renave_maintenance_app'),
        ('public')
      ) principals(name)
  )
  select ledger_ready.ready
     and tables_ready.ready
     and policies_ready.ready
     and indexes_ready.ready
     and triggers_ready.ready
     and functions_ready.ready
     and direct_table_privileges.ready
     and direct_column_privileges.ready
     and function_privileges.ready
    from ledger_ready, tables_ready, policies_ready, indexes_ready,
         triggers_ready, functions_ready, direct_table_privileges,
         direct_column_privileges, function_privileges
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
