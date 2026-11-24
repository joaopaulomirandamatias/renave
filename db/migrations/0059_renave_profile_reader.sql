-- 0059 — Consulta sanitizada de perfis por papel exclusivamente leitor.
--
-- O reader é global e operacional: recebe somente EXECUTE nas duas rotinas
-- fechadas de status, sem acesso direto aos schemas/tabelas de negócio.

revoke all on schema renave_admin from renave_profile_reader;
grant usage on schema renave_admin to renave_profile_reader;

create function renave_admin.assert_profile_reader()
returns void language plpgsql stable security definer set search_path=pg_catalog
as $$
begin
  if session_user <> 'renave_profile_reader'
     or current_user <> 'renave_migrator' then
    raise exception 'profile status: papel inválido'
      using errcode='insufficient_privilege';
  end if;
  if not coalesce(renave_runtime.api_contract_ready(),false) then
    raise exception 'profile status: contrato indisponível'
      using errcode='insufficient_privilege';
  end if;
end
$$;

create or replace function renave_admin.get_operator_status(
  p_tenant_id uuid,p_subject text
)
returns table(profile_id uuid,profile_status text,profile_version bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform renave_admin.assert_profile_reader();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  return query select p.id,p.status,p.version,p.updated_at
    from renave.operator_identity_profile p
    where p.tenant_id=p_tenant_id and p.subject=p_subject;
end $$;

create or replace function renave_admin.get_establishment_status(
  p_tenant_id uuid,p_establishment_id uuid
)
returns table(profile_id uuid,profile_status text,profile_version bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform renave_admin.assert_profile_reader();
  perform set_config('renave.tenant_id',p_tenant_id::text,true);
  return query select p.id,p.status,p.version,p.updated_at
    from renave.establishment_renave_profile p
    where p.tenant_id=p_tenant_id and p.establishment_id=p_establishment_id;
end $$;

revoke all on all functions in schema renave_admin from renave_profile_reader;
revoke execute on function
  renave_admin.get_operator_status(uuid,text),
  renave_admin.get_establishment_status(uuid,uuid)
from renave_profile_provisioner;
grant execute on function
  renave_admin.get_operator_status(uuid,text),
  renave_admin.get_establishment_status(uuid,uuid)
to renave_profile_reader;

revoke all on all tables in schema renave from renave_profile_reader;
revoke all on all sequences in schema renave from renave_profile_reader;
revoke all on schema renave from renave_profile_reader;

-- Nenhum fallback: provisioner muta, reader consulta.
