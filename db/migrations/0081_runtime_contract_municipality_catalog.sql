-- Assinatura da estrutura nacional e dos privilégios. A disponibilidade
-- de dados é decidida por lookup_municipality, independentemente do boot.
grant usage on schema renave_reference to renave_app;
grant execute on function renave_reference.lookup_municipality(integer) to renave_app;

create function renave_runtime.municipality_catalog_contract_ready_v0081()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
select renave_runtime.stock_exit_held_local_contract_ready_v0079()
  and exists (select 1 from renave.schema_migrations
    where version = '0079_runtime_contract_stock_exit_held_local'
      and checksum = '3f48888ac17278b8794cd30db6ea8fa97d4ea5a8c739377e523055f9c6f6d614')
  and exists (select 1 from renave.schema_migrations
    where version = '0080_municipality_catalog'
      and checksum = 'bc800a8af9489bb305aa8067c979b7536a85ea71a2834662ae9671d7bce28de0')
  and exists (select 1 from renave.schema_migrations
    where version = '0081_runtime_contract_municipality_catalog')
  and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schema',(select pg_catalog.jsonb_build_array(namespace_item.nspname,
          owner.rolname,coalesce(namespace_item.nspacl::text,''))
        from pg_namespace namespace_item join pg_roles owner
          on owner.oid=namespace_item.nspowner
        where namespace_item.nspname='renave_reference'),
      'relations',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,relation.relkind,relation.relpersistence,
          relation.relrowsecurity,relation.relforcerowsecurity,owner.rolname,
          coalesce(relation.relacl::text,''))
          order by relation.relname,relation.relkind)
        from pg_class relation join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        join pg_roles owner on owner.oid=relation.relowner
        where namespace_item.nspname='renave_reference'
          and relation.relkind in('r','S','v')),
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
        where namespace_item.nspname='renave_reference'
          and relation.relkind in('r','v')),
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
        where namespace_item.nspname='renave_reference'),
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
        where namespace_item.nspname='renave_reference'),
      'views',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          c.relname,pg_catalog.pg_get_viewdef(c.oid,false),c.reloptions) order by c.relname)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='renave_reference' and c.relkind='v'),
      'sequences',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          c.relname,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
          order by c.relname)
        from pg_sequence s join pg_class c on c.oid = s.seqrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname='renave_reference'),
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
        where namespace_item.nspname='renave_reference'),
      'triggers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          relation.relname,trigger_item.tgname,trigger_item.tgtype,
          trigger_item.tgenabled,trigger_item.tgfoid::regprocedure::text,
          pg_catalog.pg_get_triggerdef(trigger_item.oid,false))
          order by relation.relname,trigger_item.tgname)
        from pg_trigger trigger_item join pg_class relation
          on relation.oid=trigger_item.tgrelid
        join pg_namespace namespace_item
          on namespace_item.oid=relation.relnamespace
        where namespace_item.nspname='renave_reference'
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
        where namespace_item.nspname='renave_reference')
    )::text,'UTF8')),'hex') =
    '192f5a873f0b49b37fa4235f033b6dcf39cc6cd31fdbe071da8531df31e34605'
$$;
revoke all on function renave_runtime.municipality_catalog_contract_ready_v0081() from public;

create or replace function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$select renave_runtime.municipality_catalog_contract_ready_v0081()$$;
