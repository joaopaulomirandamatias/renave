-- 0087 — Contrato executável da projeção sanitizada de pendências.

alter function renave_runtime.api_contract_ready()
  rename to api_contract_ready_v0085;

revoke all on function renave_runtime.api_contract_ready_v0085()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.operation_pending_reader_contract_ready_v0087()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
select renave_runtime.api_contract_ready_v0085()
  and exists (select 1 from renave.schema_migrations
    where version = '0085_runtime_contract_stock_exit_local_replay'
      and checksum =
        '25531e62650ba73dfb398abf89711fde9d4746ab61cf1f81e4b47856e4d185db')
  and exists (select 1 from renave.schema_migrations
    where version = '0086_operation_pending_reader'
      and checksum =
        '2fefea5fe5aa2b6496112c0e0495ec8f75ea874bec4906b8d9cb61ba905b6b5f')
  and exists (select 1 from renave.schema_migrations
    where version = '0087_runtime_contract_operation_pending_reader')
  and (with expected(signature,result_type,body_hash) as (values
      ('renave_operation_reader.list_pending_operations(uuid,integer)',
       'TABLE(operation_id uuid, kind text, status text, reason_code text, correlation_id uuid, sent_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)',
       'a2f06532f133edaddf5ceeb86c27c848dd048503f223d22ddd9b23c3451ba2b8'),
      ('renave_operation_reader.get_operation_detail(uuid,uuid)',
       'TABLE(operation_id uuid, kind text, status text, reason_code text, correlation_id uuid, sent_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, version bigint, remote_record_id bigint, remote_state text, finalized_at timestamp with time zone)',
       '25a241822023952ca6045921281d8a90e621f4d2a85f823032ae7db0e6cca5a0'),
      ('renave_operation_reader.list_operation_timeline(uuid,uuid)',
       'TABLE(version bigint, previous_status text, status text, reason_code text, changed_at timestamp with time zone)',
       'bf3b17960f8f88679a8ce39e476a04305e6d6c19b04d3757b1ece3c9df209c79'))
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(owner.rolname = 'renave_migrator'
        and function_item.prosecdef
        and function_item.provolatile = 's'
        and function_item.prokind = 'f'
        and language_item.lanname = 'plpgsql'
        and function_item.proconfig = '{search_path=pg_catalog}'::text[]
        and function_item.proacl::text =
          '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'
        and pg_catalog.pg_get_function_result(function_item.oid) =
          expected.result_type
        and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          function_item.prosrc,'UTF8')),'hex') = expected.body_hash)
      from expected
      join pg_proc function_item
        on function_item.oid = pg_catalog.to_regprocedure(expected.signature)
      join pg_roles owner on owner.oid = function_item.proowner
      join pg_language language_item
        on language_item.oid = function_item.prolang)
  and (select owner.rolname = 'renave_migrator'
      from pg_namespace namespace_item
      join pg_roles owner on owner.oid = namespace_item.nspowner
     where namespace_item.nspname = 'renave_operation_reader')
  and has_schema_privilege(
    'renave_app','renave_operation_reader','USAGE')
  and not has_schema_privilege(
    'renave_app','renave_operation_reader','CREATE')
  and not has_schema_privilege(
    'renave_identity_app','renave_operation_reader','USAGE')
  and not has_schema_privilege(
    'renave_operation_worker','renave_operation_reader','USAGE')
  and not has_schema_privilege(
    'renave_operation_promoter','renave_operation_reader','USAGE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_operation_reader','USAGE')
  and not exists (
    select 1 from information_schema.table_privileges privilege
     where privilege.grantee = 'renave_app'
       and privilege.table_schema = 'renave'
       and privilege.table_name in (
         'operation','operation_outbox','operation_transition'))
  and has_function_privilege('renave_app',
    'renave_operation_reader.list_pending_operations(uuid,integer)','EXECUTE')
  and has_function_privilege('renave_app',
    'renave_operation_reader.get_operation_detail(uuid,uuid)','EXECUTE')
  and has_function_privilege('renave_app',
    'renave_operation_reader.list_operation_timeline(uuid,uuid)','EXECUTE')
  and not has_function_privilege('renave_identity_app',
    'renave_operation_reader.list_pending_operations(uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_operation_worker',
    'renave_operation_reader.list_pending_operations(uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_operation_promoter',
    'renave_operation_reader.list_pending_operations(uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_platform_reader',
    'renave_operation_reader.list_pending_operations(uuid,integer)','EXECUTE')
$$;

revoke all on function
  renave_runtime.operation_pending_reader_contract_ready_v0087()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$select renave_runtime.operation_pending_reader_contract_ready_v0087()$$;

revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;
