-- 0055 — Limite distribuído exclusivo para criação local de entrada de estoque.
-- O runtime recebe somente EXECUTE na função; política e buckets permanecem
-- inacessíveis. Tenant e ator chegam apenas como HMACs de 32 bytes.

create table renave_runtime.stock_entry_rate_policy (
  singleton                boolean primary key default true,
  global_capacity          numeric not null,
  global_refill_per_second numeric not null,
  tenant_capacity          numeric not null,
  tenant_refill_per_second numeric not null,
  actor_capacity           numeric not null,
  actor_refill_per_second  numeric not null,
  constraint stock_entry_rate_policy_singleton check (singleton),
  constraint stock_entry_rate_policy_values check (
    global_capacity >= 1 and global_refill_per_second > 0
    and tenant_capacity >= 1 and tenant_refill_per_second > 0
    and actor_capacity >= 1 and actor_refill_per_second > 0
  )
);

-- Política inicial conservadora: 120/min global, 60/min por tenant e
-- 15/min por ator. O relógio e o refill são sempre calculados no PostgreSQL.
insert into renave_runtime.stock_entry_rate_policy values (
  true, 120, 120.0 / 60.0, 60, 60.0 / 60.0, 15, 15.0 / 60.0
);

create table renave_runtime.stock_entry_rate_bucket (
  scope           text        not null,
  scope_key       bytea       not null,
  available_units numeric     not null,
  last_refill_at  timestamptz not null,
  last_seen_at    timestamptz not null,
  primary key (scope, scope_key),
  constraint stock_entry_rate_bucket_scope check (
    scope in ('global', 'tenant', 'actor')
  ),
  constraint stock_entry_rate_bucket_key check (
    pg_catalog.octet_length(scope_key) = 32
  ),
  constraint stock_entry_rate_bucket_units check (available_units >= 0)
);

create index stock_entry_rate_bucket_last_seen_idx
  on renave_runtime.stock_entry_rate_bucket (last_seen_at)
  where scope <> 'global';

-- O migrator provisiona este registro fora da migration, depois que o bundle
-- criptográfico da implantação é gerado. A ausência do singleton mantém o
-- runtime fail-closed; renave_app não pode criar nem alterar a geração ativa.
create table renave_runtime.stock_entry_runtime_key_generation (
  singleton          boolean primary key default true,
  generation_id      text  not null,
  runtime_fingerprint bytea not null,
  provisioned_at     timestamptz not null default pg_catalog.clock_timestamp(),
  constraint stock_entry_runtime_key_generation_singleton check (singleton),
  constraint stock_entry_runtime_key_generation_id check (
    generation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  constraint stock_entry_runtime_key_generation_fingerprint check (
    pg_catalog.octet_length(runtime_fingerprint) = 32
  )
);

-- O pin é write-once. Rotação futura exige uma migration explícita que
-- versione os digests persistidos e ofereça dual-read/reindex; trocar este
-- singleton em operação reabriria idempotência e unicidade de veículo.
create function renave_runtime.reject_stock_entry_runtime_key_rotation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'a geração de chaves da entrada de estoque é imutável'
    using errcode = 'insufficient_privilege';
end
$$;

revoke all on function
  renave_runtime.reject_stock_entry_runtime_key_rotation()
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create trigger stock_entry_runtime_key_generation_reject_update_delete
  before update or delete
  on renave_runtime.stock_entry_runtime_key_generation
  for each row execute function
    renave_runtime.reject_stock_entry_runtime_key_rotation();

create trigger stock_entry_runtime_key_generation_reject_truncate
  before truncate
  on renave_runtime.stock_entry_runtime_key_generation
  for each statement execute function
    renave_runtime.reject_stock_entry_runtime_key_rotation();

revoke all on renave_runtime.stock_entry_rate_policy,
  renave_runtime.stock_entry_rate_bucket,
  renave_runtime.stock_entry_runtime_key_generation
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;

create function renave_runtime.matches_stock_entry_runtime_key_generation(
  p_generation_id text,
  p_runtime_fingerprint bytea
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  stored_generation_id text;
  stored_fingerprint bytea;
begin
  if p_generation_id is null
     or p_runtime_fingerprint is null
     or pg_catalog.octet_length(p_runtime_fingerprint) <> 32 then
    return false;
  end if;

  select generation.generation_id, generation.runtime_fingerprint
    into stored_generation_id, stored_fingerprint
    from renave_runtime.stock_entry_runtime_key_generation generation
   where generation.singleton = true
   for share;

  return coalesce(
    stored_generation_id = p_generation_id
    and stored_fingerprint = p_runtime_fingerprint,
    false
  );
end
$$;

revoke all on function
  renave_runtime.matches_stock_entry_runtime_key_generation(text, bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave_runtime.matches_stock_entry_runtime_key_generation(text, bytea)
to renave_app;

create function renave_runtime.consume_stock_entry_rate_limit(
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
  policy renave_runtime.stock_entry_rate_policy%rowtype;
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
    raise exception 'chave de limite de entrada de estoque inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into strict policy from renave_runtime.stock_entry_rate_policy
   where singleton = true;

  -- Ordem canônica de lock entre todas as réplicas:
  -- global -> tenant -> actor.
  for item in
    select * from (values
      (1, 'global'::text, global_key, policy.global_capacity,
       policy.global_refill_per_second),
      (2, 'tenant'::text, p_tenant_key, policy.tenant_capacity,
       policy.tenant_refill_per_second),
      (3, 'actor'::text, p_actor_key, policy.actor_capacity,
       policy.actor_refill_per_second)
    ) limits(lock_order, scope, scope_key, max_units, refill_rate)
    order by lock_order
  loop
    insert into renave_runtime.stock_entry_rate_bucket (
      scope, scope_key, available_units, last_refill_at, last_seen_at
    ) values (item.scope, item.scope_key, item.max_units, now_at, now_at)
    on conflict (scope, scope_key) do nothing;

    perform 1
      from renave_runtime.stock_entry_rate_bucket bucket
     where bucket.scope = item.scope and bucket.scope_key = item.scope_key
     for update;

    -- A limpeza só começa depois do lock global. Nenhum consumidor pode
    -- manter um bucket de ator e depois esperar pelo global na ordem inversa.
    if item.scope = 'global' then
      delete from renave_runtime.stock_entry_rate_bucket stale
       where stale.ctid in (
         select candidate.ctid
           from renave_runtime.stock_entry_rate_bucket candidate
          where candidate.scope <> 'global'
            and candidate.last_seen_at < now_at - interval '48 hours'
          order by candidate.last_seen_at
          limit 100
          for update skip locked
       );
    end if;

    -- Uma requisição pode ter aguardado o lock; só então o relógio é lido.
    now_at := pg_catalog.clock_timestamp();

    select item.refill_rate,
           least(item.max_units,
             bucket.available_units
             + extract(epoch from (now_at - bucket.last_refill_at))
               * item.refill_rate)
      into refill, tokens
      from renave_runtime.stock_entry_rate_bucket bucket
     where bucket.scope = item.scope and bucket.scope_key = item.scope_key;

    if tokens < 1 then
      update renave_runtime.stock_entry_rate_bucket bucket
         set available_units = tokens,
             last_refill_at = now_at,
             last_seen_at = now_at
       where bucket.scope = item.scope and bucket.scope_key = item.scope_key;
      return query select false, item.scope,
        greatest(
          1,
          pg_catalog.ceil((1 - tokens) / refill)::integer
        );
      return;
    end if;

    if item.scope = 'global' then global_tokens := tokens;
    elsif item.scope = 'tenant' then tenant_tokens := tokens;
    else actor_tokens := tokens;
    end if;
  end loop;

  update renave_runtime.stock_entry_rate_bucket bucket
     set available_units = case bucket.scope
           when 'global' then global_tokens - 1
           when 'tenant' then tenant_tokens - 1
           else actor_tokens - 1
         end,
         last_refill_at = now_at,
         last_seen_at = now_at
   where (bucket.scope, bucket.scope_key) in (
     ('global', global_key),
     ('tenant', p_tenant_key),
     ('actor', p_actor_key)
   );

  return query select true, null::text, 0;
end
$$;

revoke all on function
  renave_runtime.consume_stock_entry_rate_limit(bytea, bytea)
from public, renave_app, renave_identity_app, renave_maintenance_app,
     renave_operation_worker;
grant execute on function
  renave_runtime.consume_stock_entry_rate_limit(bytea, bytea)
to renave_app;
