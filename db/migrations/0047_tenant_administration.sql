-- 0047 — Controles transacionais da administração de estabelecimentos.
--
-- Nenhum identificador humano entra nas estruturas operacionais: rate limit e
-- idempotência recebem somente HMAC/SHA-256 de 32 bytes calculados pela API.

alter table renave.establishment
  drop constraint establishment_trade_name_not_blank,
  add constraint establishment_trade_name_valid check (
    pg_catalog.btrim(trade_name) = trade_name
    and pg_catalog.length(trade_name) between 1 and 160
    and trade_name !~ '[[:cntrl:]]'
  );

create table renave.admin_mutation_idempotency (
  tenant_id               uuid        not null references renave.tenant (id) on delete restrict,
  action                  text        not null,
  key_digest              bytea       not null,
  actor_digest            bytea       not null,
  request_digest          bytea       not null,
  result_establishment_id uuid,
  created_at              timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id, action, key_digest),
  foreign key (tenant_id, result_establishment_id)
    references renave.establishment (tenant_id, id) on delete restrict,
  constraint admin_mutation_idempotency_action_valid check (
    action = 'tenant.establishment.create'
  ),
  constraint admin_mutation_idempotency_key_valid check (
    pg_catalog.octet_length(key_digest) = 32
  ),
  constraint admin_mutation_idempotency_actor_valid check (
    pg_catalog.octet_length(actor_digest) = 32
  ),
  constraint admin_mutation_idempotency_request_valid check (
    pg_catalog.octet_length(request_digest) = 32
  )
);

alter table renave.admin_mutation_idempotency enable row level security;
alter table renave.admin_mutation_idempotency force row level security;
create policy admin_mutation_idempotency_isolation
  on renave.admin_mutation_idempotency
  using (tenant_id = (select renave.current_tenant_id()))
  with check (tenant_id = (select renave.current_tenant_id()));

revoke all on renave.admin_mutation_idempotency from public;
grant select, insert on renave.admin_mutation_idempotency to renave_app;
grant update (result_establishment_id)
  on renave.admin_mutation_idempotency to renave_app;

-- Revalida e mantém locks compartilhados até o fim da mesma transação que
-- criará o estabelecimento. Revogações concorrentes precisam dos locks
-- exclusivos do UPDATE/DELETE e, portanto, ficam linearizadas com a criação.
create function renave.lock_current_tenant_admin(p_subject text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  current_id uuid := renave.current_tenant_id();
  current_status text;
begin
  if p_subject is null
     or pg_catalog.btrim(p_subject) <> p_subject
     or pg_catalog.length(p_subject) not between 1 and 255 then
    return false;
  end if;

  select tenant.status into current_status
    from renave.tenant tenant
   where tenant.id = current_id
   for share;
  if current_status is distinct from 'active' then return false; end if;

  select user_account.status into current_status
    from renave.tenant_user user_account
   where user_account.tenant_id = current_id
     and user_account.subject = p_subject
   for share;
  if current_status is distinct from 'active' then return false; end if;

  perform 1
    from renave.tenant_role_grant role_grant
   where role_grant.tenant_id = current_id
     and role_grant.subject = p_subject
     and role_grant.role = 'tenant_admin'
   for share;
  return found;
end
$$;

revoke all on function renave.lock_current_tenant_admin(text)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function renave.lock_current_tenant_admin(text) to renave_app;

-- Token bucket distribuído para mutações administrativas. O limite é aplicado
-- antes da transação de domínio e falha fechado se esta capacidade faltar.
create table renave_runtime.tenant_admin_rate_policy (
  singleton                boolean primary key default true,
  global_capacity          numeric not null,
  global_refill_per_second numeric not null,
  tenant_capacity          numeric not null,
  tenant_refill_per_second numeric not null,
  actor_capacity           numeric not null,
  actor_refill_per_second  numeric not null,
  constraint tenant_admin_rate_policy_singleton check (singleton),
  constraint tenant_admin_rate_policy_values check (
    global_capacity >= 1 and global_refill_per_second > 0
    and tenant_capacity >= 1 and tenant_refill_per_second > 0
    and actor_capacity >= 1 and actor_refill_per_second > 0
  )
);

insert into renave_runtime.tenant_admin_rate_policy values (
  true, 100, 100.0 / 60.0, 30, 30.0 / 60.0, 10, 10.0 / 60.0
);

create table renave_runtime.tenant_admin_rate_bucket (
  scope           text        not null,
  scope_key       bytea       not null,
  available_units numeric     not null,
  last_refill_at  timestamptz not null,
  last_seen_at    timestamptz not null,
  primary key (scope, scope_key),
  constraint tenant_admin_rate_bucket_scope check (
    scope in ('global', 'tenant', 'actor')
  ),
  constraint tenant_admin_rate_bucket_key check (
    pg_catalog.octet_length(scope_key) = 32
  ),
  constraint tenant_admin_rate_bucket_units check (available_units >= 0)
);

create index tenant_admin_rate_bucket_last_seen_idx
  on renave_runtime.tenant_admin_rate_bucket (last_seen_at)
  where scope <> 'global';

revoke all on renave_runtime.tenant_admin_rate_policy,
  renave_runtime.tenant_admin_rate_bucket
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.consume_tenant_admin_rate_limit(
  p_tenant_key bytea,
  p_actor_key bytea
)
returns table (allowed boolean, limited_scope text, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy renave_runtime.tenant_admin_rate_policy%rowtype;
  now_at timestamptz := pg_catalog.clock_timestamp();
  global_key constant bytea := pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
  item record;
  tokens numeric;
  refill numeric;
  global_tokens numeric;
  tenant_tokens numeric;
  actor_tokens numeric;
begin
  if p_tenant_key is null or pg_catalog.octet_length(p_tenant_key) <> 32
     or p_actor_key is null or pg_catalog.octet_length(p_actor_key) <> 32 then
    raise exception 'chave de limite administrativo inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Mantém a cardinalidade limitada mesmo quando um cliente envia muitos
  -- UUIDs válidos e distintos. O global é único e nunca precisa de purge.
  delete from renave_runtime.tenant_admin_rate_bucket stale
   where stale.ctid in (
     select candidate.ctid
       from renave_runtime.tenant_admin_rate_bucket candidate
      where candidate.scope <> 'global'
        and candidate.last_seen_at < now_at - interval '48 hours'
      order by candidate.last_seen_at
      limit 100
      for update skip locked
   );

  select * into strict policy from renave_runtime.tenant_admin_rate_policy
   where singleton = true;

  for item in
    select * from (values
      ('global'::text, global_key, policy.global_capacity,
       policy.global_refill_per_second),
      ('tenant'::text, p_tenant_key, policy.tenant_capacity,
       policy.tenant_refill_per_second),
      ('actor'::text, p_actor_key, policy.actor_capacity,
       policy.actor_refill_per_second)
    ) limits(scope, scope_key, max_units, refill_rate)
  loop
    insert into renave_runtime.tenant_admin_rate_bucket (
      scope, scope_key, available_units, last_refill_at, last_seen_at
    ) values (item.scope, item.scope_key, item.max_units, now_at, now_at)
    on conflict (scope, scope_key) do nothing;

    perform 1
      from renave_runtime.tenant_admin_rate_bucket bucket
     where bucket.scope = item.scope and bucket.scope_key = item.scope_key
     for update;
    -- Requisições concorrentes podem aguardar o lock. Capturar o relógio
    -- somente depois dele evita um intervalo negativo contra last_refill_at.
    now_at := pg_catalog.clock_timestamp();

    select item.refill_rate,
           least(item.max_units,
             bucket.available_units + extract(epoch from (now_at - bucket.last_refill_at))
               * item.refill_rate)
      into refill, tokens
      from renave_runtime.tenant_admin_rate_bucket bucket
     where bucket.scope = item.scope and bucket.scope_key = item.scope_key;

    if tokens < 1 then
      update renave_runtime.tenant_admin_rate_bucket bucket
         set available_units = tokens, last_refill_at = now_at, last_seen_at = now_at
       where bucket.scope = item.scope and bucket.scope_key = item.scope_key;
      return query select false, item.scope,
        greatest(1, pg_catalog.ceil((1 - tokens) / refill)::integer);
      return;
    end if;

    if item.scope = 'global' then global_tokens := tokens;
    elsif item.scope = 'tenant' then tenant_tokens := tokens;
    else actor_tokens := tokens;
    end if;
  end loop;

  update renave_runtime.tenant_admin_rate_bucket bucket
     set available_units = case bucket.scope
           when 'global' then global_tokens - 1
           when 'tenant' then tenant_tokens - 1
           else actor_tokens - 1
         end,
         last_refill_at = now_at,
         last_seen_at = now_at
   where (bucket.scope, bucket.scope_key) in (
     ('global', global_key), ('tenant', p_tenant_key), ('actor', p_actor_key)
   );
  return query select true, null::text, 0;
end
$$;

revoke all on function
  renave_runtime.consume_tenant_admin_rate_limit(bytea, bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave_runtime.consume_tenant_admin_rate_limit(bytea, bytea)
to renave_app;
