-- 0014 — Contrato de runtime vinculado aos checksums das migrations.
--
-- O runtime não lê o ledger. A função SECURITY DEFINER compara internamente
-- nomes e SHA-256 esperados e devolve somente um booleano.

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
      ('0013_serpro_query_limit', '0b781d990d1d79634a075184fb9f4679c047f7bb0d3be160b99d66535f67027c')
  )
  select pg_catalog.count(migrations.version) = 5
     and pg_catalog.bool_and(migrations.checksum = expected.checksum)
    from expected
    left join renave.schema_migrations migrations
      on migrations.version = expected.version
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
