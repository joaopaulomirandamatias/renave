-- 0069 — Âncora final do limitador distribuído do console global.

alter function renave_runtime.api_contract_ready()
  rename to platform_rate_contract_ready_v0068;
revoke all on function renave_runtime.platform_rate_contract_ready_v0068()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;

create function renave_runtime.api_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
select
  (select checksum=
      '982775d7219fb72500deabf8a6828ef3d8a64d1b2d4eca0300e08e05c1adcccb'
    from renave.schema_migrations
    where version='0068_platform_console_rate_limit')
  and renave_runtime.platform_rate_contract_ready_v0068()
$$;
revoke all on function renave_runtime.api_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.api_contract_ready()
to renave_app,renave_identity_app;

create or replace function renave_runtime.operation_worker_contract_ready()
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select renave_runtime.api_contract_ready() $$;
revoke all on function renave_runtime.operation_worker_contract_ready()
from public,renave_app,renave_identity_app,renave_maintenance_app,
  renave_operation_worker,renave_profile_provisioner,renave_profile_reader,
  renave_platform_reader,renave_platform_provisioner;
grant execute on function renave_runtime.operation_worker_contract_ready()
to renave_operation_worker;
