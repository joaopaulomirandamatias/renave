-- 0075 — Âncora executável da decisão assinada de promoção.

alter function renave_runtime.api_contract_ready()
  rename to signed_operation_promotion_incomplete_v0074;
revoke all on function
  renave_runtime.signed_operation_promotion_incomplete_v0074()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.signed_operation_promotion_catalog_fingerprint_v0075()
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
  and
  (select checksum=
      '9a520ff6c1698f2f13d6c7dbfc665e8a1f389e58dd90bc7d1dd6478c7dc57696'
    from renave.schema_migrations
    where version='0072_held_local_regulatory_promotion')
  and
  (select checksum=
      '6d6532349e692485a8ac8cd08cc1fe8c77e6247b26ab6e611e9b9a9583582039'
    from renave.schema_migrations
    where version='0073_runtime_contract_held_local_regulatory_promotion')
  and (select checksum=
      '7bec494d246b3cef32c47f14ffea8afa190bea6fa080140038738b0787424f95'
    from renave.schema_migrations where version='0074_signed_operation_promotion')
  and (select owner.rolname='renave_migrator' and function_item.prosecdef
        and function_item.provolatile='s'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
        and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
          '79df84dc8e2d1218259f5c5733ab66e46bbd74c45ba6a336c0f13a1a9198619c'
      from pg_proc function_item join pg_roles owner
        on owner.oid=function_item.proowner
      where function_item.oid=
        'renave_runtime.signed_operation_promotion_previous_contract_v0073()'::regprocedure)
  and (select not rolsuper and not rolinherit and not rolcreaterole
        and not rolcreatedb and rolcanlogin and not rolreplication
        and not rolbypassrls
      from pg_roles where rolname='renave_operation_promoter')
  and (select not rolsuper and not rolinherit and not rolcreaterole
        and not rolcreatedb and rolcanlogin and not rolreplication
        and not rolbypassrls
      from pg_roles where rolname='renave_credential_scope_provisioner')
  and (with expected(proname,body_hash) as(values
      ('tenant_administration_catalog_fingerprint_v0048',
        'cba6e1724c16c6f081f34348309fd598bc0f12c298c0dcbdfc448141b2b86af0'),
      ('tenant_administration_catalog_fingerprint_without_regulatory_sc',
        '8a4e9c59e465cbe35a24f9a63a59c5441ef58530c38a62fea56ee8e9775614ff'))
    select count(*)=2 and bool_and(owner.rolname='renave_migrator'
      and function_item.prosecdef and function_item.provolatile='s'
      and function_item.proconfig='{search_path=pg_catalog}'::text[]
      and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
      and encode(sha256(convert_to(function_item.prosrc,'UTF8')),'hex')=
        expected.body_hash)
    from expected join pg_proc function_item using(proname)
      join pg_namespace namespace on namespace.oid=function_item.pronamespace
      join pg_roles owner on owner.oid=function_item.proowner
    where namespace.nspname='renave_runtime')
  and (select owner.rolname='renave_migrator' and relation.relpersistence='p'
        and relation.relrowsecurity and relation.relforcerowsecurity
        and relation.relacl::text=
          '{renave_migrator=arwdDxtm/renave_migrator}'
      from pg_class relation join pg_roles owner on owner.oid=relation.relowner
      where relation.oid=
        'renave_promotion.operation_promotion_signed_artifact'::regclass)
  and (select count(*)=17 and count(*) filter(where attribute.attname=any(array[
        'tenant_id','operation_id','outbox_id','decision_id','artifact_digest',
        'authorization_binding_digest','executor_workload_digest',
        'evidence_manifest_digest','changed_by_digest','issuer_key_id',
        'policy_version','environment','logical_database_id','issued_at',
        'not_before','expires_at','registered_at']))=17
      from pg_attribute attribute where attribute.attrelid=
        'renave_promotion.operation_promotion_signed_artifact'::regclass
        and attribute.attnum>0 and not attribute.attisdropped)
  and (select count(*)=1 and bool_and(policy.polname=
        'operation_promotion_signed_artifact_isolation'
        and policy.polcmd='*' and policy.polpermissive
        and policy.polroles='{0}'::oid[])
      from pg_policy policy where policy.polrelid=
        'renave_promotion.operation_promotion_signed_artifact'::regclass)
  and (select count(*)=2 and bool_and(not trigger.tgisinternal
        and trigger.tgenabled='O'
        and function_item.proname='operation_promotion_decision_reject_change')
      from pg_trigger trigger join pg_proc function_item
        on function_item.oid=trigger.tgfoid
      where trigger.tgrelid=
        'renave_promotion.operation_promotion_signed_artifact'::regclass
        and not trigger.tgisinternal)
  and (select owner.rolname='renave_migrator' and relation.relpersistence='p'
        and not relation.relrowsecurity and not relation.relforcerowsecurity
        and relation.relacl::text=
          '{renave_migrator=arwdDxtm/renave_migrator}'
      from pg_class relation join pg_roles owner on owner.oid=relation.relowner
      where relation.oid=
        'renave_promotion.operation_promotion_identity'::regclass)
  and (select count(*)=4 and count(*) filter(where attribute.attname=any(array[
        'singleton','environment','logical_database_id','configured_at']))=4
      from pg_attribute attribute where attribute.attrelid=
        'renave_promotion.operation_promotion_identity'::regclass
        and attribute.attnum>0 and not attribute.attisdropped)
  and (select function_item.prosecdef and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text=
          '{renave_migrator=X/renave_migrator,renave_operation_promoter=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)'::regprocedure)
  and (select function_item.proacl::text=
        '{renave_migrator=X/renave_migrator,renave_operation_promoter=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)'::regprocedure)
  and (select function_item.prosecdef and function_item.provolatile='v'
        and function_item.proconfig='{search_path=pg_catalog}'::text[]
        and function_item.proacl::text='{renave_migrator=X/renave_migrator}'
      from pg_proc function_item where function_item.oid=
        'renave_promotion.configure_operation_promotion_identity(text,uuid)'::regprocedure)
  and (with expected(signature,body_hash) as(values
      ('renave_promotion.configure_operation_promotion_identity(text,uuid)',
        'bc014567c930c3db16badc3f2c54d536918046649e54013bbfb5f6ab6341f582'),
      ('renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)',
        'ab6f79486a141e149fbb8d963f419b0431924de8cdc495c5f364f078c6ed14a5'))
    select count(*)=2 and bool_and(encode(sha256(convert_to(
      function_item.prosrc,'UTF8')),'hex')=expected.body_hash)
    from expected join pg_proc function_item
      on function_item.oid=to_regprocedure(expected.signature))
  and encode(sha256(convert_to(jsonb_build_object(
    'schema',(select jsonb_build_array(namespace.nspname,owner.rolname,
        coalesce(namespace.nspacl::text,''))
      from pg_namespace namespace join pg_roles owner
        on owner.oid=namespace.nspowner
      where namespace.nspname='renave_promotion'),
    'relations',(select jsonb_agg(jsonb_build_array(relation.relname,
        owner.rolname,relation.relpersistence,relation.relrowsecurity,
        relation.relforcerowsecurity,coalesce(relation.relacl::text,''))
      order by relation.relname)
      from pg_class relation join pg_namespace namespace
        on namespace.oid=relation.relnamespace
      join pg_roles owner on owner.oid=relation.relowner
      where namespace.nspname='renave_promotion' and relation.relkind='r'),
    'columns',(select jsonb_agg(jsonb_build_array(relation.relname,
        attribute.attnum,attribute.attname,
        format_type(attribute.atttypid,attribute.atttypmod),
        attribute.attnotnull,
        coalesce(pg_get_expr(default_item.adbin,default_item.adrelid),''),
        coalesce(attribute.attacl::text,''))
      order by relation.relname,attribute.attnum)
      from pg_class relation join pg_namespace namespace
        on namespace.oid=relation.relnamespace
      join pg_attribute attribute on attribute.attrelid=relation.oid
        and attribute.attnum>0 and not attribute.attisdropped
      left join pg_attrdef default_item on default_item.adrelid=relation.oid
        and default_item.adnum=attribute.attnum
      where namespace.nspname='renave_promotion' and relation.relkind='r'),
    'constraints',(select jsonb_agg(jsonb_build_array(relation.relname,
        constraint_item.conname,constraint_item.contype,
        constraint_item.convalidated,
        pg_get_constraintdef(constraint_item.oid,false))
      order by relation.relname,constraint_item.conname)
      from pg_constraint constraint_item join pg_class relation
        on relation.oid=constraint_item.conrelid
      join pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='renave_promotion'),
    'indexes',(select jsonb_agg(jsonb_build_array(relation.relname,
        index_item.indexrelid::regclass::text,index_item.indisunique,
        index_item.indisprimary,index_item.indisvalid,
        pg_get_indexdef(index_item.indexrelid))
      order by relation.relname,index_item.indexrelid::regclass::text)
      from pg_index index_item join pg_class relation
        on relation.oid=index_item.indrelid
      join pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='renave_promotion'),
    'policies',(select jsonb_agg(jsonb_build_array(relation.relname,
        policy.polname,policy.polcmd,policy.polpermissive,
        policy.polroles::text,
        coalesce(pg_get_expr(policy.polqual,policy.polrelid),''),
        coalesce(pg_get_expr(policy.polwithcheck,policy.polrelid),''))
      order by relation.relname,policy.polname)
      from pg_policy policy join pg_class relation
        on relation.oid=policy.polrelid
      join pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='renave_promotion'),
    'triggers',(select jsonb_agg(jsonb_build_array(relation.relname,
        trigger.tgname,trigger.tgtype,trigger.tgenabled,function_item.proname,
        pg_get_triggerdef(trigger.oid,false))
      order by relation.relname,trigger.tgname)
      from pg_trigger trigger join pg_class relation
        on relation.oid=trigger.tgrelid
      join pg_namespace namespace on namespace.oid=relation.relnamespace
      join pg_proc function_item on function_item.oid=trigger.tgfoid
      where namespace.nspname='renave_promotion' and not trigger.tgisinternal)
    )::text,'UTF8')),'hex')=
      'abe7ca6f5ee52c6d494de5dce2a1def0727b3552a784de32a0953692253b33c9'
  and has_schema_privilege('renave_operation_promoter','renave_promotion','USAGE')
  and not has_schema_privilege('renave_operation_promoter','renave_promotion','CREATE')
  and has_function_privilege('renave_operation_promoter',
    'renave_admin.promote_held_local_operation(uuid,bytea,bytea,bytea)','EXECUTE')
  and has_function_privilege('renave_operation_promoter',
    'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)','EXECUTE')
  and not has_table_privilege('renave_operation_promoter',
    'renave_promotion.operation_promotion_signed_artifact','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('renave_operation_promoter',
    'renave_promotion.operation_promotion_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and position('clock_timestamp()' in pg_get_functiondef(
    'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)'::regprocedure))>
      position('pg_advisory_xact_lock' in pg_get_functiondef(
    'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)'::regprocedure))
  and position('binding.jurisdiction_generation<>p_jurisdiction_generation'
      in replace(pg_get_functiondef(
    'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)'::regprocedure),' ',''))>0
  and position('auth_now>=p_expires_at' in replace(pg_get_functiondef(
    'renave_promotion.promote_held_local_operation(uuid,text,uuid,uuid,timestamptz,timestamptz,timestamptz,text,text,bytea,bytea,bytea,bytea,bytea,text,text,bigint,bigint,bigint,uuid,bigint,uuid,bigint)'::regprocedure),' ',''))>0
  and renave_runtime.credential_service_scope_previous_contract_v0069()
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
  renave_runtime.signed_operation_promotion_catalog_fingerprint_v0075()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.signed_operation_promotion_catalog_fingerprint_v0075()$$;
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

create or replace function renave_runtime.operation_promoter_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$select renave_runtime.api_contract_ready()$$;
revoke all on function renave_runtime.operation_promoter_contract_ready()
from public,renave_app,renave_credential_scope_provisioner,
  renave_identity_app,renave_maintenance_app,renave_operation_worker,
  renave_operation_promoter,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_promoter_contract_ready()
to renave_operation_promoter;
