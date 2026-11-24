-- 0046 — Vincula o runtime à persistência de garantia OIDC da sessão.

alter function renave_runtime.api_contract_ready()
  rename to reconciliation_projection_preflight_contract_ready_v0044;
revoke all on function
  renave_runtime.reconciliation_projection_preflight_contract_ready_v0044()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with ledger_ready(ready) as (
    select pg_catalog.count(*) = 1
       and coalesce(pg_catalog.bool_and(
         migrations.checksum =
           '7a4cc80ab2e82fd2127d075dbe9a80a5ac4afa66d70ada6dc95f60ac5751c05a'
       ), false)
      from renave.schema_migrations migrations
     where migrations.version = '0045_identity_authentication_assurance'
  ),
  columns_ready(ready) as (
    select pg_catalog.count(*) = 2
       and coalesce(pg_catalog.bool_and(
         case columns.column_name
           when 'authentication_context' then
             columns.data_type = 'text'
             and columns.is_nullable = 'YES'
             and columns.column_default is null
           when 'mfa_verified_at_login' then
             columns.data_type = 'boolean'
             and columns.is_nullable = 'NO'
             and columns.column_default = 'false'
           else false
         end
       ), false)
      from information_schema.columns columns
     where columns.table_schema = 'renave_identity'
       and columns.table_name = 'auth_session'
       and columns.column_name in (
         'authentication_context', 'mfa_verified_at_login'
       )
  ),
  expected_constraints(name, definition_hash) as (
    values
      (
        'auth_session_authentication_context_valid',
        '7053cd33f4c6c9c22e1db94e91942a7f9077e1c559130f2a1d92c99f1110a412'
      ),
      (
        'auth_session_mfa_snapshot_context_valid',
        '21c2d8c0db826d60036ebbb1b4d3c0761d71e371fd9326003b7016b0ff95a24a'
      )
  ),
  constraints_ready(ready) as (
    select pg_catalog.count(constraints.oid) = 2
       and coalesce(pg_catalog.bool_and(
         constraints.contype = 'c' and constraints.convalidated
         and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_constraintdef(constraints.oid, false), 'UTF8'
         )), 'hex') = expected_constraints.definition_hash
       ), false)
      from expected_constraints
      left join pg_catalog.pg_constraint constraints
        on constraints.conname = expected_constraints.name
       and constraints.conrelid = 'renave_identity.auth_session'::regclass
  ),
  expected_functions(signature, result_type, volatility, body_hash) as (
    values
      (
        'renave_identity.save_auth_session(text,text,text,text,text[],text,boolean,bigint,bigint,bigint,bigint)',
        'void',
        'v',
        'ed70078cbc22dc2f13825a4c19483ccb731597eed9a3a35c19b403411d533adc'
      ),
      (
        'renave_identity.get_auth_session(text,bigint)',
        'TABLE(subject text, display_name text, email text, roles text[], authentication_context text, mfa_verified_at_login boolean, created_at_ms bigint, last_seen_at_ms bigint, idle_expires_at_ms bigint, absolute_expires_at_ms bigint)',
        's',
        'fa549b2bb42f9ba95527f2d6ea8bca75ad1e869b774a13e2755b3c75dc66c0bd'
      )
  ),
  functions_ready(ready) as (
    select pg_catalog.count(functions.oid) = 2
       and coalesce(pg_catalog.bool_and(
         functions.prosecdef
         and functions.prokind = 'f'
         and functions.provolatile = expected_functions.volatility
         and functions.proconfig = array['search_path=pg_catalog']::text[]
         and functions.probin is null
         and owners.rolname = 'renave_migrator'
         and languages.lanname = 'sql'
         and pg_catalog.pg_get_function_result(functions.oid) =
           expected_functions.result_type
         and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           functions.prosrc, 'UTF8'
         )), 'hex') = expected_functions.body_hash
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
  identity_role(oid) as (
    select roles.oid from pg_catalog.pg_roles roles
     where roles.rolname = 'renave_identity_app'
  ),
  function_acl_ready(ready) as (
    select pg_catalog.count(*) = 4
       and coalesce(pg_catalog.bool_and(
         privileges.grantor = functions.proowner
         and privileges.privilege_type = 'EXECUTE'
         and not privileges.is_grantable
         and privileges.grantee in (functions.proowner, identity_role.oid)
       ), false)
      from expected_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
      cross join identity_role
      cross join lateral pg_catalog.aclexplode(coalesce(
        functions.proacl, pg_catalog.acldefault('f', functions.proowner)
      )) privileges
  ),
  effective_acl_ready(ready) as (
    select coalesce(pg_catalog.bool_and(
      pg_catalog.has_function_privilege(
        'renave_identity_app', functions.oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'renave_app', functions.oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'public', functions.oid, 'EXECUTE'
      )
    ), false)
      from expected_functions
      join pg_catalog.pg_proc functions
        on functions.oid = pg_catalog.to_regprocedure(
          expected_functions.signature
        )
  ),
  old_signature_absent(ready) as (
    select pg_catalog.to_regprocedure(
      'renave_identity.save_auth_session(text,text,text,text,text[],bigint,bigint,bigint,bigint)'
    ) is null
    and pg_catalog.to_regprocedure(
      'renave_identity.save_auth_session(text,text,text,text,text[],text,bigint,bigint,bigint,bigint)'
    ) is null
  )
  select
    renave_runtime.reconciliation_projection_preflight_contract_ready_v0044()
    and ledger_ready.ready and columns_ready.ready and constraints_ready.ready
    and functions_ready.ready and function_acl_ready.ready
    and effective_acl_ready.ready and old_signature_absent.ready
    from ledger_ready, columns_ready, constraints_ready, functions_ready,
         function_acl_ready, effective_acl_ready, old_signature_absent
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
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
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
