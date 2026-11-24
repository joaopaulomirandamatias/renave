-- 0020 — Contratos de runtime vinculados à cadeia atual de migrations.

create or replace function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected(version, checksum) as (
    values
      ('0009_tenant_directory', '95139964cbc1419a54d740483d2a4e0aaece5b7be7eaa77b7e9f88a33e524653'),
      ('0010_protected_evidence_operations', 'e6cb7e1b5fdd3ada707cf641974b5280bcf9b3d50a78a91db8c7ed4741e9e319'),
      ('0011_login_rate_limit', 'a49d1a66d095c83f20f4ab8cccd0166e789dbf78143f4387592a2b9a68886348'),
      ('0012_runtime_contract', '0e4e7d69c7298540e70f46e606b97c18b7f193fbd814b09b8e6e765c1a70c913'),
      ('0013_serpro_query_limit', '0b781d990d1d79634a075184fb9f4679c047f7bb0d3be160b99d66535f67027c'),
      ('0014_runtime_contract_checksums', '4430bf61f001ba3deec314e2d5b1ec59c2ee3c77c51c3bc3be0ffc4e2c75043c'),
      ('0015_evidence_monitor_heartbeat', '1f90b6af29d9346e1efafc155fc5f7d8d7d356d0010b64e0d02f82453ebc4e78'),
      ('0016_maintenance_runtime_contract', '8625526936ca47a6f69e84cc1dcf5a49ae73b82bd2aed2b56c0945b37cc55d5d'),
      ('0017_credential_link', 'b7899f4193257dd18ce0a39b455a838963f54ac0d2d95bc1158032e408111783'),
      ('0018_identity_preflight_evidence', '713514e4cf22ef0b2d87715fa4e6e35e63fe4994998ced797e1ff4253fe2a6b1'),
      ('0019_evidence_open_incident_index', 'd268a7dec9b0c4eb62ad7f4e7fa807277078b79fa6ac758ddf2a530efe98b50c')
  )
  select pg_catalog.count(migrations.version) = 11
     and pg_catalog.bool_and(migrations.checksum = expected.checksum)
    from expected
    left join renave.schema_migrations migrations
      on migrations.version = expected.version
$$;

create or replace function renave_runtime.maintenance_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected(version, checksum) as (
    values
      ('0010_protected_evidence_operations', 'e6cb7e1b5fdd3ada707cf641974b5280bcf9b3d50a78a91db8c7ed4741e9e319'),
      ('0015_evidence_monitor_heartbeat', '1f90b6af29d9346e1efafc155fc5f7d8d7d356d0010b64e0d02f82453ebc4e78'),
      ('0016_maintenance_runtime_contract', '8625526936ca47a6f69e84cc1dcf5a49ae73b82bd2aed2b56c0945b37cc55d5d'),
      ('0019_evidence_open_incident_index', 'd268a7dec9b0c4eb62ad7f4e7fa807277078b79fa6ac758ddf2a530efe98b50c')
  )
  select pg_catalog.count(migrations.version) = 4
     and pg_catalog.bool_and(migrations.checksum = expected.checksum)
    from expected
    left join renave.schema_migrations migrations
      on migrations.version = expected.version
$$;

revoke all on function
  renave_runtime.api_contract_ready(),
  renave_runtime.maintenance_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
grant execute on function renave_runtime.maintenance_contract_ready()
to renave_maintenance_app;
