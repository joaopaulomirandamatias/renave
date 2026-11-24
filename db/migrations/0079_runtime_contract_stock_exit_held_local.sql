-- 0079 — Contrato executável da fundação local de saída de estoque.

drop function renave_runtime.api_contract_ready();

create function renave_runtime.stock_exit_held_local_contract_ready_v0079()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
select
  (select checksum =
      '7e87ea91f9b60d36f9ef0bde26bc813fe6ee5e1ea1dead61b83f62298001d39a'
     from renave.schema_migrations
    where version = '0078_stock_exit_held_local')
  and renave_runtime.platform_console_access_contract_ready_v0077()
  and (select owner.rolname = 'renave_migrator'
      from pg_namespace namespace_item
      join pg_roles owner on owner.oid = namespace_item.nspowner
     where namespace_item.nspname = 'renave_stock_exit')
  and has_schema_privilege('renave_app','renave_stock_exit','USAGE')
  and not has_schema_privilege('renave_app','renave_stock_exit','CREATE')
  and not has_schema_privilege(
    'renave_operation_worker','renave_stock_exit','USAGE')
  and not has_schema_privilege(
    'renave_operation_promoter','renave_stock_exit','USAGE')
  and not has_schema_privilege(
    'renave_identity_app','renave_stock_exit','USAGE')
  and not has_schema_privilege(
    'renave_platform_reader','renave_stock_exit','USAGE')
  and (select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(owner.rolname = 'renave_migrator'
          and relation.relkind in ('r','p')
          and relation.relrowsecurity and relation.relforcerowsecurity)
      from pg_class relation
      join pg_namespace namespace_item
        on namespace_item.oid = relation.relnamespace
      join pg_roles owner on owner.oid = relation.relowner
     where namespace_item.nspname = 'renave_stock_exit'
       and relation.relkind in ('r','p'))
  and not exists (
    select 1 from pg_class relation
    join pg_namespace namespace_item
      on namespace_item.oid = relation.relnamespace
   where namespace_item.nspname = 'renave_stock_exit'
     and relation.relname like '%outbox%')
  and not exists (
    select 1 from information_schema.table_privileges privilege
     where privilege.table_schema = 'renave_stock_exit'
       and privilege.grantee <> 'renave_migrator')
  and (select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(policy.polcmd = '*'
          and pg_catalog.array_length(policy.polroles,1) = 1
          and policy.polroles[1] = 0)
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      join pg_namespace namespace_item
        on namespace_item.oid = relation.relnamespace
     where namespace_item.nspname = 'renave_stock_exit'
       and policy.polname in (
         'stock_exit_operation_isolation','stock_exit_transition_isolation'))
  and (select pg_catalog.count(*) = 21
        and pg_catalog.bool_and(constraint_item.convalidated)
      from pg_constraint constraint_item
      join pg_class relation on relation.oid = constraint_item.conrelid
      join pg_namespace namespace_item
        on namespace_item.oid = relation.relnamespace
     where namespace_item.nspname = 'renave_stock_exit')
  and (select pg_catalog.count(*) = 4
        and pg_catalog.bool_and(trigger_item.tgenabled = 'O'
          and function_item.oid =
            'renave_stock_exit.reject_change()'::regprocedure)
      from pg_trigger trigger_item
      join pg_class relation on relation.oid = trigger_item.tgrelid
      join pg_namespace namespace_item
        on namespace_item.oid = relation.relnamespace
      join pg_proc function_item on function_item.oid = trigger_item.tgfoid
     where namespace_item.nspname = 'renave_stock_exit'
       and not trigger_item.tgisinternal)
  and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schema',(select pg_catalog.jsonb_build_array(namespace_item.nspname,
          owner.rolname,coalesce(namespace_item.nspacl::text,''))
        from pg_namespace namespace_item join pg_roles owner
          on owner.oid=namespace_item.nspowner
        where namespace_item.nspname='renave_stock_exit'),
      'relations',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,relation.relkind,relation.relpersistence,
          relation.relrowsecurity,relation.relforcerowsecurity,owner.rolname,
          coalesce(relation.relacl::text,''))
          order by relation.relname,relation.relkind)
        from pg_class relation join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        join pg_roles owner on owner.oid=relation.relowner
        where namespace_item.nspname='renave_stock_exit'
          and relation.relkind in('r','S')),
      'columns',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,attribute.attnum,attribute.attname,
          pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
          attribute.attnotnull,attribute.attidentity,
          coalesce(pg_catalog.pg_get_expr(
            default_item.adbin,default_item.adrelid),''),
          coalesce(attribute.attacl::text,''))
          order by relation.relname,attribute.attnum)
        from pg_class relation join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        join pg_attribute attribute on attribute.attrelid=relation.oid
          and attribute.attnum>0 and not attribute.attisdropped
        left join pg_attrdef default_item on default_item.adrelid=relation.oid
          and default_item.adnum=attribute.attnum
        where namespace_item.nspname='renave_stock_exit'
          and relation.relkind='r'),
      'constraints',(select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(relation.relname,
            constraint_item.conname,constraint_item.contype,
            constraint_item.convalidated,pg_catalog.pg_get_constraintdef(
              constraint_item.oid,false))
          order by relation.relname,constraint_item.conname)
        from pg_constraint constraint_item join pg_class relation
          on relation.oid=constraint_item.conrelid
        join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        where namespace_item.nspname='renave_stock_exit'),
      'indexes',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,index_item.indexrelid::regclass::text,
          index_item.indisunique,index_item.indisprimary,index_item.indisvalid,
          index_item.indisready,pg_catalog.pg_get_indexdef(
            index_item.indexrelid))
          order by relation.relname,index_item.indexrelid::regclass::text)
        from pg_index index_item join pg_class relation
          on relation.oid=index_item.indrelid
        join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        where namespace_item.nspname='renave_stock_exit'),
      'policies',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,policy.polname,policy.polcmd,policy.polpermissive,
          policy.polroles::text,coalesce(pg_catalog.pg_get_expr(
            policy.polqual,policy.polrelid,false),''),
          coalesce(pg_catalog.pg_get_expr(
            policy.polwithcheck,policy.polrelid,false),''))
          order by relation.relname,policy.polname)
        from pg_policy policy join pg_class relation
          on relation.oid=policy.polrelid
        join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        where namespace_item.nspname='renave_stock_exit'),
      'triggers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,trigger_item.tgname,trigger_item.tgtype,
          trigger_item.tgenabled,trigger_item.tgfoid::regprocedure::text,
          pg_catalog.pg_get_triggerdef(trigger_item.oid,false))
          order by relation.relname,trigger_item.tgname)
        from pg_trigger trigger_item join pg_class relation
          on relation.oid=trigger_item.tgrelid
        join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        where namespace_item.nspname='renave_stock_exit'
          and not trigger_item.tgisinternal),
      'functions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          function_item.proname,pg_catalog.pg_get_function_identity_arguments(
            function_item.oid),pg_catalog.pg_get_function_result(
            function_item.oid),function_item.prosecdef,
          function_item.provolatile,function_item.prokind,language_item.lanname,
          owner.rolname,coalesce(function_item.proconfig::text,''),
          coalesce(function_item.proacl::text,''),
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            function_item.prosrc,'UTF8')),'hex'))
          order by function_item.proname,
            pg_catalog.pg_get_function_identity_arguments(function_item.oid))
        from pg_proc function_item join pg_namespace namespace_item
          on namespace_item.oid=function_item.pronamespace
        join pg_roles owner on owner.oid=function_item.proowner
        join pg_language language_item
          on language_item.oid=function_item.prolang
        where namespace_item.nspname='renave_stock_exit')
    )::text,'UTF8')),'hex') =
    '2d809bb99dfb19739f47e9ee4f663df2bb2308b73dcef605175af330351f2863'
  and (with expected(signature,body_hash,acl) as (values
      ('renave_stock_exit.reject_change()',
       'ace8a5f32b19e2a60fe869cc590f3d6aedb902f0b8a33cd2fb502f5af0b684a1',
       '{renave_migrator=X/renave_migrator}'),
      ('renave_stock_exit.get_operation_summary(uuid)',
       'eda1558f1784c7b6b7e273add8a4ac71ad47128ee14cbc136bbc8d1c53f908f0',
       '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'),
      ('renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
       '8d05e2283f67a3873c57058e8e85f7033553c8ddb2189e0fb32f0a648d62bfc4',
       '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'))
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(owner.rolname = 'renave_migrator'
        and function_item.proconfig = '{search_path=pg_catalog}'::text[]
        and function_item.proacl::text = expected.acl
        and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          function_item.prosrc,'UTF8')),'hex') = expected.body_hash)
    from expected
    join pg_proc function_item
      on function_item.oid = pg_catalog.to_regprocedure(expected.signature)
    join pg_roles owner on owner.oid = function_item.proowner)
  and (select function_item.prosecdef and function_item.provolatile = 'v'
      from pg_proc function_item
     where function_item.oid =
       'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)'::regprocedure)
  and (select function_item.prosecdef and function_item.provolatile = 's'
      from pg_proc function_item
     where function_item.oid =
       'renave_stock_exit.get_operation_summary(uuid)'::regprocedure)
  and has_function_privilege('renave_app',
    'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE')
  and has_function_privilege('renave_app',
    'renave_stock_exit.get_operation_summary(uuid)','EXECUTE')
  and not has_function_privilege('renave_operation_worker',
    'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE')
  and not has_function_privilege('renave_operation_promoter',
    'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE')
  and pg_catalog.strpos(pg_catalog.pg_get_functiondef(
    'renave_stock_exit.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint,bigint)'::regprocedure),
    'operation_outbox') = 0
$$;

revoke all on function
  renave_runtime.stock_exit_held_local_contract_ready_v0079()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$select renave_runtime.stock_exit_held_local_contract_ready_v0079()$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;

create or replace function renave_runtime.operation_promoter_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_promoter_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_promoter_contract_ready()
to renave_operation_promoter;
