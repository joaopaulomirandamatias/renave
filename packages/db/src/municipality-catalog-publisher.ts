import type { Pool, PoolClient, PoolConfig } from "pg";

import { MIGRATOR_ROLE } from "./config.js";
import {
  municipalityCatalogSnapshotContract,
  type VerifiedMunicipalityCatalogSnapshot,
  verifyMunicipalityCatalogSnapshotFiles,
} from "./municipality-catalog-publication.js";

const MAXIMUM_AGE_MS_LIMIT = 24 * 60 * 60 * 1_000;
const SOURCE_KIND = "RENAVE_MUNICIPIOS";
const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
// Mesma chave do runner em migrate.ts; a variante xact conflita com o lock
// de sessão e é liberada automaticamente no fim desta publicação.
const MIGRATION_ADVISORY_LOCK_KEY = 7_265_110_001;

interface PublicationRoleRow {
  current_user: string;
  has_set_role: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolsuper: boolean;
  session_user: string;
}

interface ReleaseRow {
  artifact_sha256: string;
  integrity: boolean;
  observed_at: Date;
  row_count: number;
  source_kind: string;
  source_sha256: string;
  source_url: string;
  version: string;
}

export interface MunicipalityCatalogPublicationPolicy {
  maximumAgeMs: number;
  now: Date;
}

export interface MunicipalityCatalogPublicationResult {
  outcome: "already_active" | "published";
  rowCount: number;
  version: string;
}

export class MunicipalityCatalogPublicationRejectedError extends Error {
  readonly code = "MUNICIPALITY_CATALOG_PUBLICATION_REJECTED";
  override name = "MunicipalityCatalogPublicationRejectedError";

  constructor() {
    super("A publicação do catálogo municipal RENAVE foi recusada.");
  }
}

/** @internal Exportado para testar a política de conexão sem abrir socket. */
export function municipalityCatalogPublisherPoolConfig(
  connectionString: string,
  databaseCa: string | undefined,
): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return rejected();
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.search !== "" ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    rejected();
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (!loopback && !databaseCa) rejected();
  return {
    application_name: "renavestoque-municipality-catalog-publisher",
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 1,
    query_timeout: 35_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    ...(databaseCa
      ? { ssl: { ca: databaseCa, rejectUnauthorized: true } }
      : {}),
  };
}

function rejected(): never {
  throw new MunicipalityCatalogPublicationRejectedError();
}

function assertPublicationPolicy(
  snapshot: VerifiedMunicipalityCatalogSnapshot,
  policy: MunicipalityCatalogPublicationPolicy,
): void {
  const now = policy?.now;
  const maximumAgeMs = policy?.maximumAgeMs;
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 1 ||
    maximumAgeMs > MAXIMUM_AGE_MS_LIMIT
  ) {
    rejected();
  }
  const observedAt = Date.parse(snapshot.observedAt);
  const age = now.getTime() - observedAt;
  if (!Number.isFinite(observedAt) || age < 0 || age > maximumAgeMs) {
    rejected();
  }
}

function releaseMatches(
  row: ReleaseRow | undefined,
  snapshot: VerifiedMunicipalityCatalogSnapshot,
): boolean {
  return (
    row !== undefined &&
    row.version === snapshot.version &&
    row.observed_at instanceof Date &&
    row.observed_at.toISOString() === snapshot.observedAt &&
    row.source_kind === SOURCE_KIND &&
    row.source_url === municipalityCatalogSnapshotContract.sourceUrl &&
    row.source_sha256 === snapshot.sourceSha256 &&
    row.artifact_sha256 === snapshot.artifactSha256 &&
    row.row_count === snapshot.rowCount &&
    row.integrity === true
  );
}

/** @internal Predicado puro para provar todos os bits do papel de publicação. */
export function municipalityCatalogPublisherRoleIsSafe(
  item: PublicationRoleRow | undefined,
): boolean {
  return (
    item !== undefined &&
    item.current_user === MIGRATOR_ROLE &&
    item.session_user === MIGRATOR_ROLE &&
    item.rolcanlogin &&
    !item.rolsuper &&
    !item.rolbypassrls &&
    !item.rolinherit &&
    !item.rolcreatedb &&
    !item.rolcreaterole &&
    !item.rolreplication &&
    !item.has_set_role
  );
}

async function assertPublicationDatabase(client: PoolClient): Promise<void> {
  const role = await client.query<PublicationRoleRow>(
    `select
       current_user,
       session_user,
       roles.rolcanlogin,
       roles.rolsuper,
       roles.rolbypassrls,
       roles.rolinherit,
       roles.rolcreatedb,
       roles.rolcreaterole,
       roles.rolreplication,
       exists (
         select 1
           from pg_catalog.pg_roles candidate
          where candidate.rolname <> current_user
            and pg_catalog.pg_has_role(current_user, candidate.oid, 'set')
       ) as has_set_role
     from pg_catalog.pg_roles roles
    where roles.rolname = current_user`,
  );
  const item = role.rows[0];
  if (!municipalityCatalogPublisherRoleIsSafe(item)) rejected();
  const contract = await client.query<{ ready: boolean }>(
    `select
       renave_runtime.municipality_catalog_contract_ready_v0081()
         and renave_runtime.api_contract_ready() as ready`,
  );
  if (contract.rows[0]?.ready !== true) rejected();
}

async function assertDatabaseFreshness(
  client: PoolClient,
  snapshot: VerifiedMunicipalityCatalogSnapshot,
  maximumAgeMs: number,
): Promise<void> {
  const result = await client.query<{ fresh: boolean }>(
    `select
       $1::timestamptz <= pg_catalog.clock_timestamp()
       and $1::timestamptz >= pg_catalog.clock_timestamp()
         - ($2::double precision * interval '1 millisecond') as fresh`,
    [snapshot.observedAt, maximumAgeMs],
  );
  if (result.rows[0]?.fresh !== true) rejected();
}

async function readRelease(
  client: PoolClient,
  where: "active" | "version",
  version: string,
): Promise<ReleaseRow | undefined> {
  const condition =
    where === "active"
      ? "release.version = active.version"
      : "release.version = $1";
  const result = await client.query<ReleaseRow>(
    `select
       release.version,
       release.observed_at,
       release.source_kind,
       release.source_url,
       pg_catalog.encode(release.source_sha256, 'hex') as source_sha256,
       pg_catalog.encode(release.artifact_sha256, 'hex') as artifact_sha256,
       release.row_count,
       renave_reference.municipality_release_integrity(
         release.version, release.row_count, release.artifact_sha256
       ) as integrity
     from renave_reference.municipality_catalog_release release
     ${where === "active" ? "join renave_reference.active_municipality_catalog_release active on true" : ""}
    where ${condition}`,
    where === "active" ? [] : [version],
  );
  if (result.rowCount !== 0 && result.rowCount !== 1) rejected();
  return result.rows[0];
}

export async function publishVerifiedMunicipalityCatalog(
  pool: Pool,
  snapshot: VerifiedMunicipalityCatalogSnapshot,
  policy: MunicipalityCatalogPublicationPolicy,
): Promise<MunicipalityCatalogPublicationResult> {
  assertPublicationPolicy(snapshot, policy);
  const client = await pool.connect().catch(() => rejected());
  let broken = false;
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config($1, $2, true)", [
      "statement_timeout",
      String(STATEMENT_TIMEOUT_MS),
    ]);
    await client.query("select pg_catalog.set_config($1, $2, true)", [
      "lock_timeout",
      String(LOCK_TIMEOUT_MS),
    ]);
    await client.query("select pg_catalog.set_config($1, $2, true)", [
      "idle_in_transaction_session_timeout",
      String(STATEMENT_TIMEOUT_MS),
    ]);
    await assertPublicationDatabase(client);
    await client.query("select pg_catalog.pg_advisory_xact_lock($1)", [
      MIGRATION_ADVISORY_LOCK_KEY.toString(),
    ]);
    await assertPublicationDatabase(client);
    await client.query(
      `lock table renave_reference.municipality_catalog_release,
                  renave_reference.municipality_catalog_entry
         in exclusive mode`,
    );
    await assertDatabaseFreshness(client, snapshot, policy.maximumAgeMs);

    const active = await readRelease(client, "active", snapshot.version);
    if (active !== undefined && active.integrity !== true) rejected();
    if (active?.version === snapshot.version) {
      if (!releaseMatches(active, snapshot)) rejected();
      await assertPublicationDatabase(client);
      await client.query("commit");
      return Object.freeze({
        outcome: "already_active",
        rowCount: snapshot.rowCount,
        version: snapshot.version,
      });
    }
    if (
      active !== undefined &&
      active.observed_at.getTime() >= Date.parse(snapshot.observedAt)
    ) {
      rejected();
    }
    if (
      (await readRelease(client, "version", snapshot.version)) !== undefined
    ) {
      rejected();
    }

    await client.query(
      `select renave_reference.publish_municipality_catalog(
         $1, $2, $3, $4::timestamptz,
         pg_catalog.decode($5, 'hex'), pg_catalog.decode($6, 'hex'),
         $7, $8::integer[]
       )`,
      [
        snapshot.version,
        SOURCE_KIND,
        municipalityCatalogSnapshotContract.sourceUrl,
        snapshot.observedAt,
        snapshot.sourceSha256,
        snapshot.artifactSha256,
        snapshot.rowCount,
        snapshot.codes,
      ],
    );
    await client.query("set constraints all immediate");
    const published = await readRelease(client, "active", snapshot.version);
    if (!releaseMatches(published, snapshot)) rejected();
    await assertPublicationDatabase(client);
    await client.query("commit");
    return Object.freeze({
      outcome: "published",
      rowCount: snapshot.rowCount,
      version: snapshot.version,
    });
  } catch (error) {
    broken = true;
    try {
      await client.query("rollback");
    } catch {}
    if (error instanceof MunicipalityCatalogPublicationRejectedError) {
      throw error;
    }
    rejected();
  } finally {
    client.release(broken ? true : undefined);
  }
  return rejected();
}

export async function publishMunicipalityCatalogSnapshotFiles(input: {
  expectedManifestSha256: string;
  manifestPath: string;
  maximumAgeMs: number;
  now: Date;
  pool: Pool;
  sourcePath: string;
}): Promise<MunicipalityCatalogPublicationResult> {
  try {
    const snapshot = await verifyMunicipalityCatalogSnapshotFiles({
      expectedManifestSha256: input.expectedManifestSha256,
      manifestPath: input.manifestPath,
      sourcePath: input.sourcePath,
    });
    return await publishVerifiedMunicipalityCatalog(input.pool, snapshot, {
      maximumAgeMs: input.maximumAgeMs,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof MunicipalityCatalogPublicationRejectedError) {
      throw error;
    }
    rejected();
  }
}

export const municipalityCatalogPublicationContract = Object.freeze({
  maximumAgeMsLimit: MAXIMUM_AGE_MS_LIMIT,
});
