-- 0085 — Reancora barreiras e replay local da saída, sem capacidade de envio.

create function renave_stock_exit_barriers.contract_fingerprint_v0085()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select encode(sha256(convert_to(jsonb_build_object(
  'schema',(select jsonb_build_array(n.nspname,r.rolname,coalesce(n.nspacl::text,''))
    from pg_namespace n join pg_roles r on r.oid=n.nspowner
    where n.nspname='renave_stock_exit_barriers'),
  'classes',coalesce((select jsonb_agg(jsonb_build_array(c.relname,c.relkind,
      c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,r.rolname,
      coalesce(c.relacl::text,'')) order by c.relname,c.relkind)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_roles r on r.oid=c.relowner
    where n.nspname='renave_stock_exit_barriers'
      and c.relkind in('r','S','v','i')),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(c.relname,a.attnum,
      a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
      coalesce(pg_get_expr(d.adbin,d.adrelid),''),coalesce(a.attacl::text,''))
      order by c.relname,a.attnum)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='renave_stock_exit_barriers' and c.relkind in('r','v')),
    '[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(c.relname,x.conname,
      x.contype,x.convalidated,pg_get_constraintdef(x.oid,false))
      order by c.relname,x.conname)
    from pg_constraint x join pg_class c on c.oid=x.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='renave_stock_exit_barriers'),'[]'::jsonb),
  'indexes',coalesce((select jsonb_agg(jsonb_build_array(i.relname,t.relname,
      x.indisunique,x.indisprimary,x.indisvalid,x.indisready,pg_get_indexdef(i.oid))
      order by i.relname)
    from pg_index x join pg_class i on i.oid=x.indexrelid
    join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=i.relnamespace
    where n.nspname='renave_stock_exit_barriers'),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_array(p.proname,
      pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),
      p.prosecdef,p.provolatile,p.prokind,l.lanname,r.rolname,
      coalesce(p.proconfig::text,''),coalesce(p.proacl::text,''),
      encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))
      order by p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
    where n.nspname='renave_stock_exit_barriers'
      and p.proname !~ '^contract_'),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(jsonb_build_array(c.relname,t.tgname,
      t.tgenabled,t.tgtype,t.tgfoid::regprocedure::text,
      pg_get_triggerdef(t.oid,false)) order by c.relname,t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='renave_stock_exit_barriers' and not t.tgisinternal),
    '[]'::jsonb)
)::text,'UTF8')),'hex')
$$;

revoke all on function renave_stock_exit_barriers.contract_fingerprint_v0085()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_operation_promoter;

create or replace function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.municipality_catalog_contract_ready_v0081()
  and (select checksum='6eca702b276c3029f48c8c84ccbc2f7bbae53fa89e871d3f5e861146357dd854'
    from renave.schema_migrations where version='0082_stock_exit_runtime_barriers')
  and (select checksum='169b66a413743a1248037b3ccbe68c8f30312111f42646e00d632a529da9ab9c'
    from renave.schema_migrations where version='0083_runtime_contract_stock_exit_barriers')
  and (select checksum='1b5a4765b9558f0e602a728c4144097eabe058424e4ae09ca1219ab99cf928b3'
    from renave.schema_migrations where version='0084_stock_exit_local_replay')
  and exists(select 1 from renave.schema_migrations
    where version='0085_runtime_contract_stock_exit_local_replay')
  and renave_stock_exit_barriers.contract_fingerprint_v0085()=
    '259946343661a097e810f30aa8c6964af8165bfecaba2cf122805b09b951bffd'
  and (select owner.rolname='renave_migrator' and p.prosecdef
      and p.provolatile='s'
      and p.proconfig='{search_path=pg_catalog}'::text[]
      and p.proacl::text='{renave_migrator=X/renave_migrator}'
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=
        'e83d5b0967cb42654d7feb2cb8ee7d2b7fbaa9c086bf5dd81acb31aa4144de41'
    from pg_proc p join pg_roles owner on owner.oid=p.proowner
    where p.oid=
      'renave_stock_exit_barriers.contract_fingerprint_v0085()'::regprocedure)
  and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('renave_stock_exit','renave_stock_exit_barriers')
      and c.relname~'(outbox|dispatch|claim|send)')
  and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='renave_stock_exit_barriers'
      and p.proname~'(outbox|dispatch|claim|send|promot|worker)')
  and not has_schema_privilege('renave_operation_worker','renave_stock_exit_barriers','USAGE')
  and not has_schema_privilege('renave_operation_promoter','renave_stock_exit_barriers','USAGE')
$$;
