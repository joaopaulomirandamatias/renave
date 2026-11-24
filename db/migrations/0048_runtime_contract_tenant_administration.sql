-- 0048 — Snapshot canônico do catálogo protegido após a administração.
-- A 0047 altera deliberadamente `renave`; um fingerprint novo substitui o
-- snapshot histórico sem perder detecção de drift nos schemas protegidos.

alter function renave_runtime.api_contract_ready()
  rename to identity_assurance_contract_ready_v0046;
revoke all on function renave_runtime.identity_assurance_contract_ready_v0046()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.tenant_administration_catalog_fingerprint_v0048()
returns text language sql stable security definer set search_path = pg_catalog
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'ledger', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(m.version, m.checksum) order by m.version
      ) from renave.schema_migrations m where m.version <
        '0048_runtime_contract_tenant_administration'), '[]'::jsonb),
      'schemas', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, r.rolname,
          coalesce(n.nspacl::text, '')) order by n.nspname
      ) from pg_catalog.pg_namespace n
        join pg_catalog.pg_roles r on r.oid = n.nspowner
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
      ), '[]'::jsonb),
      'classes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, c.relname, c.relkind,
          c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
          r.rolname, coalesce(c.relacl::text, ''))
        order by n.nspname, c.relname, c.relkind
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_roles r on r.oid = c.relowner
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
      ), '[]'::jsonb),
      'columns', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, c.relname, a.attnum,
          a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
          a.attnotnull, a.attisdropped, coalesce(a.attacl::text, ''))
        order by n.nspname, c.relname, a.attnum
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
         and c.relkind in ('r','p')), '[]'::jsonb),
      'constraints', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, c.relname, x.conname,
          x.contype, x.convalidated,
          pg_catalog.pg_get_constraintdef(x.oid, false))
        order by n.nspname, c.relname, x.conname
      ) from pg_catalog.pg_constraint x
        join pg_catalog.pg_class c on c.oid = x.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
      ), '[]'::jsonb),
      'indexes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, i.relname, t.relname,
          x.indisunique, x.indisvalid, x.indisready,
          pg_catalog.pg_get_indexdef(i.oid)) order by n.nspname, i.relname
      ) from pg_catalog.pg_index x
        join pg_catalog.pg_class i on i.oid = x.indexrelid
        join pg_catalog.pg_class t on t.oid = x.indrelid
        join pg_catalog.pg_namespace n on n.oid = i.relnamespace
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
      ), '[]'::jsonb),
      'policies', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, c.relname, p.polname,
          p.polcmd, p.polpermissive, p.polroles,
          pg_catalog.pg_get_expr(p.polqual, p.polrelid, false),
          pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false))
        order by n.nspname, c.relname, p.polname
      ) from pg_catalog.pg_policy p
        join pg_catalog.pg_class c on c.oid = p.polrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
      ), '[]'::jsonb),
      'triggers', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, c.relname, t.tgname,
          t.tgenabled, t.tgtype, t.tgdeferrable, t.tginitdeferred,
          t.tgattr::text, pg_catalog.pg_get_expr(t.tgqual, t.tgrelid, false),
          t.tgfoid::regprocedure::text)
        order by n.nspname, c.relname, t.tgname
      ) from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
         and not t.tgisinternal), '[]'::jsonb),
      'functions', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(n.nspname, p.proname,
          pg_catalog.pg_get_function_identity_arguments(p.oid),
          pg_catalog.pg_get_function_result(p.oid), p.prosecdef,
          p.provolatile, p.prokind, l.lanname, r.rolname,
          coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''),
          pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))
        order by n.nspname, p.proname,
          pg_catalog.pg_get_function_identity_arguments(p.oid)
      ) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_roles r on r.oid = p.proowner
        join pg_catalog.pg_language l on l.oid = p.prolang
       where n.nspname = any (array['renave','renave_identity',
         'renave_directory','renave_operations','renave_runtime']::text[])
         and p.proname !~ '(^api_contract_ready$|^operation_worker_contract_ready$|contract_ready|catalog_fingerprint)'
      ), '[]'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(r.rolname, r.rolsuper, r.rolinherit,
          r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication,
          r.rolbypassrls) order by r.rolname
      ) from pg_catalog.pg_roles r where r.rolname = any (array[
        'renave_migrator','renave_app','renave_identity_app',
        'renave_maintenance_app','renave_operation_worker']::text[])
      ), '[]'::jsonb),
      'memberships', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(role.rolname, member.rolname,
          membership.admin_option, membership.inherit_option,
          membership.set_option) order by role.rolname, member.rolname
      ) from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles role on role.oid = membership.roleid
        join pg_catalog.pg_roles member on member.oid = membership.member
       where role.rolname like 'renave_%' or member.rolname like 'renave_%'
      ), '[]'::jsonb)
    )::text, 'UTF8'
  )), 'hex')
$$;

revoke all on function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
  select
    (select migrations.checksum =
       '17bb1183852a899ec69cdb667c5869fe4d8596b9008baa98db91626ee8854dc8'
       from renave.schema_migrations migrations
      where migrations.version = '0047_tenant_administration')
    and renave_runtime.tenant_administration_catalog_fingerprint_v0048() =
      '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
    and (select pg_catalog.count(*) = 2
           and pg_catalog.bool_and(
             privilege.grantor = contract.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               contract.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_operation_worker')
             )
           )
          from pg_catalog.pg_proc contract
          cross join lateral pg_catalog.aclexplode(contract.proacl) privilege
         where contract.oid = pg_catalog.to_regprocedure(
           'renave_runtime.operation_worker_contract_ready()'
         ))
    and (select pg_catalog.count(*) = 3
           and pg_catalog.bool_and(
             privilege.grantor = contract.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               contract.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_app'),
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_identity_app')
             )
           )
          from pg_catalog.pg_proc contract
          cross join lateral pg_catalog.aclexplode(contract.proacl) privilege
         where contract.oid = pg_catalog.to_regprocedure(
           'renave_runtime.api_contract_ready()'
         ))
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
