-- 0011 — Token bucket distribuído para o início público do login OIDC.
--
-- O endereço do cliente nunca chega a este schema. A API envia somente um
-- HMAC-SHA-256 de 32 bytes, calculado com segredo externo ao banco.

create table renave_identity.login_rate_policy (
  singleton               boolean primary key default true,
  global_capacity         numeric not null,
  global_refill_per_second numeric not null,
  client_capacity         numeric not null,
  client_refill_per_second numeric not null,
  constraint login_rate_policy_singleton check (singleton),
  constraint login_rate_policy_values check (
    global_capacity >= 1
    and global_refill_per_second > 0
    and client_capacity >= 1
    and client_refill_per_second > 0
  )
);

insert into renave_identity.login_rate_policy (
  singleton,
  global_capacity,
  global_refill_per_second,
  client_capacity,
  client_refill_per_second
) values (true, 200, 20, 10, 0.5);

create table renave_identity.login_rate_bucket (
  scope          text        not null,
  client_key     bytea       not null,
  available_units numeric     not null,
  last_refill_at timestamptz not null,
  last_seen_at   timestamptz not null,
  primary key (scope, client_key),
  constraint login_rate_bucket_scope check (scope in ('global', 'client')),
  constraint login_rate_bucket_key check (
    pg_catalog.octet_length(client_key) = 32
  ),
  constraint login_rate_bucket_units check (available_units >= 0)
);

create index login_rate_bucket_last_seen_idx
  on renave_identity.login_rate_bucket (last_seen_at)
  where scope = 'client';

revoke all on renave_identity.login_rate_policy,
  renave_identity.login_rate_bucket
from public, renave_app, renave_identity_app;

create function renave_identity.consume_login_rate_limit(p_client_key bytea)
returns table (
  allowed boolean,
  limited_scope text,
  retry_after_seconds integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy renave_identity.login_rate_policy%rowtype;
  now_at timestamptz := pg_catalog.clock_timestamp();
  global_key constant bytea := pg_catalog.decode(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  );
  global_tokens numeric;
  client_tokens numeric;
  global_units numeric;
  client_units numeric;
  global_refilled_at timestamptz;
  client_refilled_at timestamptz;
begin
  if p_client_key is null or pg_catalog.octet_length(p_client_key) <> 32 then
    raise exception 'chave de rate limit inválida'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into strict policy
    from renave_identity.login_rate_policy
   where singleton = true;

  insert into renave_identity.login_rate_bucket (
    scope, client_key, available_units, last_refill_at, last_seen_at
  ) values (
    'global', global_key, policy.global_capacity, now_at, now_at
  ) on conflict (scope, client_key) do nothing;

  select bucket.available_units, bucket.last_refill_at
    into strict global_units, global_refilled_at
    from renave_identity.login_rate_bucket bucket
   where bucket.scope = 'global' and bucket.client_key = global_key
   for update;
  now_at := pg_catalog.clock_timestamp();
  global_tokens := least(
    policy.global_capacity,
    global_units + extract(epoch from (now_at - global_refilled_at)) *
      policy.global_refill_per_second
  );

  if global_tokens < 1 then
    update renave_identity.login_rate_bucket bucket
       set available_units = global_tokens,
           last_refill_at = now_at,
           last_seen_at = now_at
     where bucket.scope = 'global' and bucket.client_key = global_key;
    return query select false, 'global'::text,
      greatest(
        1,
        pg_catalog.ceil(
          (1 - global_tokens) / policy.global_refill_per_second
        )::integer
      );
    return;
  end if;

  insert into renave_identity.login_rate_bucket (
    scope, client_key, available_units, last_refill_at, last_seen_at
  ) values (
    'client', p_client_key, policy.client_capacity, now_at, now_at
  ) on conflict (scope, client_key) do nothing;

  select bucket.available_units, bucket.last_refill_at
    into strict client_units, client_refilled_at
    from renave_identity.login_rate_bucket bucket
   where bucket.scope = 'client' and bucket.client_key = p_client_key
   for update;
  now_at := pg_catalog.clock_timestamp();
  client_tokens := least(
    policy.client_capacity,
    client_units + extract(epoch from (now_at - client_refilled_at)) *
      policy.client_refill_per_second
  );

  if client_tokens < 1 then
    update renave_identity.login_rate_bucket bucket
       set available_units = client_tokens,
           last_refill_at = now_at,
           last_seen_at = now_at
     where bucket.scope = 'client' and bucket.client_key = p_client_key;
    return query select false, 'client'::text,
      greatest(
        1,
        pg_catalog.ceil(
          (1 - client_tokens) / policy.client_refill_per_second
        )::integer
      );
    return;
  end if;

  update renave_identity.login_rate_bucket bucket
     set available_units = global_tokens - 1,
         last_refill_at = now_at,
         last_seen_at = now_at
   where bucket.scope = 'global' and bucket.client_key = global_key;
  update renave_identity.login_rate_bucket bucket
     set available_units = client_tokens - 1,
         last_refill_at = now_at,
         last_seen_at = now_at
   where bucket.scope = 'client' and bucket.client_key = p_client_key;

  return query select true, null::text, 0;
end
$$;

revoke all on function renave_identity.consume_login_rate_limit(bytea)
from public, renave_app, renave_identity_app;

grant execute on function renave_identity.consume_login_rate_limit(bytea)
to renave_identity_app;

create function renave_identity.purge_stale_login_rate_buckets(
  p_batch_size integer
)
returns integer
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  with stale as (
    select bucket.scope, bucket.client_key
      from renave_identity.login_rate_bucket bucket
     where bucket.scope = 'client'
       and bucket.last_seen_at < pg_catalog.clock_timestamp() - interval '48 hours'
     order by bucket.last_seen_at
     for update skip locked
     limit case when p_batch_size between 1 and 10000 then p_batch_size else 0 end
  ), deleted as (
    delete from renave_identity.login_rate_bucket bucket
     using stale
     where bucket.scope = stale.scope
       and bucket.client_key = stale.client_key
    returning 1
  )
  select pg_catalog.count(*)::integer from deleted
$$;

revoke all on function
  renave_identity.purge_stale_login_rate_buckets(integer)
from public, renave_app, renave_identity_app;

grant execute on function
  renave_identity.purge_stale_login_rate_buckets(integer)
to renave_identity_app;
