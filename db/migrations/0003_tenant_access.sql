-- 0003 — Vínculo do subject OIDC a papéis do tenant e escopos de loja.
--
-- Não armazena token, senha, e-mail ou CPF. O subject vem do IdP validado; o
-- CPF necessário às mutações RENAVE será resolvido por um provedor cifrado.

create table renave.tenant_user (
  tenant_id  uuid        not null references renave.tenant (id) on delete restrict,
  subject    text        not null,
  status     text        not null default 'active',
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, subject),
  constraint tenant_user_subject_valid check (
    pg_catalog.btrim(subject) = subject and pg_catalog.length(subject) between 1 and 255
  ),
  constraint tenant_user_status_valid check (status in ('active', 'suspended'))
);

create table renave.tenant_role_grant (
  tenant_id  uuid        not null,
  subject    text        not null,
  role       text        not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, subject, role),
  foreign key (tenant_id, subject)
    references renave.tenant_user (tenant_id, subject) on delete cascade,
  constraint tenant_role_grant_role_valid check (
    role in ('tenant_admin', 'renave_operator', 'compliance_auditor')
  )
);

create table renave.establishment_role_scope (
  tenant_id       uuid        not null,
  subject         text        not null,
  role            text        not null default 'renave_operator',
  establishment_id uuid       not null,
  created_at      timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, subject, role, establishment_id),
  foreign key (tenant_id, subject, role)
    references renave.tenant_role_grant (tenant_id, subject, role) on delete cascade,
  foreign key (tenant_id, establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint establishment_role_scope_operator_only check (role = 'renave_operator')
);

create index tenant_user_subject_idx on renave.tenant_user (subject, tenant_id);
create index establishment_role_scope_establishment_idx
  on renave.establishment_role_scope (tenant_id, establishment_id, subject);

create trigger tenant_user_touch_updated_at
  before update on renave.tenant_user
  for each row execute function renave.touch_updated_at();

alter table renave.tenant_user enable row level security;
alter table renave.tenant_user force row level security;
alter table renave.tenant_role_grant enable row level security;
alter table renave.tenant_role_grant force row level security;
alter table renave.establishment_role_scope enable row level security;
alter table renave.establishment_role_scope force row level security;

create policy tenant_user_isolation on renave.tenant_user
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy tenant_role_grant_isolation on renave.tenant_role_grant
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

create policy establishment_role_scope_isolation on renave.establishment_role_scope
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

revoke all on renave.tenant_user, renave.tenant_role_grant,
  renave.establishment_role_scope from public;
grant select on renave.tenant_user, renave.tenant_role_grant,
  renave.establishment_role_scope to renave_app;
