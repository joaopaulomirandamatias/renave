import type { TenantClient } from "./tenant-context.js";

export const credentialServiceNatures = [
  "establishment",
  "ite",
  "manufacturer",
] as const;

export const credentialServiceScopeStatuses = [
  "pending",
  "enabled",
  "suspended",
  "revoked",
] as const;

export const brazilianJurisdictionUfs = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
] as const;

export type CredentialServiceNature = (typeof credentialServiceNatures)[number];
export type CredentialServiceScopeStatus =
  (typeof credentialServiceScopeStatuses)[number];
export type BrazilianJurisdictionUf = (typeof brazilianJurisdictionUfs)[number];
export type EstablishmentRegulatoryJurisdictionStatus =
  "verified" | "suspended" | "revoked";

export interface CredentialServiceScope {
  establishmentId: string;
  expiresAt: Date;
  generation: string;
  jurisdictionGeneration: string | null;
  jurisdictionUf: BrazilianJurisdictionUf;
  serviceNature: CredentialServiceNature;
  status: CredentialServiceScopeStatus;
  tenantId: string;
  updatedAt: Date;
  validFrom: Date;
  version: string;
}

export interface TransitionCredentialServiceScopeInput {
  changedByDigest: Buffer;
  decisionTicketDigest: Buffer;
  establishmentId: string;
  evidenceDigest: Buffer;
  expiresAt: Date;
  jurisdictionUf: BrazilianJurisdictionUf;
  serviceNature: CredentialServiceNature;
  status: CredentialServiceScopeStatus;
  validFrom: Date;
}

export interface TransitionEstablishmentRegulatoryJurisdictionInput {
  changedByDigest: Buffer;
  decisionTicketDigest: Buffer;
  establishmentId: string;
  evidenceDigest: Buffer;
  expiresAt: Date;
  jurisdictionUf: BrazilianJurisdictionUf;
  status: EstablishmentRegulatoryJurisdictionStatus;
  validFrom: Date;
}

export interface EstablishmentRegulatoryJurisdiction {
  establishmentId: string;
  expiresAt: Date;
  generation: string;
  jurisdictionUf: BrazilianJurisdictionUf;
  status: EstablishmentRegulatoryJurisdictionStatus;
  tenantId: string;
  updatedAt: Date;
  validFrom: Date;
  version: string;
}

interface CredentialServiceScopeRow {
  establishment_id: string;
  expires_at: Date;
  generation: string;
  jurisdiction_generation: string | null;
  jurisdiction_uf: BrazilianJurisdictionUf;
  service_nature: CredentialServiceNature;
  status: CredentialServiceScopeStatus;
  tenant_id: string;
  updated_at: Date;
  valid_from: Date;
  version: string;
}

interface EstablishmentRegulatoryJurisdictionRow {
  establishment_id: string;
  expires_at: Date;
  generation: string;
  jurisdiction_uf: BrazilianJurisdictionUf;
  status: EstablishmentRegulatoryJurisdictionStatus;
  tenant_id: string;
  updated_at: Date;
  valid_from: Date;
  version: string;
}

const COLUMNS =
  "scope.tenant_id, scope.establishment_id, scope.service_nature, scope.jurisdiction_uf, scope.status, scope.version, scope.generation, scope.jurisdiction_generation, scope.valid_from, scope.expires_at, scope.updated_at";
const JURISDICTION_COLUMNS =
  "tenant_id, establishment_id, jurisdiction_uf, status, version, generation, valid_from, expires_at, updated_at";

function toScope(row: CredentialServiceScopeRow): CredentialServiceScope {
  return {
    establishmentId: row.establishment_id,
    expiresAt: row.expires_at,
    generation: row.generation,
    jurisdictionGeneration: row.jurisdiction_generation,
    jurisdictionUf: row.jurisdiction_uf,
    serviceNature: row.service_nature,
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    validFrom: row.valid_from,
    version: row.version,
  };
}

function toJurisdiction(
  row: EstablishmentRegulatoryJurisdictionRow,
): EstablishmentRegulatoryJurisdiction {
  return {
    establishmentId: row.establishment_id,
    expiresAt: row.expires_at,
    generation: row.generation,
    jurisdictionUf: row.jurisdiction_uf,
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    validFrom: row.valid_from,
    version: row.version,
  };
}

export function credentialServiceScopeIsActive(
  scope: CredentialServiceScope | null,
): scope is CredentialServiceScope {
  // A autorização temporal já foi decidida pelo PostgreSQL usando
  // statement_timestamp(); o relógio do processo nunca participa do gate.
  return scope !== null && scope.status === "enabled";
}

export async function getCredentialServiceScope(
  client: TenantClient,
  establishmentId: string,
  serviceNature: CredentialServiceNature,
): Promise<CredentialServiceScope | null> {
  await client.query(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended(
         renave.current_tenant_id()::text || ':' || $1::uuid::text,
         700069
       )
     )`,
    [establishmentId],
  );
  const { rows } = await client.query<CredentialServiceScopeRow>(
    `with effective_jurisdictions as (
       select jurisdiction.tenant_id,jurisdiction.establishment_id,
              jurisdiction.jurisdiction_uf,jurisdiction.generation
         from renave.establishment_regulatory_jurisdiction jurisdiction
        where jurisdiction.establishment_id = $1
          and jurisdiction.status = 'verified'
          and jurisdiction.valid_from <= pg_catalog.statement_timestamp()
          and jurisdiction.expires_at > pg_catalog.statement_timestamp()
     ), single_jurisdiction as (
       select min(jurisdiction_uf) as jurisdiction_uf,
              min(generation) as generation
         from effective_jurisdictions
       having count(*) = 1
     )
     select ${COLUMNS}
       from single_jurisdiction jurisdiction
       join renave.credential_service_scope scope
         on scope.establishment_id = $1
        and scope.jurisdiction_uf = jurisdiction.jurisdiction_uf
        and scope.jurisdiction_generation = jurisdiction.generation
      where scope.service_nature = $2
        and scope.status = 'enabled'
        and scope.valid_from <= pg_catalog.statement_timestamp()
        and scope.expires_at > pg_catalog.statement_timestamp()`,
    [establishmentId, serviceNature],
  );
  return rows[0] ? toScope(rows[0]) : null;
}

/**
 * Capacidade exclusivamente offline. A função SQL confirma `session_user =
 * renave_credential_scope_provisioner`; expor este adaptador no pacote não concede a
 * capacidade ao runtime da API.
 */
export async function transitionCredentialServiceScope(
  client: TenantClient,
  input: TransitionCredentialServiceScopeInput,
): Promise<CredentialServiceScope> {
  const { rows } = await client.query<CredentialServiceScopeRow>(
    `select tenant_id, establishment_id, service_nature, jurisdiction_uf,
            status, version, generation, jurisdiction_generation,
            valid_from, expires_at, updated_at
       from renave_admin.transition_credential_service_scope(
         $1,$2,$3,$4,$5,$6,$7,$8,$9
       )`,
    [
      input.establishmentId,
      input.serviceNature,
      input.jurisdictionUf,
      input.status,
      input.validFrom,
      input.expiresAt,
      input.evidenceDigest,
      input.decisionTicketDigest,
      input.changedByDigest,
    ],
  );
  if (!rows[0]) {
    throw new Error("Transição do escopo Credencia não retornou estado.");
  }
  return toScope(rows[0]);
}

export async function transitionEstablishmentRegulatoryJurisdiction(
  client: TenantClient,
  input: TransitionEstablishmentRegulatoryJurisdictionInput,
): Promise<EstablishmentRegulatoryJurisdiction> {
  const { rows } = await client.query<EstablishmentRegulatoryJurisdictionRow>(
    `select ${JURISDICTION_COLUMNS}
         from renave_admin.transition_establishment_regulatory_jurisdiction(
           $1,$2,$3,$4,$5,$6,$7,$8
         )`,
    [
      input.establishmentId,
      input.jurisdictionUf,
      input.status,
      input.validFrom,
      input.expiresAt,
      input.evidenceDigest,
      input.decisionTicketDigest,
      input.changedByDigest,
    ],
  );
  if (!rows[0]) {
    throw new Error("Transição da jurisdição regulatória não retornou estado.");
  }
  return toJurisdiction(rows[0]);
}
