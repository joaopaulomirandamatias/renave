-- 0064 — Contrato fechado da fronteira global do console da integradora.

alter function renave_runtime.api_contract_ready()
  rename to vehicle_lookup_contract_ready_v0062;
revoke all on function renave_runtime.vehicle_lookup_contract_ready_v0062()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.platform_console_catalog_fingerprint_v0064()
returns text language sql stable security definer set search_path=pg_catalog as $$
select encode(sha256(convert_to(jsonb_build_object(
  'previous',renave_runtime.vehicle_lookup_catalog_fingerprint_v0062(),
  'schemas',coalesce((select jsonb_agg(jsonb_build_array(
      n.nspname,owner.rolname,coalesce(n.nspacl::text,'')) order by n.nspname)
    from pg_namespace n join pg_roles owner on owner.oid=n.nspowner
    where n.nspname='renave_platform'),'[]'::jsonb),
  'roles',coalesce((select jsonb_agg(jsonb_build_array(
      r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,
      r.rolcanlogin,r.rolreplication,r.rolbypassrls,
      has_database_privilege(r.rolname,current_database(),'CONNECT'),
      has_database_privilege(r.rolname,current_database(),'CREATE'),
      has_database_privilege(r.rolname,current_database(),'TEMPORARY'),
      coalesce(r.rolconfig::text,'')) order by r.rolname)
    from pg_roles r where r.rolname in
      ('renave_platform_reader','renave_platform_provisioner')),'[]'::jsonb),
  'memberships',coalesce((select jsonb_agg(jsonb_build_array(
      parent.rolname,member.rolname,m.admin_option,m.inherit_option,m.set_option)
      order by parent.rolname,member.rolname)
    from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
      join pg_roles member on member.oid=m.member
    where parent.rolname in
      ('renave_platform_reader','renave_platform_provisioner')
       or member.rolname in
      ('renave_platform_reader','renave_platform_provisioner')),'[]'::jsonb),
  'tables',coalesce((select jsonb_agg(jsonb_build_array(
      c.relname,c.relkind,c.relpersistence,c.relrowsecurity,
      c.relforcerowsecurity,owner.rolname,coalesce(c.relacl::text,''))
      order by c.relname,c.relkind)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles owner on owner.oid=c.relowner
    where n.nspname='renave_platform'),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(
      c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attisdropped,coalesce(a.attacl::text,''))
      order by c.relname,a.attnum)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum>0
    where n.nspname='renave_platform' and c.relkind in ('r','p')),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(
      c.relname,x.conname,x.contype,x.convalidated,
      pg_get_constraintdef(x.oid,false)) order by c.relname,x.conname)
    from pg_constraint x join pg_class c on c.oid=x.conrelid
      join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='renave_platform'),'[]'::jsonb),
  'indexes',coalesce((select jsonb_agg(jsonb_build_array(
      i.relname,t.relname,x.indisunique,x.indisvalid,x.indisready,
      pg_get_indexdef(i.oid)) order by i.relname)
    from pg_index x join pg_class i on i.oid=x.indexrelid
      join pg_class t on t.oid=x.indrelid
      join pg_namespace n on n.oid=i.relnamespace
    where n.nspname='renave_platform'),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(jsonb_build_array(
      source_schema.nspname,source_table.relname,t.tgname,t.tgenabled,
      t.tgtype,t.tgfoid::regprocedure::text) order by source_schema.nspname,
      source_table.relname,t.tgname)
    from pg_trigger t join pg_class source_table on source_table.oid=t.tgrelid
      join pg_namespace source_schema on source_schema.oid=source_table.relnamespace
      join pg_proc function_item on function_item.oid=t.tgfoid
      join pg_namespace function_schema on function_schema.oid=function_item.pronamespace
    where not t.tgisinternal and function_schema.nspname='renave_platform'),
    '[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_array(
      p.proname,pg_get_function_identity_arguments(p.oid),
      pg_get_function_result(p.oid),p.prosecdef,p.provolatile,p.prokind,
      language_item.lanname,owner.rolname,coalesce(p.proconfig::text,''),
      coalesce(p.proacl::text,''),
      encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))
      order by p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      join pg_roles owner on owner.oid=p.proowner
      join pg_language language_item on language_item.oid=p.prolang
    where n.nspname='renave_platform'),'[]'::jsonb)
)::text,'UTF8')),'hex')
$$;
revoke all on function
  renave_runtime.platform_console_catalog_fingerprint_v0064()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog as $$
select
  (select checksum='5f9ba7af04e9fdc8307accc4e16bf6d5001504b4ff20016d07ea0628117449b2'
    from renave.schema_migrations
    where version='0063_platform_operator_console')
  and renave_runtime.platform_console_catalog_fingerprint_v0064()=
    'a5c46b031ea30cd7671348eff6243f74491c33d19bdc053a79c1b987cba39012'
  and (select count(*)=2 and bool_and(
      not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb
      and rolcanlogin and not rolreplication and not rolbypassrls)
    from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner'))
  and has_database_privilege('renave_platform_reader',current_database(),'CONNECT')
  and not has_database_privilege('renave_platform_reader',current_database(),'CREATE')
  and not has_database_privilege('renave_platform_reader',current_database(),'TEMPORARY')
  and has_database_privilege('renave_platform_provisioner',current_database(),'CONNECT')
  and not has_database_privilege('renave_platform_provisioner',current_database(),'CREATE')
  and not has_database_privilege('renave_platform_provisioner',current_database(),'TEMPORARY')
  and not exists (select 1 from pg_auth_members m where m.member in
    (select oid from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner'))
    or m.roleid in (select oid from pg_roles where rolname in
      ('renave_platform_reader','renave_platform_provisioner')))
  and has_schema_privilege('renave_platform_reader','renave_platform','USAGE')
  and not has_schema_privilege('renave_platform_reader','renave_platform','CREATE')
  and has_schema_privilege('renave_platform_provisioner','renave_platform','USAGE')
  and not has_schema_privilege('renave_platform_provisioner','renave_platform','CREATE')
  and not has_schema_privilege('renave_platform_reader','renave','USAGE')
  and not has_schema_privilege('renave_platform_provisioner','renave','USAGE')
  and not exists (
    select 1 from information_schema.table_privileges privilege
    where privilege.grantee in
      ('renave_platform_reader','renave_platform_provisioner')
  )
  and has_function_privilege('renave_platform_reader',
    'renave_platform.list_credential_link_queue(bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_platform_reader',
    'renave_platform.grant_operator(bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_reader',
    'renave_platform.revoke_operator(bytea,bytea,bytea,inet,bytea)','EXECUTE')
  and has_function_privilege('renave_platform_provisioner',
    'renave_platform.grant_operator(bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea)','EXECUTE')
  and has_function_privilege('renave_platform_provisioner',
    'renave_platform.revoke_operator(bytea,bytea,bytea,inet,bytea)','EXECUTE')
  and not has_function_privilege('renave_platform_provisioner',
    'renave_platform.list_credential_link_queue(bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)','EXECUTE')
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_platform.contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_platform.contract_ready() from public,
  renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- A fronteira só abre depois que o contrato final existe. A 0063 isolada não
-- concede USAGE no schema nem EXECUTE em qualquer função operacional.
grant usage on schema renave_platform
  to renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_platform.grant_operator(
  bytea,timestamptz,timestamptz,bytea,bytea,inet,bytea),
  renave_platform.revoke_operator(bytea,bytea,bytea,inet,bytea)
to renave_platform_provisioner;
grant execute on function renave_platform.list_credential_link_queue(
  bytea,bytea,inet,bytea,integer,timestamptz,uuid,uuid,integer)
to renave_platform_reader;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
