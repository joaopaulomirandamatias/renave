-- 0060 — Contrato do reader global e exclusivamente consultivo de perfis.

alter function renave_runtime.api_contract_ready()
  rename to profile_administration_contract_ready_v0058;
revoke all on function renave_runtime.profile_administration_contract_ready_v0058()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader;

create function renave_runtime.profile_reader_catalog_fingerprint_v0060()
returns text language sql stable security definer set search_path=pg_catalog
as $$
select encode(sha256(convert_to(jsonb_build_object(
  'profile_administration_current',
    renave_runtime.profile_administration_catalog_fingerprint_v0058(),
  'reader_role',coalesce((select jsonb_agg(jsonb_build_array(
      r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,
      r.rolcanlogin,r.rolreplication,r.rolbypassrls,coalesce(r.rolconfig::text,''))
      order by r.rolname)
    from pg_roles r where r.rolname='renave_profile_reader'),'[]'::jsonb),
  'profile_role_memberships',coalesce((select jsonb_agg(jsonb_build_array(
      parent.rolname,member.rolname,m.admin_option,m.inherit_option,m.set_option)
      order by parent.rolname,member.rolname)
    from pg_auth_members m
      join pg_roles parent on parent.oid=m.roleid
      join pg_roles member on member.oid=m.member
    where parent.rolname in ('renave_profile_provisioner','renave_profile_reader')
       or member.rolname in ('renave_profile_provisioner','renave_profile_reader')),'[]'::jsonb)
)::text,'UTF8')),'hex')
$$;
revoke all on function renave_runtime.profile_reader_catalog_fingerprint_v0060()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum='a8c66f647e5f96c8718f42b2b2cd0eebd0ba8f7baf7b93adc43ba72f11da6992'
     from renave.schema_migrations where version='0057_renave_profile_administration')
  and (select checksum='45d25c9b3bacc1e89feb20b450a84f942c59e05e2e1afed9ff84c62aecac949b'
     from renave.schema_migrations where version='0059_renave_profile_reader')
  and renave_runtime.profile_reader_catalog_fingerprint_v0060()=
    'e1e98938b80524248f8e557477c00adb59bea11678b8402e6c25e4f26ccca211'
  and (select count(*)=2 and bool_and(
        not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb
        and rolcanlogin and not rolreplication and not rolbypassrls)
      from pg_roles where rolname in
        ('renave_profile_provisioner','renave_profile_reader'))
  and has_database_privilege('renave_profile_provisioner',current_database(),'CONNECT')
  and not has_database_privilege('renave_profile_provisioner',current_database(),'CREATE')
  and not has_database_privilege('renave_profile_provisioner',current_database(),'TEMPORARY')
  and has_database_privilege('renave_profile_reader',current_database(),'CONNECT')
  and not has_database_privilege('renave_profile_reader',current_database(),'CREATE')
  and not has_database_privilege('renave_profile_reader',current_database(),'TEMPORARY')
  and not exists (
    select 1 from pg_auth_members membership
    where membership.member in (select oid from pg_roles where rolname in
      ('renave_profile_provisioner','renave_profile_reader'))
       or membership.roleid in (select oid from pg_roles where rolname in
      ('renave_profile_provisioner','renave_profile_reader'))
  )
  and has_schema_privilege('renave_profile_provisioner','renave_admin','USAGE')
  and not has_schema_privilege('renave_profile_provisioner','renave_admin','CREATE')
  and has_schema_privilege('renave_profile_reader','renave_admin','USAGE')
  and not has_schema_privilege('renave_profile_reader','renave_admin','CREATE')
  and not has_schema_privilege('renave_profile_provisioner','renave','USAGE')
  and not has_schema_privilege('renave_profile_reader','renave','USAGE')
  and not has_table_privilege('renave_profile_provisioner','renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner','renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner','renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_reader','renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_reader','renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_reader','renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and (select count(*)=8 and bool_and(
        role_owner.rolname='renave_migrator'
        and function_item.prosecdef
        and function_item.prokind='f'
        and language_item.lanname='plpgsql'
        and function_item.proconfig=array['search_path=pg_catalog']::text[]
        and (function_item.proname||'('||oidvectortypes(function_item.proargtypes)||')')=any(array[
          'assert_profile_provisioner()',
          'assert_profile_reader()',
          'stage_operator_pending(uuid, text, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'stage_establishment_pending(uuid, uuid, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'suspend_operator(uuid, text, bigint, bytea, text, bytea, text, bytea, text)',
          'suspend_establishment(uuid, uuid, bigint, bytea, text, bytea, text, bytea, text)',
          'get_operator_status(uuid, text)',
          'get_establishment_status(uuid, uuid)']::text[])
        and (select count(*)=case
              when function_item.proname in
                ('assert_profile_provisioner','assert_profile_reader') then 1
              else 2 end
             and bool_and(privilege.grantor=function_item.proowner
               and privilege.privilege_type='EXECUTE'
               and not privilege.is_grantable
               and (privilege.grantee=function_item.proowner
                 or (function_item.proname in
                       ('stage_operator_pending','stage_establishment_pending',
                        'suspend_operator','suspend_establishment')
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_profile_provisioner'))
                 or (function_item.proname in
                       ('get_operator_status','get_establishment_status')
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_profile_reader'))))
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
       and default_acl.defaclnamespace=0)
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
         and not privilege.is_grantable))
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
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
