-- 0073 — Âncora executável da promoção regulatória de operações HELD_LOCAL.

alter function renave_runtime.api_contract_ready()
  rename to held_local_promotion_incomplete_v0072;
revoke all on function renave_runtime.held_local_promotion_incomplete_v0072()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.held_local_promotion_catalog_fingerprint_v0073()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select not rolsuper and not rolinherit and not rolcreaterole
      and not rolcreatedb and rolcanlogin and not rolreplication
      and not rolbypassrls
    from pg_roles where rolname='renave_operation_promoter')
  and has_database_privilege('renave_operation_promoter',current_database(),'CONNECT')
  and not has_database_privilege('renave_operation_promoter',current_database(),
    'CREATE,TEMPORARY')
  and not exists(select 1 from pg_auth_members membership
    where membership.roleid=(select oid from pg_roles
      where rolname='renave_operation_promoter')
       or membership.member=(select oid from pg_roles
      where rolname='renave_operation_promoter'))
  and has_schema_privilege('renave_operation_promoter','renave_admin','USAGE')
  and not has_schema_privilege('renave_operation_promoter','renave_admin','CREATE')
  and not has_schema_privilege('renave_operation_promoter','renave','USAGE,CREATE')
  and has_schema_privilege('renave_operation_promoter','renave_runtime','USAGE')
  and not has_schema_privilege('renave_operation_promoter','renave_runtime','CREATE')
  and (select owner.rolname='renave_migrator' and relation.relpersistence='p'
        and relation.relrowsecurity and relation.relforcerowsecurity
        and relation.relacl::text=
          '{renave_migrator=arwdDxtm/renave_migrator}'
      from pg_class relation join pg_roles owner on owner.oid=relation.relowner
      where relation.oid='renave.operation_authorization_binding'::regclass)
  and (select count(*)=1 and bool_and(policy.polname=
        'operation_authorization_binding_isolation'
        and policy.polcmd='*' and policy.polpermissive
        and policy.polroles='{0}'::oid[]
        and pg_get_expr(policy.polqual,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
        and pg_get_expr(policy.polwithcheck,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))')
      from pg_policy policy
      where policy.polrelid='renave.operation_authorization_binding'::regclass)
  and (select count(*)=2 and bool_and(not trigger.tgisinternal
        and trigger.tgenabled='O' and function_item.proname=
          'operation_authorization_binding_reject_change')
      from pg_trigger trigger join pg_proc function_item
        on function_item.oid=trigger.tgfoid
      where trigger.tgrelid='renave.operation_authorization_binding'::regclass
        and not trigger.tgisinternal)
  and (select count(*)=2 and bool_and(policy.polcmd='*' and policy.polpermissive
        and policy.polroles='{0}'::oid[]
        and pg_get_expr(policy.polqual,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
        and pg_get_expr(policy.polwithcheck,policy.polrelid)=
          '(tenant_id = ( SELECT renave.current_tenant_id() AS current_tenant_id))'
        and policy.polname=any(array[
          'operation_authorization_binding_isolation',
          'operation_promotion_decision_isolation']))
      from pg_policy policy where policy.polrelid=any(array[
        'renave.operation_authorization_binding'::regclass,
        'renave.operation_promotion_decision'::regclass]))
  and (select count(*)=4 and bool_and(trigger.tgenabled='O'
        and ((trigger.tgname in('operation_authorization_binding_append_only',
              'operation_promotion_decision_append_only') and trigger.tgtype=27)
          or (trigger.tgname in('operation_authorization_binding_reject_truncate',
              'operation_promotion_decision_reject_truncate') and trigger.tgtype=34)))
      from pg_trigger trigger where not trigger.tgisinternal
        and trigger.tgrelid=any(array[
          'renave.operation_authorization_binding'::regclass,
          'renave.operation_promotion_decision'::regclass]))
  and (select count(*)=12 and count(*) filter(where attribute.attname=any(array[
          'tenant_id','operation_id','service_nature','jurisdiction_uf',
          'jurisdiction_generation','scope_generation','credential_link_version',
          'operator_profile_id','operator_profile_version',
          'establishment_profile_id','establishment_profile_version','created_at']))=12
      from pg_attribute attribute
      where attribute.attrelid='renave.operation_authorization_binding'::regclass
        and attribute.attnum>0 and not attribute.attisdropped)
  and (select count(*)=7 and count(*) filter(where attribute.attname=any(array[
          'tenant_id','operation_id','outbox_id','decision_ticket_digest',
          'evidence_digest','changed_by_digest','decided_at']))=7
      from pg_attribute attribute
      where attribute.attrelid='renave.operation_promotion_decision'::regclass
        and attribute.attnum>0 and not attribute.attisdropped)
  and (select count(*)=2 and bool_and(relation.relrowsecurity
        and relation.relforcerowsecurity and relation.relpersistence='p'
        and relation.relacl::text='{renave_migrator=arwdDxtm/renave_migrator}')
      from pg_class relation where relation.oid=any(array[
        'renave.operation_authorization_binding'::regclass,
        'renave.operation_promotion_decision'::regclass]))
  and (select count(*)=12 and bool_and(constraint_item.convalidated)
      from pg_constraint constraint_item where constraint_item.conrelid=any(array[
        'renave.operation_authorization_binding'::regclass,
        'renave.operation_promotion_decision'::regclass]))
  and (select count(*)=3 from pg_index index_item where index_item.indrelid=any(array[
        'renave.operation_authorization_binding'::regclass,
        'renave.operation_promotion_decision'::regclass])
      and index_item.indisvalid and index_item.indisready)
  and (select count(*)=2 and bool_and(attribute.atttypid='int8'::regtype
        and not attribute.attnotnull)
      from pg_attribute attribute
      where attribute.attrelid=any(array[
        'renave.credential_service_scope'::regclass,
        'renave.credential_service_scope_history'::regclass])
        and attribute.attname='jurisdiction_generation'
        and not attribute.attisdropped)
  and (select count(*)=5 and bool_and(owner.rolname='renave_migrator'
        and function_item.prosecdef and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[])
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=any(array[
        'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure,
        'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)'::regprocedure,
        'renave.resolve_verified_renave_principals_v0072(text,uuid,bytea)'::regprocedure,
        'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)'::regprocedure,
        'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'::regprocedure]))
  and position('jurisdiction_generation=jurisdiction.generation' in
    replace(pg_get_functiondef(
      'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure),' ',''))>0
  and position('clock_timestamp()' in pg_get_functiondef(
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)'::regprocedure))>0
  and position('operation_authorization_binding_is_current' in
    pg_get_functiondef(
      'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)'::regprocedure))>0
  and position('operation_authorization_binding_is_current' in
    pg_get_functiondef(
      'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'::regprocedure))>0
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave.begin_operation_send_dispatch(uuid,uuid,uuid)'::regprocedure)
  and (select count(*)=4 and bool_and(owner.rolname='renave_migrator'
        and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
        and function_item.proconfig='{search_path=pg_catalog}'::text[])
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=any(array[
        'renave.operation_authorization_binding_reject_change()'::regprocedure,
        'renave.operation_promotion_decision_reject_change()'::regprocedure,
        'renave_runtime.operation_authorization_binding_is_current(uuid,timestamptz)'::regprocedure,
        'renave.operation_guard()'::regprocedure]))
  and position('HELD_LOCAL' in pg_get_functiondef(
    'renave.operation_guard()'::regprocedure))>0
  and position('PENDING_SEND' in pg_get_functiondef(
    'renave.operation_guard()'::regprocedure))>0
  and not has_function_privilege('renave_app',
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea)','EXECUTE')
  and has_function_privilege('renave_app',
    'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)','EXECUTE')
  and has_function_privilege('renave_operation_promoter',
    'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_app',
    'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_operation_worker',
    'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','EXECUTE')
  and not has_function_privilege('renave_operation_promoter',
    'renave.claim_operation_send_leases(uuid,integer)','EXECUTE')
  and not has_function_privilege('renave_operation_promoter',
    'renave.begin_operation_send_dispatch(uuid,uuid,uuid)','EXECUTE')
  and not has_function_privilege('renave_operation_worker',
    'renave.begin_operation_send_dispatch(uuid,uuid,uuid)','EXECUTE')
  and not has_function_privilege('renave_operation_worker',
    'renave.begin_operation_send_dispatch_without_authorization_v0029(uuid,uuid,uuid)','EXECUTE')
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator,renave_operation_promoter=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)'::regprocedure)
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)'::regprocedure)
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator,renave_app=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave.resolve_verified_renave_principals_v0072(text,uuid,bytea)'::regprocedure)
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator,renave_credential_scope_provisioner=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)'::regprocedure)
  and (with expected(proname,body_hash) as(values
      ('tenant_administration_catalog_fingerprint_v0048','70e5369dae09abac9426950766d6662062b58416c04295932a9372cfd3406b03'),
      ('stock_entry_rate_limit_catalog_fingerprint_v0056','e1f6294e3370d28a3e0af0d8ea12ce50f3f818fc9cc9967afd293a7ac974bf68'),
      ('profile_administration_catalog_fingerprint_v0058','a571f8922a2479ae4b35381d7108229e52f95091600c8834e05a900c2c436191'),
      ('vehicle_lookup_catalog_fingerprint_v0062','aba461180c04ef057d8e2c9fb2afb6d8740d2b21f7d2a7e85a7e722abe75892d'),
      ('credential_service_scope_catalog_fingerprint_v0071','4e0bf8a532e6082b6314c1c84329d307877d43103d555237ca405bc68f351303'),
      ('tenant_administration_catalog_fingerprint_without_regulatory_sc','8a4e9c59e465cbe35a24f9a63a59c5441ef58530c38a62fea56ee8e9775614ff'),
      ('stock_entry_rate_limit_catalog_fingerprint_without_regulatory_s','98fdc6cdc132e4fad120db26b126e53d3a9db38cc6dd78312d0d1efae56de2dc'),
      ('profile_administration_catalog_fingerprint_without_credential_s','82219d2efa80e8f07b59fab82538789e0e6e46878dd18a5e07b24a181ea2515f'),
      ('profile_reader_catalog_fingerprint_without_credential_scope','41178c7497df15735856306ae4ca1797e0c92b110d49d1ac501f18d86bc443e2'),
      ('vehicle_lookup_catalog_fingerprint_without_credential_scope','1952de17993bc64e6c1651f074da47343a309b9ccccf07f7ad43b5714dee319d'),
      ('platform_console_catalog_fingerprint_without_credential_scope','06c85475da13086a4336a66c05ad2ec6337fd376c6ff8237305dc9bd4bcf8eb1'),
      ('identity_recent_mfa_catalog_fingerprint_without_credential_scop','9f66f6149d4662457f9412f5639d74f9b48922f9f5d1889fdc054965f6d3c9d0'),
      ('profile_reader_catalog_fingerprint_v0060','41a764dbe167e4f2c2541f102a4eab78027d5201a287900f0e2c4e667479edcf'),
      ('profile_administration_contract_ready_v0058','9ee02f620c6af5637a168fa744d1cadcec94249dce9628a88ad8cd7e7ce6f34c'),
      ('profile_administration_contract_pre_promotion_v0073','18d9d7efe7c60e449317442cc8a3cfaed99e9ac75f2ae712ffa5afcc9873ffb9'),
      ('profile_reader_contract_ready_v0060','7a6302c2180d00fa4e4d04e18f2cea511bceb2892f68d5f8b28a098190e75e52'),
      ('platform_console_catalog_fingerprint_v0064','ec5f5cfb8db242334790fd3210d71aae5dc1adbb486d94bc56add1ee8baafcd1'),
      ('identity_recent_mfa_catalog_fingerprint_v0067','f0f86095d178ddaa0e24931f4e254b0c4f973c64228081da9a7e88d17721b52d'),
      ('platform_rate_catalog_fingerprint_v0068','c6499a2caf3f2f295acb31c162054bafd5c8644e41440a2a9465895b8e015c73'),
      ('credential_service_scope_previous_contract_v0069','ed49080c7054d2027297c55d3f72c8abc3e28dae1ae5cd8b40236158231dec9d'))
    select count(*)=20 and bool_and(owner.rolname='renave_migrator'
      and function_item.prosecdef and function_item.provolatile='s'
      and function_item.proconfig='{search_path=pg_catalog}'::text[]
      and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
      and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
        expected.body_hash)
    from expected join pg_proc function_item using(proname)
      join pg_namespace namespace on namespace.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
    where namespace.nspname='renave_runtime')
  and (with expected(signature,body_hash) as(values
      ('renave.operation_authorization_binding_reject_change()','8d47dd05b76d02239288b131f0c85405a384467669142b8089fd1e32db78fd69'),
      ('renave.operation_promotion_decision_reject_change()','c17afa0b1ca3bf6e78aede7ef6d34510bae3c3887e4f05cd40ba46b6cd62c317'),
      ('renave_runtime.operation_authorization_binding_is_current(uuid,timestamptz)','2a2ee5238fc18da3f069a7321e5d7c4725e97d786168f6f65fa672b5a550df7d'),
      ('renave.operation_guard()','20336ab7dd5f7a6ac080dbc68e64e0b9b6e5aa2083270b9d58625014d2efc468'),
      ('renave.begin_operation_send_dispatch(uuid,uuid,uuid)','6626da27d72e777d04bef85080017ab62d8ffd9a7098d26181ce959af92ba352'),
      ('renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','4ce37cdf9b24dca0673551925a9e307ed42cb7ab6ceba2fc618e604deaa94966'),
      ('renave.resolve_verified_renave_principals_v0072(text,uuid,bytea)','2f198edaca5401f9b758a5c0ea7422b751070792e9a4072a653deebbeb390569'),
      ('renave_admin.transition_credential_service_scope(uuid,text,text,text,timestamptz,timestamptz,bytea,bytea,bytea)','48754918dcfd389b581bbb81be6dda159bc9bb347bb961c2f878e7084f9fd286'),
      ('renave.create_held_local_operation(uuid,uuid,text,text,bytea,bytea,bytea,integer,integer,text,bytea,bytea,bytea,bytea,uuid,text,integer,bigint,integer,text,bytea,bytea,bytea,text,uuid,bigint,uuid,bigint)','ccf81ec8a9cc2ed4bf6910e10a62eb1e75f0ce7a19eb45293ea51f395f9925cd'))
    select count(*)=9 and bool_and(encode(sha256(convert_to(
      function_item.prosrc,'UTF8')),'hex')=expected.body_hash)
    from expected join pg_proc function_item
      on function_item.oid=to_regprocedure(expected.signature))
  and encode(sha256(convert_to(jsonb_build_object(
    'columns',(select jsonb_agg(jsonb_build_array(relation.relname,
      attribute.attnum,attribute.attname,
      format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
      coalesce(pg_get_expr(default_item.adbin,default_item.adrelid),''),
      coalesce(attribute.attacl::text,'')) order by relation.relname,attribute.attnum)
      from pg_class relation join pg_attribute attribute
        on attribute.attrelid=relation.oid and attribute.attnum>0
          and not attribute.attisdropped
      left join pg_attrdef default_item on default_item.adrelid=relation.oid
        and default_item.adnum=attribute.attnum where relation.oid=any(array[
          'renave.operation_authorization_binding'::regclass,
          'renave.operation_promotion_decision'::regclass])),
    'constraints',(select jsonb_agg(jsonb_build_array(relation.relname,
      constraint_item.conname,constraint_item.contype,
      constraint_item.convalidated,pg_get_constraintdef(constraint_item.oid,false))
      order by relation.relname,constraint_item.conname)
      from pg_constraint constraint_item join pg_class relation
        on relation.oid=constraint_item.conrelid where relation.oid=any(array[
          'renave.operation_authorization_binding'::regclass,
          'renave.operation_promotion_decision'::regclass])),
    'indexes',(select jsonb_agg(jsonb_build_array(relation.relname,
      index_item.indexrelid::regclass::text,index_item.indisunique,
      index_item.indisprimary,index_item.indisvalid,
      pg_get_indexdef(index_item.indexrelid)) order by relation.relname,
        index_item.indexrelid::regclass::text)
      from pg_index index_item join pg_class relation
        on relation.oid=index_item.indrelid where relation.oid=any(array[
          'renave.operation_authorization_binding'::regclass,
          'renave.operation_promotion_decision'::regclass])),
    'triggers',(select jsonb_agg(jsonb_build_array(relation.relname,
      trigger.tgname,trigger.tgtype,trigger.tgenabled,function_item.proname,
      pg_get_triggerdef(trigger.oid,false)) order by relation.relname,trigger.tgname)
      from pg_trigger trigger join pg_class relation
        on relation.oid=trigger.tgrelid join pg_proc function_item
        on function_item.oid=trigger.tgfoid where not trigger.tgisinternal
        and relation.oid=any(array[
          'renave.operation_authorization_binding'::regclass,
          'renave.operation_promotion_decision'::regclass])))::text,'UTF8')),'hex')=
    '7e8a7ff5c5c8fd5ff03e49d3de47485ef47dee4ad75ae967c15f3dd788c47209'
$$;
revoke all on function
  renave_runtime.held_local_promotion_catalog_fingerprint_v0073()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- Recompõe somente os quatro fingerprints cujo catálogo bruto mudou. Cada
-- ponte exige o hash pós-0072 exato; qualquer drift fora da mudança planejada
-- altera o hash bruto e mantém toda a árvore histórica fechada.
create or replace function
  renave_runtime.tenant_administration_catalog_fingerprint_v0048()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.tenant_administration_catalog_fingerprint_without_regulatory_sc()=
    '9f9da909335e04db6494b4ca1b8650f7763e4f970846a6f00dab92f19eb501b5'
then '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
else 'held-local-promotion-tenant-catalog-drift' end$$;

create or replace function
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.stock_entry_rate_limit_catalog_fingerprint_without_regulatory_s()=
    '61b08cb2c237dbda913916faa00ee038a93facc9b8e5e91c9ac372dcfbe30888'
then 'd5226c15ac4b48dbf8fb60c0d448f30f8d5af98ed56cf9f561d09f25d8b36d9a'
else 'held-local-promotion-stock-catalog-drift' end$$;

create or replace function
  renave_runtime.profile_administration_catalog_fingerprint_v0058()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.profile_administration_catalog_fingerprint_without_credential_s()=
    'fc6a3f4c441e328c539a2c854dfbb1c7c752500f08ecdca49ef41f53eb2edce7'
then '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
else 'held-local-promotion-profile-catalog-drift' end$$;

create or replace function
  renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()
returns text language sql stable security definer set search_path=pg_catalog
as $$select case when
  renave_runtime.vehicle_lookup_catalog_fingerprint_without_credential_scope()=
    'cc8807c497034a63735afa8417dfb635dde2f1bb0135de0798c73351a55c7a33'
then '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
else 'held-local-promotion-vehicle-catalog-drift' end$$;

-- A promoção adiciona uma única função ao catálogo fechado de renave_admin.
-- Recompomos o contrato 0058 integralmente, mantendo todos os checks dinâmicos
-- e acrescentando somente a assinatura/ACL exatas da nova capacidade.
alter function renave_runtime.profile_administration_contract_ready_v0058()
  rename to profile_administration_contract_pre_promotion_v0073;
revoke all on function
  renave_runtime.profile_administration_contract_pre_promotion_v0073()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function
  renave_runtime.profile_administration_contract_ready_v0058()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select
  renave_runtime.stock_entry_rate_limit_contract_ready_v0056()
  and (select checksum='0e305b1d30e1526dd019a295bb7dc56687e6ff8b0ed8444c05a383e98ce0549f'
    from renave.schema_migrations where version='0051_verified_renave_profiles')
  and (select checksum='0b85d8e3e0956de568b5caed308bb6527d271e3ed2be40862b50d373d382a48d'
    from renave.schema_migrations where version='0053_verified_renave_principal_resolution')
  and (select checksum='a8c66f647e5f96c8718f42b2b2cd0eebd0ba8f7baf7b93adc43ba72f11da6992'
    from renave.schema_migrations where version='0057_renave_profile_administration')
  and renave_runtime.profile_administration_catalog_fingerprint_v0058()=
    '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
  and (select not rolsuper and not rolinherit and not rolcreaterole
      and not rolcreatedb and rolcanlogin and not rolreplication
      and not rolbypassrls from pg_roles where rolname='renave_profile_provisioner')
  and not has_schema_privilege('renave_profile_provisioner','renave','USAGE')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.operator_identity_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.establishment_renave_profile','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('renave_profile_provisioner',
    'renave.profile_administration_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and (select count(*)=11 and bool_and(role_owner.rolname='renave_migrator'
        and function_item.prosecdef and function_item.prokind='f'
        and language_item.lanname='plpgsql'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and (function_item.proname||'('||oidvectortypes(function_item.proargtypes)||')')=any(array[
          'assert_profile_provisioner()','assert_profile_reader()',
          'stage_operator_pending(uuid, text, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'stage_establishment_pending(uuid, uuid, uuid, text, bytea, integer, text, bytea, bytea, bytea, bytea, bytea, text, bytea, text)',
          'suspend_operator(uuid, text, bigint, bytea, text, bytea, text, bytea, text)',
          'suspend_establishment(uuid, uuid, bigint, bytea, text, bytea, text, bytea, text)',
          'get_operator_status(uuid, text)','get_establishment_status(uuid, uuid)',
          'transition_establishment_regulatory_jurisdiction(uuid, text, text, timestamp with time zone, timestamp with time zone, bytea, bytea, bytea)',
          'transition_credential_service_scope(uuid, text, text, text, timestamp with time zone, timestamp with time zone, bytea, bytea, bytea)',
          'promote_held_local_operation(uuid, bytea, bytea, bytea)'])
        and (select count(*)=case when function_item.proname in
              ('assert_profile_provisioner','assert_profile_reader') then 1 else 2 end
             and bool_and(privilege.grantor=function_item.proowner
               and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
               and (privilege.grantee=function_item.proowner
                 or (function_item.proname like 'transition_%'
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_credential_scope_provisioner'))
                 or (function_item.proname='promote_held_local_operation'
                   and privilege.grantee=(select oid from pg_roles
                     where rolname='renave_operation_promoter'))
                 or (function_item.proname in('stage_operator_pending',
                    'stage_establishment_pending','suspend_operator',
                    'suspend_establishment') and privilege.grantee=(select oid
                      from pg_roles where rolname='renave_profile_provisioner'))
                 or (function_item.proname in('get_operator_status',
                    'get_establishment_status') and privilege.grantee=(select oid
                      from pg_roles where rolname='renave_profile_reader'))))
            from aclexplode(function_item.proacl) privilege)
      ) from pg_proc function_item join pg_namespace function_schema
        on function_schema.oid=function_item.pronamespace
      join pg_roles role_owner on role_owner.oid=function_item.proowner
      join pg_language language_item on language_item.oid=function_item.prolang
      where function_schema.nspname='renave_admin')
  and (select count(*)=1 and bool_and(privilege.grantor=default_acl.defaclrole
        and privilege.grantee=default_acl.defaclrole
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable)
      from pg_default_acl default_acl join pg_roles default_owner
        on default_owner.oid=default_acl.defaclrole
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      where default_owner.rolname='renave_migrator'
        and default_acl.defaclobjtype='f' and default_acl.defaclnamespace=0)
  and not exists(select 1 from pg_default_acl default_acl
      join pg_roles default_owner on default_owner.oid=default_acl.defaclrole
      left join pg_namespace default_schema on default_schema.oid=default_acl.defaclnamespace
      cross join lateral aclexplode(default_acl.defaclacl) privilege
    where default_owner.rolname='renave_migrator' and default_acl.defaclobjtype='f'
      and(default_acl.defaclnamespace=0 or default_schema.nspname='renave_admin')
      and not(privilege.grantor=default_acl.defaclrole
        and privilege.grantee=default_acl.defaclrole
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable))
  and (select count(*)=3 and bool_and(privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in(contract.proowner,
          (select oid from pg_roles where rolname='renave_app'),
          (select oid from pg_roles where rolname='renave_identity_app')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure('renave_runtime.api_contract_ready()'))
  and (select count(*)=2 and bool_and(privilege.grantor=contract.proowner
        and privilege.privilege_type='EXECUTE' and not privilege.is_grantable
        and privilege.grantee in(contract.proowner,
          (select oid from pg_roles where rolname='renave_operation_worker')))
      from pg_proc contract cross join lateral aclexplode(contract.proacl) privilege
      where contract.oid=to_regprocedure(
        'renave_runtime.operation_worker_contract_ready()'))$$;
revoke all on function
  renave_runtime.profile_administration_contract_ready_v0058()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

alter function
  renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
  rename to credential_scope_fp_pre_promotion_v0073;
revoke all on function
  renave_runtime.credential_scope_fp_pre_promotion_v0073()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
create function renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select
  (select not rolsuper and not rolinherit and not rolcreaterole
      and not rolcreatedb and rolcanlogin and not rolreplication
      and not rolbypassrls
    from pg_roles where rolname='renave_credential_scope_provisioner')
  and not exists(select 1 from pg_auth_members membership
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
  and renave_runtime.tenant_administration_catalog_fingerprint_v0048()=
    '580916dea4fe48a5fd4ce730645b75d926400f682fc148ad12ff37a379960302'
  and renave_runtime.stock_entry_rate_limit_catalog_fingerprint_v0056()=
    'd5226c15ac4b48dbf8fb60c0d448f30f8d5af98ed56cf9f561d09f25d8b36d9a'
  and renave_runtime.profile_administration_catalog_fingerprint_v0058()=
    '9c5abd852a2400564e6a07573f0c5366785522fccd45d785c0cf26eb6db74aff'
  and renave_runtime.vehicle_lookup_catalog_fingerprint_v0062()=
    '8677e5ad66257f76b2ef2ee0ffe44a225b69a81802b914df36a02afa80b6034c'
  and renave_runtime.held_local_promotion_catalog_fingerprint_v0073()
$$;
revoke all on function
  renave_runtime.credential_service_scope_catalog_fingerprint_v0071()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

-- A 0072 muda deliberadamente objetos presentes no fingerprint 0071. Fechamos
-- o histórico pelos checksums e pelos corpos imutáveis das duas âncoras 0071;
-- as substituições intencionais são verificadas pelo fingerprint novo abaixo.
create function renave_runtime.held_local_promotion_historical_anchor_v0073()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum=
      '8d3ac0afb373591e85d35e35776cf96f603cbc88e4e2e656aad2bb12e42c2b93'
    from renave.schema_migrations where version='0070_credential_service_scope')
  and (select checksum=
      '3a3e9862476ce291e7760fd488108bb9aae473182b0a68b95e0e1c2154fbe2a5'
    from renave.schema_migrations
    where version='0071_runtime_contract_credential_service_scope')
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
        and function_item.provolatile='s'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
        and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
          '9f4fa16e40d12bca84e455a366f1eadddeb85f9d94c718fa9331bbe10ca936d4'
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=
        'renave_runtime.held_local_promotion_previous_contract_v0071()'::regprocedure)
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
        and function_item.provolatile='s'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
        and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
          '182cb4eaca3b13f7a16301651c8fb30a89f3ec36edd4990e2d3e90917c2dd260'
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=
        'renave_runtime.credential_scope_fp_pre_promotion_v0073()'::regprocedure)
  and renave_runtime.held_local_promotion_previous_contract_v0071()
$$;
revoke all on function
  renave_runtime.held_local_promotion_historical_anchor_v0073()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum='9a520ff6c1698f2f13d6c7dbfc665e8a1f389e58dd90bc7d1dd6478c7dc57696'
    from renave.schema_migrations
    where version='0072_held_local_regulatory_promotion')
  and renave_runtime.held_local_promotion_historical_anchor_v0073()
  and renave_runtime.held_local_promotion_catalog_fingerprint_v0073()
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;

create function renave_runtime.operation_promoter_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_promoter_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant usage on schema renave_runtime to renave_operation_promoter;
revoke create on schema renave_runtime from renave_operation_promoter;
grant execute on function renave_runtime.operation_promoter_contract_ready()
to renave_operation_promoter;
