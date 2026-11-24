-- 0058 — Contrato de catálogo dos perfis, resolver e administração segura.

alter function renave_runtime.api_contract_ready()
  rename to stock_entry_rate_limit_contract_ready_v0056;
revoke all on function renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;

-- Recompõe dinamicamente o catálogo introduzido por 0049–0056. A seleção é
-- fechada para que objetos de 0057 não alterem o snapshot histórico, enquanto
-- qualquer drift nos objetos protegidos continua mudando o hash.
create or replace function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select encode(sha256(convert_to(jsonb_build_object(
  'ledger',coalesce((select jsonb_agg(jsonb_build_array(m.version,m.checksum) order by m.version)
    from renave.schema_migrations m where m.version between
      '0049_held_local_operation' and '0055_stock_entry_rate_limit'),'[]'::jsonb),
  'schemas',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,r.rolname,coalesce(n.nspacl::text,'')) order by n.nspname)
    from pg_namespace n join pg_roles r on r.oid=n.nspowner
    where n.nspname in ('renave','renave_runtime')),'[]'::jsonb),
  'classes',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,r.rolname,coalesce(c.relacl::text,'')) order by n.nspname,c.relname,c.relkind)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
    where (n.nspname='renave' and c.relname=any(array[
      'operation','operation_active_vehicle_family_key',
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'operator_identity_profile_history_timeline_idx',
      'establishment_renave_profile_history_timeline_idx']::text[]))
      or (n.nspname='renave_runtime' and c.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation','stock_entry_rate_bucket_last_seen_idx']::text[]))),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attisdropped,coalesce(a.attacl::text,'')) order by n.nspname,c.relname,a.attnum)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0
    where (n.nspname='renave' and c.relname=any(array[
      'operation','operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history']::text[]))
      or (n.nspname='renave_runtime' and c.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation']::text[]))),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,x.conname,x.contype,x.convalidated,pg_get_constraintdef(x.oid,false)) order by n.nspname,c.relname,x.conname)
    from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='renave' and c.relname=any(array[
      'operation','operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history']::text[]))
      or (n.nspname='renave_runtime' and c.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation']::text[]))),'[]'::jsonb),
  'indexes',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,i.relname,t.relname,x.indisunique,x.indisvalid,x.indisready,pg_get_indexdef(i.oid)) order by n.nspname,i.relname)
    from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=i.relnamespace
    where (n.nspname='renave' and t.relname=any(array[
      'operation','operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history']::text[]))
      or (n.nspname='renave_runtime' and t.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation']::text[]))),'[]'::jsonb),
  'policies',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid,false),pg_get_expr(p.polwithcheck,p.polrelid,false)) order by n.nspname,c.relname,p.polname)
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='renave' and c.relname=any(array[
      'operation','operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history']::text[]))
      or (n.nspname='renave_runtime' and c.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation']::text[]))),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred,t.tgattr::text,pg_get_expr(t.tgqual,t.tgrelid,false),t.tgfoid::regprocedure::text) order by n.nspname,c.relname,t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and ((n.nspname='renave' and c.relname=any(array[
      'operation','operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history']::text[]))
      or (n.nspname='renave_runtime' and c.relname=any(array[
      'stock_entry_rate_policy','stock_entry_rate_bucket',
      'stock_entry_runtime_key_generation']::text[])))),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.prosecdef,p.provolatile,p.prokind,l.lanname,r.rolname,coalesce(p.proconfig::text,''),coalesce(p.proacl::text,''),encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
    where (n.nspname='renave' and p.proname=any(array[
      'operation_guard','create_held_local_operation',
      'operator_identity_profile_guard','establishment_renave_profile_guard',
      'operator_identity_profile_record_history','establishment_renave_profile_record_history',
      'renave_profile_history_reject_change','get_operator_identity_profile_status',
      'get_establishment_renave_profile_status','resolve_verified_renave_principals']::text[]))
      or (n.nspname='renave_runtime' and p.proname=any(array[
      'reject_stock_entry_runtime_key_rotation','matches_stock_entry_runtime_key_generation',
      'consume_stock_entry_rate_limit']::text[]))),'[]'::jsonb)
)::text,'UTF8')),'hex')
$$;
revoke all on function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;

create or replace function renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum='1f147534dbef86ead03aeb30f93515e6cd8454283ae5032ed37f6a2e62979dcc'
     from renave.schema_migrations where version='0055_stock_entry_rate_limit')
  and renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()=
    'd5226c15ac4b48dbf8fb60c0d448f30f8d5af98ed56cf9f561d09f25d8b36d9a'
  and (select count(*)=2 and bool_and(
        privilege.grantor=limiter.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (limiter.proowner,
          (select oid from pg_roles where rolname='renave_app')))
      from pg_proc limiter cross join lateral aclexplode(limiter.proacl) privilege
      where limiter.oid=to_regprocedure('renave_runtime.consume_stock_entry_rate_limit(bytea,bytea)'))
  and (select count(*)=2 and bool_and(
        privilege.grantor=generation_match.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (generation_match.proowner,
          (select oid from pg_roles where rolname='renave_app')))
      from pg_proc generation_match cross join lateral aclexplode(generation_match.proacl) privilege
      where generation_match.oid=to_regprocedure('renave_runtime.matches_stock_entry_runtime_key_generation(text,bytea)'))
  and (select count(*)=2 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_operation_worker')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.operation_worker_contract_ready()'))
  and (select count(*)=3 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_app'),
          (select oid from pg_roles where rolname='renave_identity_app')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.api_contract_ready()'))
$$;
revoke all on function renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;

create function renave_runtime.profile_administration_catalog_fingerprint_v0058()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select encode(sha256(convert_to(jsonb_build_object(
  'protected_catalog',renave_runtime.tenant_administration_catalog_fingerprint_v0048(),
  'legacy_0049_0056',renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056(),
  'schemas',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,r.rolname,coalesce(n.nspacl::text,'')) order by n.nspname)
    from pg_namespace n join pg_roles r on r.oid=n.nspowner
    where n.nspname in ('renave','renave_admin')),'[]'::jsonb),
  'classes',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,r.rolname,coalesce(c.relacl::text,'')) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
    where n.nspname='renave' and c.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger','operator_identity_profile_pkey',
      'establishment_renave_profile_pkey','profile_administration_ledger_pkey',
      'profile_administration_ledger_provider_assertion_digest_key',
      'profile_administration_ledger_target_idx']::text[])),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attisdropped,coalesce(a.attacl::text,'')) order by n.nspname,c.relname,a.attnum)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0
    where n.nspname='renave' and c.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger']::text[])),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,x.conname,x.contype,x.convalidated,pg_get_constraintdef(x.oid,false)) order by n.nspname,c.relname,x.conname)
    from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='renave' and c.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger']::text[])),'[]'::jsonb),
  'indexes',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,i.relname,t.relname,x.indisunique,x.indisvalid,x.indisready,pg_get_indexdef(i.oid)) order by n.nspname,i.relname)
    from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=i.relnamespace
    where n.nspname='renave' and t.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger']::text[])),'[]'::jsonb),
  'policies',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid,false),pg_get_expr(p.polwithcheck,p.polrelid,false)) order by n.nspname,c.relname,p.polname)
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='renave' and c.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger']::text[])),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred,t.tgattr::text,pg_get_expr(t.tgqual,t.tgrelid,false),t.tgfoid::regprocedure::text) order by n.nspname,c.relname,t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='renave' and c.relname=any(array[
      'operator_identity_profile','establishment_renave_profile',
      'operator_identity_profile_history','establishment_renave_profile_history',
      'profile_administration_ledger']::text[])),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.prosecdef,p.provolatile,p.prokind,l.lanname,r.rolname,coalesce(p.proconfig::text,''),coalesce(p.proacl::text,''),encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
    where (n.nspname='renave' and p.proname=any(array[
      'operator_identity_profile_guard','establishment_renave_profile_guard',
      'operator_identity_profile_record_history','establishment_renave_profile_record_history',
      'renave_profile_history_reject_change','get_operator_identity_profile_status',
      'get_establishment_renave_profile_status','resolve_verified_renave_principals',
      'profile_administration_ledger_reject_change']::text[]))
       or n.nspname='renave_admin'),'[]'::jsonb),
  'role',coalesce((select jsonb_agg(jsonb_build_array(r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,coalesce(r.rolconfig::text,'')) order by r.rolname)
    from pg_roles r where r.rolname='renave_profile_provisioner'),'[]'::jsonb)
)::text,'UTF8')),'hex')
$$;

revoke all on function renave_runtime.profile_administration_catalog_fingerprint_v0058()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
  and (select checksum='0e305b1d30e1526dd019a295bb7dc56687e6ff8b0ed8444c05a383e98ce0549f' from renave.schema_migrations where version='0051_verified_renave_profiles')
  and (select checksum='0b85d8e3e0956de568b5caed308bb6527d271e3ed2be40862b50d373d382a48d' from renave.schema_migrations where version='0053_verified_renave_principal_resolution')
  and (select checksum='a8c66f647e5f96c8718f42b2b2cd0eebd0ba8f7baf7b93adc43ba72f11da6992' from renave.schema_migrations where version='0057_renave_profile_administration')
  and renave_runtime.profile_administration_catalog_fingerprint_v0058()='9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
  and (select not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb
              and rolcanlogin and not rolreplication and not rolbypassrls
         from pg_roles where rolname='renave_profile_provisioner')
  and not has_schema_privilege('renave_profile_provisioner','renave','USAGE')
  and not has_table_privilege('renave_profile_provisioner','renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner','renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner','renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and (select count(*)=7 and bool_and(
        role_owner.rolname='renave_migrator'
        and function_item.prosecdef
        and function_item.prokind='f'
        and language_item.lanname='plpgsql'
        and function_item.proconfig=array['search_path=pg_catalog']::text[]
        and (function_item.proname||'('||oidvectortypes(function_item.proargtypes)||')')=any(array[
          'assert_profile_provisioner()',
          'stage_operator_pending(uuid, text, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'stage_establishment_pending(uuid, uuid, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'suspend_operator(uuid, text, bigint, bytea, text, bytea, text, bytea, text)',
          'suspend_establishment(uuid, uuid, bigint, bytea, text, bytea, text, bytea, text)',
          'get_operator_status(uuid, text)',
          'get_establishment_status(uuid, uuid)']::text[])
        and (select count(*)=case when function_item.proname='assert_profile_provisioner' then 1 else 2 end
               and bool_and(privilege.grantor=function_item.proowner
                 and privilege.privilege_type='EXECUTE'
                 and not privilege.is_grantable
                 and (privilege.grantee=function_item.proowner
                   or (function_item.proname<>'assert_profile_provisioner'
                     and privilege.grantee=(select oid from pg_roles where rolname='renave_profile_provisioner'))))
              from aclexplode(function_item.proacl) privilege)
      ) from pg_proc function_item
        join pg_namespace function_schema on function_schema.oid=function_item.pronamespace
        join pg_roles role_owner on role_owner.oid=function_item.proowner
        join pg_language language_item on language_item.oid=function_item.prolang
      where function_schema.nspname='renave_admin')
  and (select count(*)=1 and bool_and(
          privilege.grantor=default_acl.defaclrole
          and privilege.grantee=default_acl.defaclrole
          and privilege.privilege_type='EXECUTE'
          and not privilege.is_grantable)
    from pg_default_acl default_acl
      join pg_roles default_owner on default_owner.oid=default_acl.defaclrole
      cross join lateral aclexplode(default_acl.defaclacl) privilege
     where default_owner.rolname='renave_migrator'
       and default_acl.defaclobjtype='f'
       and default_acl.defaclnamespace=0
  )
  and not exists (
    select 1 from pg_default_acl default_acl
      join pg_roles default_owner on default_owner.oid=default_acl.defaclrole
      left join pg_namespace default_schema on default_schema.oid=default_acl.defaclnamespace
      cross join lateral aclexplode(default_acl.defaclacl) privilege
     where default_owner.rolname='renave_migrator'
       and default_acl.defaclobjtype='f'
       and (default_acl.defaclnamespace=0 or default_schema.nspname='renave_admin')
       and not (privilege.grantor=default_acl.defaclrole
         and privilege.grantee=default_acl.defaclrole
         and privilege.privilege_type='EXECUTE'
         and not privilege.is_grantable)
  )
  and (select count(*)=3 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_app'),
          (select oid from pg_roles where rolname='renave_identity_app')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.api_contract_ready()'))
  and (select count(*)=2 and bool_and(
        privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (contract.proowner,
          (select oid from pg_roles where rolname='renave_operation_worker')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.operation_worker_contract_ready()'))
$$;

revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
