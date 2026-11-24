-- 0016 — Contrato fechado do runtime de manutenção.
--
-- O job confirma apenas que as migrations necessárias estão íntegras. Ele não
-- recebe leitura do ledger nem de tabelas de evidência.

create function renave_runtime.maintenance_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with expected(version, checksum) as (
    values
      ('0010_protected_evidence_operations', 'e6cb7e1b5fdd3ada707cf641974b5280bcf9b3d50a78a91db8c7ed4741e9e319'),
      ('0015_evidence_monitor_heartbeat', '1f90b6af29d9346e1efafc155fc5f7d8d7d356d0010b64e0d02f82453ebc4e78')
  )
  select pg_catalog.count(migrations.version) = 2
     and pg_catalog.bool_and(migrations.checksum = expected.checksum)
    from expected
    left join renave.schema_migrations migrations
      on migrations.version = expected.version
$$;

revoke all on function renave_runtime.maintenance_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant usage on schema renave_runtime to renave_maintenance_app;
grant execute on function renave_runtime.maintenance_contract_ready()
to renave_maintenance_app;
