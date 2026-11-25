-- Catálogo nacional. Só o migrator publica uma captura local, em uma transação.
-- A publicação mais recente é a ativa. Tanto release como códigos são imutáveis.
create schema renave_reference authorization renave_migrator;
revoke all on schema renave_reference from public;

create table renave_reference.municipality_catalog_release (
  version text primary key check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  publication_number bigint generated always as identity unique,
  source_kind text not null check (source_kind = 'RENAVE_MUNICIPIOS'),
  source_url text not null check (source_url ~ '^https://[^[:space:]]+$'),
  observed_at timestamptz not null check (isfinite(observed_at)),
  source_sha256 bytea not null check (octet_length(source_sha256) = 32),
  artifact_sha256 bytea not null check (octet_length(artifact_sha256) = 32),
  row_count integer not null check (row_count > 0)
);

create table renave_reference.municipality_catalog_entry (
  release_version text not null references renave_reference.municipality_catalog_release(version)
    deferrable initially deferred,
  code integer not null check (code > 0),
  primary key (release_version, code)
);

create view renave_reference.active_municipality_catalog_release as
  select * from renave_reference.municipality_catalog_release
  order by publication_number desc limit 1;

create function renave_reference.reject_municipality_catalog_change() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Registro do catálogo municipal imutável.' using errcode = '55000';
end
$$;

create trigger immutable_release before update or delete or truncate
on renave_reference.municipality_catalog_release for each statement
execute function renave_reference.reject_municipality_catalog_change();
create trigger immutable_entries before update or delete or truncate
on renave_reference.municipality_catalog_entry for each statement
execute function renave_reference.reject_municipality_catalog_change();

-- A FK diferida permite inserir os códigos antes de selar a release.
create function renave_reference.reject_published_municipality_entries() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if exists (select 1 from new_entries e
      join renave_reference.municipality_catalog_release r on r.version = e.release_version) then
    raise exception 'Release do catálogo municipal já publicada.' using errcode = '55000';
  end if;
  return null;
end
$$;
create trigger reject_published_entries after insert on renave_reference.municipality_catalog_entry
referencing new table as new_entries for each statement
execute function renave_reference.reject_published_municipality_entries();

-- O artefato canônico contém os códigos em decimal, em ordem numérica crescente,
-- cada um terminado por LF, em UTF-8. source_sha256 identifica a captura original.
create function renave_reference.municipality_release_integrity(
  p_version text, p_row_count integer, p_artifact_sha256 bytea
) returns boolean language sql stable set search_path = pg_catalog as $$
  select count(*) = p_row_count and p_row_count > 0 and
         sha256(convert_to(string_agg(code::text || chr(10), '' order by code), 'UTF8')) =
           p_artifact_sha256
    from renave_reference.municipality_catalog_entry where release_version = p_version
$$;

create function renave_reference.validate_municipality_release() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if renave_reference.municipality_release_integrity(
       new.version, new.row_count, new.artifact_sha256) is not true then
    raise exception 'Contagem ou hash do catálogo municipal divergente.' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger validate_release before insert on renave_reference.municipality_catalog_release
for each row execute function renave_reference.validate_municipality_release();

create function renave_reference.publish_municipality_catalog(
  p_version text, p_source_kind text, p_source_url text, p_observed_at timestamptz,
  p_source_sha256 bytea, p_artifact_sha256 bytea, p_row_count integer, p_codes integer[]
) returns void language plpgsql set search_path = pg_catalog as $$
begin
  -- A ordem de publicação acompanha os commits. Leitores podem usar a versão
  -- anterior até que todos os códigos e a nova release fiquem visíveis juntos.
  lock table renave_reference.municipality_catalog_release,
             renave_reference.municipality_catalog_entry in exclusive mode;
  insert into renave_reference.municipality_catalog_entry (release_version, code)
  select p_version, code from unnest(p_codes) as input(code);

  insert into renave_reference.municipality_catalog_release
    (version,source_kind,source_url,observed_at,source_sha256,artifact_sha256,row_count)
  values (p_version,p_source_kind,p_source_url,p_observed_at,p_source_sha256,p_artifact_sha256,p_row_count);
end
$$;

create function renave_reference.lookup_municipality(p_code integer)
returns table (state text, present boolean, release_version text)
language sql stable security definer set search_path = pg_catalog as $$
  with ready as (
    select version from renave_reference.active_municipality_catalog_release r
     where p_code > 0 and renave_reference.municipality_release_integrity(
       r.version, r.row_count, r.artifact_sha256)
  )
  select 'READY'::text, exists (
    select 1 from renave_reference.municipality_catalog_entry e
     where e.release_version = r.version and e.code = p_code
  ), r.version from ready r
  union all
  select 'UNAVAILABLE', null::boolean, null::text where not exists (select 1 from ready)
$$;

revoke all on all tables in schema renave_reference from public;
revoke all on all sequences in schema renave_reference from public;
revoke all on all functions in schema renave_reference from public;
