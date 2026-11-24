-- 0012 — Contrato mínimo e fechado para os papéis de runtime da API.
--
-- A aplicação não recebe leitura do ledger de migrations. Ela pode apenas
-- perguntar se as migrations que compõem o contrato atual estão presentes.

create schema renave_runtime;
revoke all on schema renave_runtime
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant usage on schema renave_runtime to renave_app, renave_identity_app;

create function renave_runtime.api_contract_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.count(*) = 3
    from renave.schema_migrations migrations
   where migrations.version = any (
     array[
       '0009_tenant_directory',
       '0010_protected_evidence_operations',
       '0011_login_rate_limit'
     ]::text[]
   )
$$;

revoke all on function renave_runtime.api_contract_ready()
from public, renave_app, renave_identity_app, renave_maintenance_app;
grant execute on function renave_runtime.api_contract_ready()
to renave_app, renave_identity_app;
