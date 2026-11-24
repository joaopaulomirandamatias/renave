-- 0006 — Evidência probatória cifrada e isolada por tenant.
--
-- O banco nunca recebe payload em texto claro. A API cifra request/response
-- com AES-256-GCM antes do INSERT/UPDATE; key_id identifica a chave no cofre,
-- mas nenhum material criptográfico é persistido aqui.

create table renave.protected_evidence (
  id                        uuid        primary key,
  tenant_id                 uuid        not null,
  establishment_id          uuid        not null,
  action                    text        not null,
  status                    text        not null default 'pending',
  request_key_id            text        not null,
  request_nonce             bytea       not null,
  request_auth_tag          bytea       not null,
  request_ciphertext        bytea       not null,
  response_key_id           text,
  response_nonce            bytea,
  response_auth_tag         bytea,
  response_ciphertext       bytea,
  failure_code              text,
  created_at                timestamptz not null default pg_catalog.clock_timestamp(),
  finalized_at              timestamptz,
  updated_at                timestamptz not null default pg_catalog.clock_timestamp(),
  constraint protected_evidence_establishment_fk
    foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint protected_evidence_action_valid
    check (action = 'renave.vehicle.eligibility.read'),
  constraint protected_evidence_status_valid
    check (status in ('pending', 'completed', 'failed')),
  constraint protected_evidence_request_key_id_valid
    check (request_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  constraint protected_evidence_request_nonce_valid
    check (pg_catalog.octet_length(request_nonce) = 12),
  constraint protected_evidence_request_tag_valid
    check (pg_catalog.octet_length(request_auth_tag) = 16),
  constraint protected_evidence_request_ciphertext_valid
    check (pg_catalog.octet_length(request_ciphertext) between 1 and 1048576),
  constraint protected_evidence_response_key_id_valid
    check (
      response_key_id is null
      or response_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  constraint protected_evidence_response_nonce_valid
    check (response_nonce is null or pg_catalog.octet_length(response_nonce) = 12),
  constraint protected_evidence_response_tag_valid
    check (response_auth_tag is null or pg_catalog.octet_length(response_auth_tag) = 16),
  constraint protected_evidence_response_ciphertext_valid
    check (
      response_ciphertext is null
      or pg_catalog.octet_length(response_ciphertext) between 1 and 1048576
    ),
  constraint protected_evidence_failure_code_valid
    check (
      failure_code is null
      or failure_code ~ '^[A-Z][A-Z0-9_]{2,79}$'
    ),
  constraint protected_evidence_state_shape check (
    (
      status = 'pending'
      and response_key_id is null
      and response_nonce is null
      and response_auth_tag is null
      and response_ciphertext is null
      and failure_code is null
      and finalized_at is null
    )
    or (
      status = 'completed'
      and response_key_id is not null
      and response_nonce is not null
      and response_auth_tag is not null
      and response_ciphertext is not null
      and failure_code is null
      and finalized_at is not null
    )
    or (
      status = 'failed'
      and response_key_id is null
      and response_nonce is null
      and response_auth_tag is null
      and response_ciphertext is null
      and failure_code is not null
      and finalized_at is not null
    )
  ),
  constraint protected_evidence_tenant_id_key unique (tenant_id, id)
);

create index protected_evidence_tenant_establishment_created_idx
  on renave.protected_evidence (tenant_id, establishment_id, created_at desc);

create function renave.protected_evidence_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'protected_evidence: INSERT deve iniciar pendente'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.establishment_id is distinct from old.establishment_id
     or new.action is distinct from old.action
     or new.request_key_id is distinct from old.request_key_id
     or new.request_nonce is distinct from old.request_nonce
     or new.request_auth_tag is distinct from old.request_auth_tag
     or new.request_ciphertext is distinct from old.request_ciphertext
     or new.created_at is distinct from old.created_at then
    raise exception 'protected_evidence: identidade/request são imutáveis'
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.status <> 'pending' or new.status not in ('completed', 'failed') then
    raise exception 'protected_evidence: transição inválida'
      using errcode = 'integrity_constraint_violation';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  new.finalized_at := pg_catalog.clock_timestamp();
  return new;
end
$$;

create trigger protected_evidence_guard
  before insert or update on renave.protected_evidence
  for each row execute function renave.protected_evidence_guard();

alter table renave.protected_evidence enable row level security;
alter table renave.protected_evidence force row level security;

create policy protected_evidence_isolation on renave.protected_evidence
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

revoke all on renave.protected_evidence from public, renave_app;
grant select, insert on renave.protected_evidence to renave_app;
grant update (
  status,
  response_key_id,
  response_nonce,
  response_auth_tag,
  response_ciphertext,
  failure_code,
  finalized_at,
  updated_at
) on renave.protected_evidence to renave_app;
