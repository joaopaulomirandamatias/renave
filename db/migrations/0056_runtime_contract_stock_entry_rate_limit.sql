-- 0056 — Contrato de runtime do limite distribuído de entrada de estoque.

alter function renave_runtime.api_contract_ready()
  rename to renave_principal_resolution_contract_ready_v0054;
revoke all on function
  renave_runtime.renave_principal_resolution_contract_ready_v0054()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
returns text language sql stable security definer set search_path = pg_catalog
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'previous', renave_runtime
        .renave_principal_resolution_catalog_fingerprint_v0054(),
      'classes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, c.relkind,
          c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
          r.rolname, coalesce(c.relacl::text, '')) order by c.relname
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_roles r on r.oid = c.relowner
       where n.nspname = 'renave_runtime'
         and c.relname = any (array[
           'stock_entry_rate_policy', 'stock_entry_rate_bucket',
           'stock_entry_runtime_key_generation',
           'stock_entry_rate_bucket_last_seen_idx']::text[])
      ), '[]'::jsonb),
      'columns', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, a.attnum, a.attname,
          pg_catalog.format_type(a.atttypid, a.atttypmod),
          a.attnotnull, a.attisdropped, coalesce(a.attacl::text, ''))
        order by c.relname, a.attnum
      ) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0
       where n.nspname = 'renave_runtime'
         and c.relname = any (array[
           'stock_entry_rate_policy', 'stock_entry_rate_bucket',
           'stock_entry_runtime_key_generation']::text[])
      ), '[]'::jsonb),
      'constraints', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, x.conname, x.contype,
          x.convalidated, pg_catalog.pg_get_constraintdef(x.oid, false))
        order by c.relname, x.conname
      ) from pg_catalog.pg_constraint x
        join pg_catalog.pg_class c on c.oid = x.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'renave_runtime'
         and c.relname = any (array[
           'stock_entry_rate_policy', 'stock_entry_rate_bucket',
           'stock_entry_runtime_key_generation']::text[])
      ), '[]'::jsonb),
      'indexes', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(i.relname, t.relname, x.indisunique,
          x.indisvalid, x.indisready, pg_catalog.pg_get_indexdef(i.oid))
        order by i.relname
      ) from pg_catalog.pg_index x
        join pg_catalog.pg_class i on i.oid = x.indexrelid
        join pg_catalog.pg_class t on t.oid = x.indrelid
        join pg_catalog.pg_namespace n on n.oid = i.relnamespace
       where n.nspname = 'renave_runtime'
         and t.relname = any (array[
           'stock_entry_rate_policy', 'stock_entry_rate_bucket',
           'stock_entry_runtime_key_generation']::text[])
      ), '[]'::jsonb),
      'triggers', coalesce((select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(c.relname, t.tgname, t.tgenabled,
          t.tgtype, t.tgdeferrable, t.tginitdeferred, t.tgattr::text,
          pg_catalog.pg_get_expr(t.tgqual, t.tgrelid, false),
          t.tgfoid::regprocedure::text) order by t.tgname
      ) from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'renave_runtime'
         and c.relname = 'stock_entry_runtime_key_generation'
         and not t.tgisinternal
      ), '[]'::jsonb),
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
       where n.nspname = 'renave_runtime'
         and p.proname = any (array[
           'consume_stock_entry_rate_limit',
           'matches_stock_entry_runtime_key_generation',
           'reject_stock_entry_runtime_key_rotation']::text[])
      ), '[]'::jsonb)
    )::text, 'UTF8'
  )), 'hex')
$$;

revoke all on function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path = pg_catalog
as $$
  select
    (select migrations.checksum =
       '1f147534dbef86ead03aeb30f93515e6cd8454283ae5032ed37f6a2e62979dcc'
       from renave.schema_migrations migrations
      where migrations.version = '0055_stock_entry_rate_limit')
    and renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056() =
      '897a6e253a32b4f6a43996a590132f94557cfe4d2505c75781a535cc611e9a22'
    and (select pg_catalog.count(*) = 2
           and pg_catalog.bool_and(
             privilege.grantor = limiter.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               limiter.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_app')
             )
           )
          from pg_catalog.pg_proc limiter
          cross join lateral pg_catalog.aclexplode(limiter.proacl) privilege
         where limiter.oid = pg_catalog.to_regprocedure(
           'renave_runtime.consume_stock_entry_rate_limit(bytea,bytea)'
         ))
    and (select pg_catalog.count(*) = 2
           and pg_catalog.bool_and(
             privilege.grantor = generation_match.proowner
             and privilege.privilege_type = 'EXECUTE'
             and not privilege.is_grantable
             and privilege.grantee in (
               generation_match.proowner,
               (select roles.oid from pg_catalog.pg_roles roles
                 where roles.rolname = 'renave_app')
             )
           )
          from pg_catalog.pg_proc generation_match
          cross join lateral
            pg_catalog.aclexplode(generation_match.proacl) privilege
         where generation_match.oid = pg_catalog.to_regprocedure(
           'renave_runtime.matches_stock_entry_runtime_key_generation(text,bytea)'
         ))
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
