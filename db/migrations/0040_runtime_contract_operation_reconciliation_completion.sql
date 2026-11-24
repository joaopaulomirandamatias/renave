-- 0040 — Contrato runtime do worker de reconciliação e do catálogo atual.

alter function renave_runtime.api_contract_ready()
  rename to operation_projection_contract_ready_v0038;
revoke all on function
  renave_runtime.operation_projection_contract_ready_v0038()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected_ledger(version, checksum) as (
    values
      ('0038_runtime_contract_operation_reconciliation_projection',
       '557ffe6a269f924e0a12c2df4fc5581fa40cf5cf4231c420c01f92b0041d63a0'),
      ('0039_operation_reconciliation_completion',
       '58051c21983ca6d42a0eb6e67801aea71a37484c30fdd1717e926b1a20ebe175')
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
  fingerprint_ready(ready) as (
    select renave_runtime.operation_catalog_fingerprint_v0038() =
      '8565848b0600843da926442bbef3d069f315eab31336532af0e6cba42d4840e5'
  ),
  expected_functions(signature, result_type, body_hash) as (
    values
      (
        'renave.claim_operation_reconciliation_leases(uuid,integer)',
        'TABLE(outbox_id uuid, operation_id uuid, operation_version bigint, attempt_count integer, lease_token uuid, lease_expires_at timestamp with time zone)',
        '74edf8d8c0412e8d19a94be141ae82f94a8d364cd6754e8925dc242c14b32d9e'
      ),
      (
        'renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)',
        'boolean',
        'fa8e33ba6f7bb374bf2208b6cb019510e876a044d968a7f2a7208a8353124107'
      ),
      (
        'renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)',
        'boolean',
        'dfca6f6f5047f5fae5d282e35aabf9997ddbde9ff928f82251b4fc2d3e2e2fe2'
      ),
      (
        'renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)',
        'TABLE(outbox_id uuid, operation_id uuid, establishment_id uuid, establishment_cnpj text, correlation_id uuid, kind text, mutation_family text, request_schema_version integer, operation_version bigint, sent_at timestamp with time zone, attempt_count integer, lease_expires_at timestamp with time zone, projection_kind text, projection_schema_version integer, projection_generation bigint, source_request_sha256 bytea, projection_size integer, projection_key_id text, projection_nonce bytea, projection_auth_tag bytea, projection_ciphertext bytea)',
        '45acd782098bfbcbd1c36af98386d51174c679dade344ec9ff6545f05206733e'
      ),
      (
        'renave.complete_operation_reconciliation_confirmed(uuid,uuid,uuid,bigint,bigint,text)',
        'TABLE(operation_id uuid, reconcile_outbox_id uuid, operation_version bigint, completed_at timestamp with time zone)',
        '029117c313097b47f6e121fd06d09692302dc25c2b17bee1fa7b2636a81dbaca'
      ),
      (
        'renave.complete_operation_reconciliation_manual_review(uuid,uuid,uuid,bigint,text)',
        'TABLE(operation_id uuid, reconcile_outbox_id uuid, operation_version bigint, completed_at timestamp with time zone)',
        '1013cab472d74573394dee9eeca326ef27c0a1861e7e0c8c80dc02cad8d3131d'
      )
  ),
  functions_ready(ready) as (
    select pg_catalog.count(functions.oid) = 6
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef and functions.provolatile = 'v'
         and functions.prokind = 'f'
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
  worker_role(oid, ready) as (
    select roles.oid,
           roles.rolcanlogin and not roles.rolsuper
           and not roles.rolinherit and not roles.rolcreaterole
           and not roles.rolcreatedb and not roles.rolbypassrls
           and not roles.rolreplication
           and pg_catalog.has_database_privilege(
             roles.rolname, pg_catalog.current_database(), 'CONNECT'
           )
           and not pg_catalog.has_database_privilege(
             roles.rolname, pg_catalog.current_database(), 'CREATE'
           )
           and not pg_catalog.has_database_privilege(
             roles.rolname, pg_catalog.current_database(), 'TEMPORARY'
           )
      from pg_catalog.pg_roles roles
     where roles.rolname = 'renave_operation_worker'
  ),
  effective_schema_privileges_ready(ready) as (
    select pg_catalog.count(*) filter (
             where schemas.nspname in ('renave', 'renave_runtime')
           ) = 2
       and coalesce(pg_catalog.bool_and(
         case
           when schemas.nspname in ('renave', 'renave_runtime') then
             pg_catalog.has_schema_privilege(
               'renave_operation_worker', schemas.oid, 'USAGE'
             )
             and not pg_catalog.has_schema_privilege(
               'renave_operation_worker', schemas.oid, 'CREATE'
             )
           else
             not pg_catalog.has_schema_privilege(
               'renave_operation_worker', schemas.oid, 'USAGE'
             )
             and not pg_catalog.has_schema_privilege(
               'renave_operation_worker', schemas.oid, 'CREATE'
             )
         end
       ), false)
      from pg_catalog.pg_namespace schemas
     where schemas.nspname !~ '^pg_'
       and schemas.nspname <> 'information_schema'
  ),
  database_acl_ready(ready) as (
    select pg_catalog.count(*) = 1
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = databases.datdba
         and privileges.privilege_type = 'CONNECT'
         and not privileges.is_grantable
       ), false)
      from pg_catalog.pg_database databases
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        databases.datacl, pg_catalog.acldefault('d', databases.datdba)
      )) privileges
     where databases.datname = pg_catalog.current_database()
       and privileges.grantee = worker_role.oid
  ),
  function_acl_ready(ready) as (
    select pg_catalog.count(*) = 12
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
         and privileges.grantee in (functions.proowner, worker_role.oid)
       ), false)
      from expected_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
  ),
  schema_acl_ready(ready) as (
    select pg_catalog.count(*) = 4
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = schemas.nspowner
         and not privileges.is_grantable
         and (
           (privileges.grantee = schemas.nspowner
            and privileges.privilege_type in ('USAGE', 'CREATE'))
           or
           (privileges.grantee = worker_role.oid
            and privileges.privilege_type = 'USAGE')
           or
           (privileges.grantee = (
              select roles.oid from pg_catalog.pg_roles roles
               where roles.rolname = 'renave_app'
            ) and privileges.privilege_type = 'USAGE')
         )
       ), false)
      from pg_catalog.pg_namespace schemas
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        schemas.nspacl, pg_catalog.acldefault('n', schemas.nspowner)
      )) privileges
     where schemas.nspname = 'renave'
  ),
  worker_schema_acl_ready(ready) as (
    select pg_catalog.count(*) = 2
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = schemas.nspowner
         and privileges.privilege_type = 'USAGE'
         and not privileges.is_grantable
         and schemas.nspname in ('renave', 'renave_runtime')
       ), false)
      from pg_catalog.pg_namespace schemas
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        schemas.nspacl, pg_catalog.acldefault('n', schemas.nspowner)
      )) privileges
     where privileges.grantee = worker_role.oid
  ),
  runtime_schema_acl_ready(ready) as (
    select pg_catalog.count(*) = 6
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = schemas.nspowner
         and not privileges.is_grantable
         and (
           (privileges.grantee = schemas.nspowner
            and privileges.privilege_type in ('USAGE', 'CREATE'))
           or
           (privileges.grantee in (
              select roles.oid from pg_catalog.pg_roles roles
               where roles.rolname in (
                 'renave_app', 'renave_identity_app',
                 'renave_maintenance_app', 'renave_operation_worker'
               )
            ) and privileges.privilege_type = 'USAGE')
         )
       ), false)
      from pg_catalog.pg_namespace schemas
      cross join lateral pg_catalog.aclexplode(coalesce(
        schemas.nspacl, pg_catalog.acldefault('n', schemas.nspowner)
      )) privileges
     where schemas.nspname = 'renave_runtime'
  ),
  worker_function_acl_ready(ready) as (
    select pg_catalog.count(*) = 7
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
         and functions.oid = any (array[
           pg_catalog.to_regprocedure(
             'renave.claim_operation_reconciliation_leases(uuid,integer)'
           ),
           pg_catalog.to_regprocedure(
             'renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)'
           ),
           pg_catalog.to_regprocedure(
             'renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)'
           ),
           pg_catalog.to_regprocedure(
             'renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)'
           ),
           pg_catalog.to_regprocedure(
             'renave.complete_operation_reconciliation_confirmed(uuid,uuid,uuid,bigint,bigint,text)'
           ),
           pg_catalog.to_regprocedure(
             'renave.complete_operation_reconciliation_manual_review(uuid,uuid,uuid,bigint,text)'
           ),
           pg_catalog.to_regprocedure(
             'renave_runtime.operation_worker_contract_ready()'
           )
         ]::oid[])
       ), false)
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_namespace schemas
        on schemas.oid = functions.pronamespace
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
     where privileges.grantee = worker_role.oid
  ),
  worker_contract_acl_ready(ready) as (
    select pg_catalog.count(*) = 2
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
         and privileges.grantee in (functions.proowner, worker_role.oid)
       ), false)
      from pg_catalog.pg_proc functions
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
     where functions.oid = pg_catalog.to_regprocedure(
       'renave_runtime.operation_worker_contract_ready()'
     )
  ),
  zero_table_acl(ready) as (
    select pg_catalog.count(*) = 0
      from pg_catalog.pg_class tables
      join pg_catalog.pg_namespace schemas on schemas.oid = tables.relnamespace
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        tables.relacl, pg_catalog.acldefault(
          case
            when tables.relkind = 'S' then 'S'::"char"
            else 'r'::"char"
          end,
          tables.relowner
        )
      )) privileges
     where schemas.nspname = any (array[
       'renave', 'renave_identity', 'renave_directory',
       'renave_operations', 'renave_runtime'
     ]::text[])
       and privileges.grantee = worker_role.oid
  ),
  effective_function_privileges_ready(ready) as (
    -- pg_catalog e information_schema expõem rotinas inevitáveis do servidor.
    -- Nos schemas de aplicação acessíveis, o worker só chama as seis rotinas
    -- operacionais e seu wrapper fechado de atestação de contrato.
    select pg_catalog.count(*) = 7
       and coalesce(pg_catalog.bool_and(
         functions.oid = any (array[
           pg_catalog.to_regprocedure(
             'renave.claim_operation_reconciliation_leases(uuid,integer)'
           ),
           pg_catalog.to_regprocedure(
             'renave.renew_operation_reconciliation_lease(uuid,uuid,uuid,bigint)'
           ),
           pg_catalog.to_regprocedure(
             'renave.release_operation_reconciliation_lease(uuid,uuid,uuid,bigint,integer)'
           ),
           pg_catalog.to_regprocedure(
             'renave.begin_operation_reconciliation(uuid,uuid,uuid,bigint)'
           ),
           pg_catalog.to_regprocedure(
             'renave.complete_operation_reconciliation_confirmed(uuid,uuid,uuid,bigint,bigint,text)'
           ),
           pg_catalog.to_regprocedure(
             'renave.complete_operation_reconciliation_manual_review(uuid,uuid,uuid,bigint,text)'
           ),
           pg_catalog.to_regprocedure(
             'renave_runtime.operation_worker_contract_ready()'
           )
         ]::oid[])
       ), false)
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_namespace schemas
        on schemas.oid = functions.pronamespace
     where schemas.nspname !~ '^pg_'
       and schemas.nspname <> 'information_schema'
       and pg_catalog.has_schema_privilege(
         'renave_operation_worker', schemas.oid, 'USAGE'
       )
       and pg_catalog.has_function_privilege(
         'renave_operation_worker', functions.oid, 'EXECUTE'
       )
  ),
  zero_column_acl(ready) as (
    select pg_catalog.count(*) = 0
      from pg_catalog.pg_attribute columns
      join pg_catalog.pg_class tables on tables.oid = columns.attrelid
      join pg_catalog.pg_namespace schemas on schemas.oid = tables.relnamespace
      cross join worker_role
      cross join lateral pg_catalog.aclexplode(columns.attacl) privileges
     where columns.attnum > 0 and not columns.attisdropped
       and schemas.nspname = any (array[
         'renave', 'renave_identity', 'renave_directory',
         'renave_operations', 'renave_runtime'
       ]::text[])
       and privileges.grantee = worker_role.oid
  ),
  zero_membership(ready) as (
    select pg_catalog.count(*) = 0
      from pg_catalog.pg_auth_members memberships
      cross join worker_role
     where memberships.member = worker_role.oid
        or memberships.roleid = worker_role.oid
  ),
  exact_function_set(ready) as (
    select pg_catalog.count(*) = 6
      from pg_catalog.pg_proc functions
      join pg_catalog.pg_namespace schemas
        on schemas.oid = functions.pronamespace
     where schemas.nspname = 'renave'
       and functions.proname = any (array[
         'claim_operation_reconciliation_leases',
         'renew_operation_reconciliation_lease',
         'release_operation_reconciliation_lease',
         'begin_operation_reconciliation',
         'complete_operation_reconciliation_confirmed',
         'complete_operation_reconciliation_manual_review'
       ]::text[])
  )
  select ledger_ready.ready and fingerprint_ready.ready
     and functions_ready.ready and coalesce(worker_role.ready, false)
     and effective_schema_privileges_ready.ready
     and database_acl_ready.ready and function_acl_ready.ready
     and schema_acl_ready.ready and worker_schema_acl_ready.ready
     and runtime_schema_acl_ready.ready and worker_function_acl_ready.ready
     and effective_function_privileges_ready.ready
     and worker_contract_acl_ready.ready
     and zero_table_acl.ready and zero_column_acl.ready
     and zero_membership.ready and exact_function_set.ready
    from ledger_ready, fingerprint_ready, functions_ready, worker_role,
         effective_schema_privileges_ready, database_acl_ready,
         function_acl_ready, schema_acl_ready,
         worker_schema_acl_ready, runtime_schema_acl_ready,
         worker_function_acl_ready, effective_function_privileges_ready,
         worker_contract_acl_ready,
         zero_table_acl, zero_column_acl, zero_membership, exact_function_set
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;

create function renave_runtime.operation_worker_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select renave_runtime.api_contract_ready()
$$;

revoke all on function renave_runtime.operation_worker_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant usage on schema renave_runtime to renave_operation_worker;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
