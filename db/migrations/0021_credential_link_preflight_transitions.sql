-- 0021 — Transições idempotentes e serializadas para o preflight RENAVE.

create function renave.confirm_credential_link_from_preflight(
  p_establishment_id uuid,
  p_changed_by_subject_hash bytea
)
returns renave.credential_link
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_link renave.credential_link;
begin
  if active_tenant is null or p_establishment_id is null
     or p_changed_by_subject_hash is null
     or pg_catalog.octet_length(p_changed_by_subject_hash) <> 32 then
    raise exception 'credential_link: preflight inválido'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(active_tenant::text || ':' || p_establishment_id::text, 170017)
  );
  select link.* into current_link
    from renave.credential_link link
   where link.tenant_id = active_tenant
     and link.establishment_id = p_establishment_id
   for update;

  if found and current_link.status in ('confirmed', 'enabled') then
    return current_link;
  end if;
  if not found or current_link.status in ('rejected', 'deactivated') then
    current_link := renave.transition_credential_link(
      p_establishment_id, 'pending', 'serpro_preflight',
      p_changed_by_subject_hash, 'Identidade RENAVE validada pelo preflight'
    );
  end if;
  return renave.transition_credential_link(
    p_establishment_id, 'confirmed', 'serpro_preflight',
    p_changed_by_subject_hash, 'Identidade RENAVE confirmada pelo preflight'
  );
end;
$$;

create function renave.reject_credential_link_from_preflight(
  p_establishment_id uuid,
  p_changed_by_subject_hash bytea
)
returns renave.credential_link
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_tenant uuid := renave.current_tenant_id();
  current_link renave.credential_link;
begin
  if active_tenant is null or p_establishment_id is null
     or p_changed_by_subject_hash is null
     or pg_catalog.octet_length(p_changed_by_subject_hash) <> 32 then
    raise exception 'credential_link: preflight inválido'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(active_tenant::text || ':' || p_establishment_id::text, 170017)
  );
  select link.* into current_link
    from renave.credential_link link
   where link.tenant_id = active_tenant
     and link.establishment_id = p_establishment_id
   for update;

  if not found then
    current_link := renave.transition_credential_link(
      p_establishment_id, 'pending', 'serpro_preflight',
      p_changed_by_subject_hash, 'Preflight RENAVE iniciado'
    );
  end if;
  if current_link.status in ('rejected', 'deactivated') then
    return current_link;
  end if;
  if current_link.status = 'enabled' then
    return renave.transition_credential_link(
      p_establishment_id, 'deactivated', 'serpro_preflight',
      p_changed_by_subject_hash, 'Divergência de identidade no preflight RENAVE'
    );
  end if;
  return renave.transition_credential_link(
    p_establishment_id, 'rejected', 'serpro_preflight',
    p_changed_by_subject_hash, 'Divergência de identidade no preflight RENAVE'
  );
end;
$$;

revoke all on function
  renave.confirm_credential_link_from_preflight(uuid, bytea),
  renave.reject_credential_link_from_preflight(uuid, bytea)
from public, renave_identity_app, renave_maintenance_app;
grant execute on function
  renave.confirm_credential_link_from_preflight(uuid, bytea),
  renave.reject_credential_link_from_preflight(uuid, bytea)
to renave_app;
