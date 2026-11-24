-- 0038 — Contrato runtime da projeção cifrada de reconciliação.

alter function renave_runtime.api_contract_ready()
  rename to reconciliation_lease_contract_ready_v0036;
revoke all on function
  renave_runtime.reconciliation_lease_contract_ready_v0036()
from public, renave_app, renave_identity_app, renave_maintenance_app;

-- A assinatura de begin foi ampliada pela 0037. Mantemos o contrato histórico
-- como verificador dos três fences que não mudaram e de toda a cadeia anterior;
-- a nova api_contract_ready fixa separadamente o begin ampliado.
create or replace function
  renave_runtime.reconciliation_lease_contract_ready_v0036()
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
      )
  ),
  reconciliation_function_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 3
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
    select pg_catalog.count(*) = 3
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
     and reconciliation_function_metadata.ready
     and reconciliation_function_privileges.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         reconciliation_function_metadata,
         reconciliation_function_privileges
$$;

revoke all on function
  renave_runtime.reconciliation_lease_contract_ready_v0036()
from public, renave_app, renave_identity_app, renave_maintenance_app;

-- A cadeia histórica não pode mais ser executada porque sua primeira versão
-- exige a assinatura de criação removida. Esta impressão canônica mantém a
-- detecção de drift em todo o catálogo RENAVE sem reabrir aquele bypass.
create function renave_runtime.operation_catalog_fingerprint_v0038()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'ledger', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(m.version, m.checksum) order by m.version
      ) from renave.schema_migrations m
        where m.version < '0037_operation_reconciliation_projection'), '[]'::jsonb),
      'classes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, c.relkind, c.relpersistence,
          c.relrowsecurity, c.relforcerowsecurity, r.rolname,
          coalesce(c.relacl::text, '')) order by c.relname, c.relkind
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_roles r on r.oid = c.relowner
        where n.nspname = 'renave'), '[]'::jsonb),
      'columns', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, a.attnum, a.attname,
          pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
          a.attisdropped, coalesce(a.attacl::text, ''))
        order by c.relname, a.attnum
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0
        where n.nspname = 'renave' and c.relkind in ('r', 'p')), '[]'::jsonb),
      'constraints', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, x.conname, x.contype,
          x.convalidated, pg_catalog.pg_get_constraintdef(x.oid, false))
        order by c.relname, x.conname
      ) from pg_catalog.pg_constraint x
        join pg_catalog.pg_class c on c.oid = x.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave'), '[]'::jsonb),
      'indexes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(i.relname, t.relname, x.indisunique,
          x.indisvalid, x.indisready, pg_catalog.pg_get_indexdef(i.oid))
        order by i.relname
      ) from pg_catalog.pg_index x
        join pg_catalog.pg_class i on i.oid = x.indexrelid
        join pg_catalog.pg_class t on t.oid = x.indrelid
        join pg_catalog.pg_namespace n on n.oid = i.relnamespace
        where n.nspname = 'renave'), '[]'::jsonb),
      'policies', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, p.polname, p.polcmd,
          p.polpermissive, p.polroles,
          pg_catalog.pg_get_expr(p.polqual, p.polrelid, false),
          pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false))
        order by c.relname, p.polname
      ) from pg_catalog.pg_policy p
        join pg_catalog.pg_class c on c.oid = p.polrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave'), '[]'::jsonb),
      'triggers', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, t.tgname, t.tgenabled,
          t.tgtype, t.tgdeferrable, t.tginitdeferred, t.tgattr::text,
          pg_catalog.pg_get_expr(t.tgqual, t.tgrelid, false),
          t.tgfoid::regprocedure::text) order by c.relname, t.tgname
      ) from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'renave' and not t.tgisinternal), '[]'::jsonb),
      'functions', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(p.proname,
          pg_catalog.pg_get_function_identity_arguments(p.oid),
          pg_catalog.pg_get_function_result(p.oid), p.prosecdef,
          p.provolatile, p.prokind, l.lanname, r.rolname,
          coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''),
          pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))
        order by p.proname,
          pg_catalog.pg_get_function_identity_arguments(p.oid)
      ) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_roles r on r.oid = p.proowner
        join pg_catalog.pg_language l on l.oid = p.prolang
        where n.nspname = 'renave'), '[]'::jsonb)
    )::text, 'UTF8'
  )), 'hex')
$$;

revoke all on function renave_runtime.operation_catalog_fingerprint_v0038()
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
      ('0036_runtime_contract_reconciliation_lease', '415571ffb8eebd927a18ea036eecbd20435be6f3b04830771b46d8827ffba026'),
      ('0037_operation_reconciliation_projection', 'ef5e2969fb44a8d7258b2ef9b3f421c1ad8e4971222f947697ab10e463a748fa')
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
         ), 'hex') = '32c35eed5ce42eb337ca790774b8ae2ab98d62032b524632243ec6966b5873e5'
       ), false)
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.reconciliation_lease_contract_ready_v0036()'
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
       'renave_runtime.reconciliation_lease_contract_ready_v0036()'
     )
  ),
  prior_contract_result(ready) as (
    select renave_runtime.reconciliation_lease_contract_ready_v0036()
  ),
  catalog_fingerprint_metadata(ready) as (
    select pg_catalog.count(functions.oid) = 1
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef and functions.provolatile = 's'
         and functions.prokind = 'f'
         and functions.proconfig = array['search_path=pg_catalog']::text[]
         and functions.probin is null and owners.rolname = 'renave_migrator'
         and languages.lanname = 'sql'
         and pg_catalog.pg_get_function_result(functions.oid) = 'text'
         and pg_catalog.encode(pg_catalog.sha256(
           pg_catalog.convert_to(functions.prosrc, 'UTF8')
         ), 'hex') = '222a4de4b15e526943b0982b7a68cdf8c14a11c7d316015919d66aa99e9127bd'
       ), false)
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_roles owners on owners.oid = functions.proowner
      join pg_catalog.pg_language languages on languages.oid = functions.prolang
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.operation_catalog_fingerprint_v0038()'
     )
  ),
  catalog_fingerprint_privileges(ready) as (
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
       'renave_runtime.operation_catalog_fingerprint_v0038()'
     )
  ),
  catalog_fingerprint_result(ready) as (
    select renave_runtime.operation_catalog_fingerprint_v0038() =
      '05ffe3438a6f682251e6036b7eb988c4151e877fc02ea1b9ed8490cf561683f2'
  ),
  projection_table(oid, owner_oid, table_acl, ready) as (
    select tables.oid, tables.relowner, tables.relacl,
           tables.relkind = 'r' and tables.relpersistence = 'p'
           and tables.relrowsecurity and tables.relforcerowsecurity
           and owners.rolname = 'renave_migrator'
      from pg_catalog.pg_class tables
      join pg_catalog.pg_namespace namespace
        on namespace.oid = tables.relnamespace
      join pg_catalog.pg_roles owners on owners.oid = tables.relowner
     where namespace.nspname = 'renave'
       and tables.relname = 'operation_reconciliation_projection'
  ),
  expected_columns(name, type_name, not_null, has_default) as (
    values
      ('tenant_id', 'uuid', true, false),
      ('operation_id', 'uuid', true, false),
      ('projection_kind', 'text', true, false),
      ('projection_schema_version', 'integer', true, false),
      ('projection_generation', 'bigint', true, false),
      ('projection_size', 'integer', true, false),
      ('projection_key_id', 'text', true, false),
      ('projection_nonce', 'bytea', true, false),
      ('projection_auth_tag', 'bytea', true, false),
      ('projection_ciphertext', 'bytea', true, false),
      ('created_at', 'timestamp with time zone', true, true)
  ),
  projection_column_count(total) as (
    select pg_catalog.count(*)
      from projection_table
      join pg_catalog.pg_attribute attributes
        on attributes.attrelid = projection_table.oid
     where attributes.attnum > 0 and not attributes.attisdropped
  ),
  columns_ready(ready) as (
    select pg_catalog.count(attributes.attname) = 11
       and projection_column_count.total = 11
       and coalesce(pg_catalog.bool_and(
         not attributes.attisdropped
         and attributes.attnotnull = expected_columns.not_null
         and pg_catalog.format_type(
           attributes.atttypid, attributes.atttypmod
         ) = expected_columns.type_name
         and (defaults.adbin is not null) = expected_columns.has_default
       ), false)
      from expected_columns
      left join projection_table on true
      left join pg_catalog.pg_attribute attributes
        on attributes.attrelid = projection_table.oid
       and attributes.attname = expected_columns.name
       and attributes.attnum > 0
      left join pg_catalog.pg_attrdef defaults
        on defaults.adrelid = attributes.attrelid
       and defaults.adnum = attributes.attnum
      cross join projection_column_count
     group by projection_column_count.total
  ),
  expected_constraints(name, type_code) as (
    values
      ('operation_reconciliation_projection_pkey', 'p'::char),
      ('operation_reconciliation_projection_key_nonce_key', 'u'::char),
      ('operation_reconciliation_projection_operation_fkey', 'f'::char),
      ('operation_reconciliation_projection_kind_valid', 'c'::char),
      ('operation_reconciliation_projection_schema_valid', 'c'::char),
      ('operation_reconciliation_projection_generation_valid', 'c'::char),
      ('operation_reconciliation_projection_size_valid', 'c'::char),
      ('operation_reconciliation_projection_key_id_valid', 'c'::char),
      ('operation_reconciliation_projection_nonce_valid', 'c'::char),
      ('operation_reconciliation_projection_auth_tag_valid', 'c'::char)
  ),
  projection_constraint_count(total) as (
    select pg_catalog.count(*)
      from projection_table
      join pg_catalog.pg_constraint constraints
        on constraints.conrelid = projection_table.oid
  ),
  constraints_ready(ready) as (
    select pg_catalog.count(constraints.oid) = 10
       and projection_constraint_count.total = 10
       and coalesce(pg_catalog.bool_and(
         constraints.contype = expected_constraints.type_code
         and constraints.convalidated
       ), false)
      from expected_constraints
      left join projection_table on true
      left join pg_catalog.pg_constraint constraints
        on constraints.conrelid = projection_table.oid
       and constraints.conname = expected_constraints.name
      cross join projection_constraint_count
     group by projection_constraint_count.total
  ),
  nonce_key_unique(ready) as (
    select pg_catalog.count(indexes.oid) = 1
       and coalesce(pg_catalog.bool_and(
         metadata.indisunique and metadata.indisvalid and metadata.indisready
         and metadata.indpred is null
         and pg_catalog.pg_get_indexdef(indexes.oid) like
           '%(projection_key_id, projection_nonce)%'
       ), false)
      from pg_catalog.pg_class indexes
      join pg_catalog.pg_namespace namespace
        on namespace.oid = indexes.relnamespace
      join pg_catalog.pg_index metadata on metadata.indexrelid = indexes.oid
     where namespace.nspname = 'renave'
       and indexes.relname =
         'operation_reconciliation_projection_key_nonce_key'
  ),
  policy_ready(ready) as (
    select pg_catalog.count(policies.oid) = 1
       and coalesce(pg_catalog.bool_and(
         policies.polname = 'operation_reconciliation_projection_isolation'
         and policies.polcmd = '*'
         and policies.polpermissive
         and policies.polroles = array[0::oid]
         and pg_catalog.pg_get_expr(policies.polqual, policies.polrelid) =
           '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
         and pg_catalog.pg_get_expr(policies.polwithcheck, policies.polrelid) =
           '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
       ), false)
      from projection_table
      left join pg_catalog.pg_policy policies
        on policies.polrelid = projection_table.oid
  ),
  expected_triggers(table_name, name, signature, trigger_type,
                    is_constraint, is_deferrable, initially_deferred) as (
    values
      ('operation_reconciliation_projection',
       'operation_reconciliation_projection_reject_update_delete',
       'renave.operation_reconciliation_projection_reject_change()', 27,
       false, false, false),
      ('operation_reconciliation_projection',
       'operation_reconciliation_projection_reject_truncate',
       'renave.operation_storage_reject_removal()', 34,
       false, false, false),
      ('operation', 'operation_requires_reconciliation_projection',
       'renave.operation_requires_reconciliation_projection()', 5,
       true, true, true)
  ),
  triggers_ready(ready) as (
    select pg_catalog.count(triggers.oid) = 3
       and coalesce(pg_catalog.bool_and(
         triggers.tgenabled = 'O' and triggers.tgtype = expected_triggers.trigger_type
         and triggers.tgqual is null and triggers.tgattr = ''::int2vector
         and (triggers.tgconstraint <> 0) = expected_triggers.is_constraint
         and triggers.tgdeferrable = expected_triggers.is_deferrable
         and triggers.tginitdeferred = expected_triggers.initially_deferred
         and triggers.tgfoid = pg_catalog.to_regprocedure(
           expected_triggers.signature
         )
       ), false)
      from expected_triggers
      left join pg_catalog.pg_namespace trigger_namespace
        on trigger_namespace.nspname = 'renave'
      left join pg_catalog.pg_class trigger_table
        on trigger_table.relnamespace = trigger_namespace.oid
       and trigger_table.relname = expected_triggers.table_name
      left join pg_catalog.pg_trigger triggers
        on triggers.tgrelid = trigger_table.oid
       and triggers.tgname = expected_triggers.name
       and not triggers.tgisinternal
  ),
  table_acl_ready(ready) as (
    select pg_catalog.count(*) = 8
       and coalesce(pg_catalog.bool_and(
         privileges.grantee = projection_table.owner_oid
         and privileges.grantor = projection_table.owner_oid
         and not privileges.is_grantable
       ), false)
      from projection_table
      cross join lateral pg_catalog.aclexplode(coalesce(
        projection_table.table_acl,
        pg_catalog.acldefault('r', projection_table.owner_oid)
      )) privileges
  ),
  column_acl_ready(ready) as (
    select pg_catalog.count(*) = 0
      from projection_table
      join pg_catalog.pg_attribute attributes
        on attributes.attrelid = projection_table.oid
       and attributes.attnum > 0
       and attributes.attacl is not null
  ),
  expected_functions(
    signature, result_type, body_hash, security_definer, app_execute
  ) as (
    values
      (
        'renave.create_operation_with_outbox(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)',
        'TABLE(operation_id uuid, operation_status text, replayed boolean, operation_created_at timestamp with time zone)',
        '62e2ec3960b3d2447a6c3e89e184765c166fd05c8222cd18e2b9cc1eaf943356', true, true
      ),
      (
        'renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)',
        'TABLE(outbox_id uuid, operation_id uuid, establishment_id uuid, correlation_id uuid, kind text, mutation_family text, request_schema_version integer, operation_version bigint, sent_at timestamp with time zone, attempt_count integer, lease_expires_at timestamp with time zone, projection_kind text, projection_schema_version integer, projection_generation bigint, source_request_sha256 bytea, projection_size integer, projection_key_id text, projection_nonce bytea, projection_auth_tag bytea, projection_ciphertext bytea)',
        '6b152e31f82c023ab8d2a396996ea15f644f94a4ea231b7aaf901817bcb08985', true, false
      ),
      (
        'renave.operation_reconciliation_projection_reject_change()',
        'trigger',
        'e84d166f4d8a9546d8a3b53f97bb6dccae7c5bd0ee6a7c356d5983b8e928d802', false, false
      ),
      (
        'renave.operation_requires_reconciliation_projection()',
        'trigger',
        '173df1dcc7bdad89f756e4cdd85d0410cebb303e71e21eee8dfbb1d05c00e56c', true, false
      )
  ),
  functions_ready(ready) as (
    select pg_catalog.count(functions.oid) = 4
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef = expected_functions.security_definer
         and functions.provolatile = 'v' and functions.prokind = 'f'
         and functions.proconfig = array['search_path=pg_catalog']::text[]
         and functions.probin is null and owners.rolname = 'renave_migrator'
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
  function_acl_ready(ready) as (
    select pg_catalog.count(*) = 5
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = functions.proowner
         and not privileges.is_grantable
         and privileges.privilege_type = 'EXECUTE'
         and (
           privileges.grantee = functions.proowner
           or (expected_functions.app_execute and privileges.grantee = (
             select roles.oid from pg_catalog.pg_roles roles
              where roles.rolname = 'renave_app'
           ))
         )
       ), false)
      from expected_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
  ),
  old_create_absent(ready) as (
    select pg_catalog.to_regprocedure(
      'renave.create_operation_with_outbox(uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid)'
    ) is null
  )
  select ledger_ready.ready
     and prior_contract_metadata.ready
     and prior_contract_privileges.ready
     and prior_contract_result.ready
     and catalog_fingerprint_metadata.ready
     and catalog_fingerprint_privileges.ready
     and catalog_fingerprint_result.ready
     and coalesce((select ready from projection_table), false)
     and columns_ready.ready and constraints_ready.ready
     and nonce_key_unique.ready and policy_ready.ready
     and triggers_ready.ready and table_acl_ready.ready
     and column_acl_ready.ready
     and functions_ready.ready and function_acl_ready.ready
     and old_create_absent.ready
    from ledger_ready, prior_contract_metadata, prior_contract_privileges,
         prior_contract_result, catalog_fingerprint_metadata,
         catalog_fingerprint_privileges, catalog_fingerprint_result,
         columns_ready, constraints_ready,
         nonce_key_unique, policy_ready, triggers_ready, table_acl_ready,
         column_acl_ready,
         functions_ready, function_acl_ready, old_create_absent
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
