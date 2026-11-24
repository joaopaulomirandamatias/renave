-- 0071 — Âncora executável do gate de jurisdição e natureza de serviço.

alter function renave_runtime.api_contract_ready()
  rename to credential_service_scope_incomplete_v0070;
revoke all on function
  renave_runtime.credential_service_scope_incomplete_v0070()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select relrowsecurity and relforcerowsecurity from pg_class
    where oid='renave.establishment_regulatory_jurisdiction'::regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_class
    where oid='renave.establishment_regulatory_jurisdiction_history'::regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_class
    where oid='renave.credential_service_scope'::regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_class
    where oid='renave.credential_service_scope_history'::regclass)
  and (select pg_get_constraintdef(oid,true)=
        'PRIMARY KEY (tenant_id, establishment_id, jurisdiction_uf)'
    from pg_constraint where conrelid=
      'renave.establishment_regulatory_jurisdiction'::regclass
      and conname='establishment_regulatory_jurisdiction_pkey')
  and (select pg_get_constraintdef(oid,true)=
        'PRIMARY KEY (tenant_id, establishment_id, service_nature, jurisdiction_uf)'
    from pg_constraint where conrelid='renave.credential_service_scope'::regclass
      and conname='credential_service_scope_pkey')
  and (select position('''PA''' in pg_get_constraintdef(oid,true))>0
              and position('''BR''' in pg_get_constraintdef(oid,true))=0
              and position('''*''' in pg_get_constraintdef(oid,true))=0
    from pg_constraint where conrelid=
      'renave.establishment_regulatory_jurisdiction'::regclass
      and conname='establishment_regulatory_jurisdiction_uf_valid')
  and has_table_privilege('renave_app',
    'renave.establishment_regulatory_jurisdiction','SELECT')
  and has_table_privilege('renave_app',
    'renave.credential_service_scope','SELECT')
  and not has_table_privilege('renave_app',
    'renave.establishment_regulatory_jurisdiction','INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('renave_app',
    'renave.credential_service_scope','INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('renave_app',
    'renave.establishment_regulatory_jurisdiction_history',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('renave_app',
    'renave.credential_service_scope_history',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('renave_credential_scope_provisioner',
    'renave.establishment_regulatory_jurisdiction','SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('renave_credential_scope_provisioner',
    'renave.credential_service_scope','SELECT,INSERT,UPDATE,DELETE')
  and not has_schema_privilege('renave_credential_scope_provisioner',
    'renave','USAGE,CREATE')
  and has_schema_privilege('renave_credential_scope_provisioner',
    'renave_admin','USAGE')
  and not has_schema_privilege('renave_credential_scope_provisioner',
    'renave_admin','CREATE')
  and has_function_privilege('renave_credential_scope_provisioner',
    'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)','EXECUTE')
  and has_function_privilege('renave_credential_scope_provisioner',
    'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_app',
    'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_app',
    'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)','EXECUTE')
  and position('session_user <> ''renave_credential_scope_provisioner'''
    in pg_get_functiondef(
      'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure))>0
  and position('session_user <> ''renave_credential_scope_provisioner'''
    in pg_get_functiondef(
      'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure))>0
  and has_function_privilege('renave_app',
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_app',
    'renave.create_held_local_operation_without_regulatory_scope_v0049(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)','EXECUTE')
  and position('required_nature := case p_kind' in pg_get_functiondef(
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure))>0
  and position('jurisdiction_count <> 1' in pg_get_functiondef(
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure))>0
  and position('700069' in pg_get_functiondef(
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure))>0
  and (select count(*)=4 and bool_and(
        owner.rolname='renave_migrator'
        and relation.relpersistence='p'
        and relation.relrowsecurity and relation.relforcerowsecurity
        and relation.relacl::text in (
          '{renave_migrator=arwdDxtm/renave_migrator}',
          '{renave_migrator=arwdDxtm/renave_migrator,renave_app=r/renave_migrator}'
        ))
    from pg_class relation join pg_namespace namespace
      on namespace.oid=relation.relnamespace
    join pg_roles owner on owner.oid=relation.relowner
    where namespace.nspname='renave' and relation.relname=any(array[
      'establishment_regulatory_jurisdiction',
      'establishment_regulatory_jurisdiction_history',
      'credential_service_scope','credential_service_scope_history']))
  and (select count(*)=4 and bool_and(
        policy.polname=any(array[
          'establishment_regulatory_jurisdiction_isolation',
          'establishment_regulatory_jurisdiction_history_isolation',
          'credential_service_scope_isolation',
          'credential_service_scope_history_isolation'])
        and policy.polcmd='*' and policy.polpermissive
        and policy.polroles='{0}'::oid[]
        and pg_get_expr(policy.polqual,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
        and pg_get_expr(policy.polwithcheck,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))')
    from pg_policy policy
    where policy.polrelid=any(array[
      'renave.establishment_regulatory_jurisdiction'::regclass,
      'renave.establishment_regulatory_jurisdiction_history'::regclass,
      'renave.credential_service_scope'::regclass,
      'renave.credential_service_scope_history'::regclass])
      )
  and (select count(*)=2 and bool_and(trigger.tgenabled='O'
        and trigger.tgtype=27
        and trigger.tgname=any(array[
          'establishment_regulatory_jurisdiction_history_append_only',
          'credential_service_scope_history_append_only'])
        and function_item.proname='regulatory_scope_history_reject_change')
    from pg_trigger trigger join pg_proc function_item
      on function_item.oid=trigger.tgfoid
    where not trigger.tgisinternal and trigger.tgrelid=any(array[
      'renave.establishment_regulatory_jurisdiction_history'::regclass,
      'renave.credential_service_scope_history'::regclass]))
  and (select owner.rolname='renave_migrator'
        and not function_item.prosecdef and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text=
          '{renave_migrator=X/renave_migrator}'
        and encode(sha256(convert_to(pg_get_functiondef(function_item.oid),
          'UTF8')),'hex')=
          '15e780f8bc8f9e9f8b3d0e1d5352267fa05bf3332f00a0809c2791bd2aae2c2c'
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=
        'renave.regulatory_scope_history_reject_change()'::regprocedure)
  and (select count(*)=3 and bool_and(
        owner.rolname='renave_migrator' and function_item.prosecdef
        and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[])
    from pg_proc function_item join pg_namespace namespace
      on namespace.oid=function_item.pronamespace
    join pg_roles owner on owner.oid=function_item.proowner
    where function_item.oid=any(array[
      'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure,
      'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure,
      'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure]))
  and encode(sha256(convert_to(pg_get_functiondef(
      'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure
    ),'UTF8')),'hex')=
      '2a0ff80d01b0e1343de79204488c32f214827a79a0cc11354777513723f0e342'
  and encode(sha256(convert_to(pg_get_functiondef(
      'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure
    ),'UTF8')),'hex')=
      '52473439c77c39ff7effa21ce0f7ec75dd4008d9e021334e3a0b146b4246e704'
  and encode(sha256(convert_to(pg_get_functiondef(
      'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)'::regprocedure
    ),'UTF8')),'hex')=
      'f717accc1eb2f12458236d427624a386dd1c08866fdba7f401ee54434cd77d2c'
  and (select not rolsuper and not rolinherit and not rolcreaterole
        and not rolcreatedb and rolcanlogin and not rolreplication
        and not rolbypassrls
    from pg_roles where rolname='renave_credential_scope_provisioner')
  and not exists (select 1 from pg_auth_members membership
    where membership.roleid=(select oid from pg_roles
      where rolname='renave_credential_scope_provisioner')
       or membership.member=(select oid from pg_roles
      where rolname='renave_credential_scope_provisioner'))
  and has_database_privilege('renave_credential_scope_provisioner',
    current_database(),'CONNECT')
  and not has_database_privilege('renave_credential_scope_provisioner',
    current_database(),'CREATE')
  and not has_database_privilege('renave_credential_scope_provisioner',
    current_database(),'TEMPORARY')
  and (select count(*)=4 and bool_and(
        privilege.grantor=function_item.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in (function_item.proowner,
          (select oid from pg_roles
            where rolname='renave_credential_scope_provisioner')))
      from pg_proc function_item
      cross join lateral aclexplode(function_item.proacl) privilege
      where function_item.oid=any(array[
        'renave_admin.transition_establishment_regulatory_jurisdiction(uuid,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure,
        'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure]))
  and (with expected(proname,body_hash) as (values
      ('tenant_administration_catalog_fingerprint_v0048','9f66f066a66094e042aaa607b13b5858b23069e0a8701219f54eb350cafe8189'),
      ('tenant_administration_catalog_fingerprint_without_regulatory_sc','8a4e9c59e465cbe35a24f9a63a59c5441ef58530c38a62fea56ee8e9775614ff'),
      ('stock_entry_rate_limit_catalog_fingerprint_v0056','f3d803c0d6c1787b32c6397bd6e1a9539f3cfb1a4edcf1ca675c52a489322653'),
      ('stock_entry_rate_limit_catalog_fingerprint_without_regulatory_s','98fdc6cdc132e4fad120db26b126e53d3a9db38cc6dd78312d0d1efae56de2dc'),
      ('profile_administration_catalog_fingerprint_v0058','31b8724c205790a7209fa06eca22c86805226e0f7e3feb5cd689cbcfb46f5833'),
      ('profile_administration_catalog_fingerprint_without_credential_s','82219d2efa80e8f07b59fab82538789e0e6e46878dd18a5e07b24a181ea2515f'),
      ('profile_administration_contract_ready_v0058','18d9d7efe7c60e449317442cc8a3cfaed99e9ac75f2ae712ffa5afcc9873ffb9'),
      ('profile_reader_catalog_fingerprint_v0060','41a764dbe167e4f2c2541f102a4eab78027d5201a287900f0e2c4e667479edcf'),
      ('profile_reader_catalog_fingerprint_without_credential_scope','41178c7497df15735856306ae4ca1797e0c92b110d49d1ac501f18d86bc443e2'),
      ('profile_reader_contract_ready_v0060','7a6302c2180d00fa4e4d04e18f2cea511bceb2892f68d5f8b28a098190e75e52'),
      ('vehicle_lookup_catalog_fingerprint_v0062','a04a4cda3026c32356c5735cdb96419e02cc7085394bbe42299ab9c2b6214b68'),
      ('vehicle_lookup_catalog_fingerprint_without_credential_scope','1952de17993bc64e6c1651f074da47343a309b9ccccf07f7ad43b5714dee319d'),
      ('platform_console_catalog_fingerprint_v0064','ec5f5cfb8db242334790fd3210d71aae5dc1adbb486d94bc56add1ee8baafcd1'),
      ('platform_console_catalog_fingerprint_without_credential_scope','06c85475da13086a4336a66c05ad2ec6337fd376c6ff8237305dc9bd4bcf8eb1'),
      ('identity_recent_mfa_catalog_fingerprint_v0067','f0f86095d178ddaa0e24931f4e254b0c4f973c64228081da9a7e88d17721b52d'),
      ('identity_recent_mfa_catalog_fingerprint_without_credential_scop','9f66f6149d4662457f9412f5639d74f9b48922f9f5d1889fdc054965f6d3c9d0'),
      ('credential_service_scope_previous_contract_v0069','ed49080c7054d2027297c55d3f72c8abc3e28dae1ae5cd8b40236158231dec9d')
    )
    select count(*)=17 and bool_and(owner.rolname='renave_migrator'
      and function_item.prosecdef and function_item.provolatile='s'
      and function_item.proconfig='{search_path=pg_catalog}'::text[]
      and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
      and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
        expected.body_hash)
    from expected join pg_proc function_item
      on function_item.proname=expected.proname
    join pg_namespace namespace on namespace.oid=function_item.pronamespace
    join pg_roles owner on owner.oid=function_item.proowner
    where namespace.nspname='renave_runtime')
$$;
revoke all on function
  renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum=
      '8d3ac0afb373591e85d35e35776cf96f603cbc88e4e2e656aad2bb12e42c2b93'
    from renave.schema_migrations where version='0070_credential_service_scope')
  and renave_runtime.credential_service_scope_previous_contract_v0069()
  and renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
