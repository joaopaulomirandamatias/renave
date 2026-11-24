import { createHash } from "node:crypto";

import {
  computeCnpjCheckDigits,
  createEstablishment,
  createPool,
  grantTenantUserAccess,
  provisionTenant,
  transitionCredentialLink,
  transitionEstablishmentRegulatoryJurisdiction,
  transitionCredentialServiceScope,
  withTenant,
  type Establishment,
  type TenantClient,
  type Tenant,
} from "@seu-renave/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { PostgresRenaveReadinessUseCase } from "../renave/readiness-use-case.js";

interface DbUrls {
  admin: string;
  app: string;
  credentialScopeProvisioner: string;
  identity: string;
  maintenance: string;
  migrator: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

const urls = inject("dbUrls");
const OPERATOR = "oidc|readiness-operator";
const PENDING_OPERATOR = "oidc|readiness-pending";
const SUSPENDED_OPERATOR = "oidc|readiness-suspended";
const MISSING_OPERATOR = "oidc|readiness-missing";

let appPool: Pool;
let migratorPool: Pool;
let credentialScopeProvisionerPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;
let storeA: Establishment;
let otherStoreA: Establishment;
let storeB: Establishment;
let pendingStoreA: Establishment;
let suspendedStoreA: Establishment;
let missingStoreA: Establishment;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function cnpj(index: number): string {
  const base = `63920518${String(index).padStart(4, "0")}`;
  return `${base}${computeCnpjCheckDigits(base)}`;
}

async function grantAndConfirm(
  client: TenantClient,
  subject: string,
  establishmentId: string,
): Promise<void> {
  await grantTenantUserAccess(client, subject, [
    { establishmentIds: [establishmentId], role: "renave_operator" },
  ]);
  await transitionCredentialLink(client, {
    changedBySubject: subject,
    establishmentId,
    source: "manual",
    status: "pending",
  });
  await transitionCredentialLink(client, {
    changedBySubject: subject,
    establishmentId,
    source: "serpro_preflight",
    status: "confirmed",
  });
}

async function enableEstablishmentScope(
  tenantId: string,
  establishmentId: string,
): Promise<void> {
  const now = Date.now();
  const validFrom = new Date(now - 60_000);
  const expiresAt = new Date(now + 86_400_000);
  await withTenant(credentialScopeProvisionerPool, tenantId, async (client) => {
    await transitionEstablishmentRegulatoryJurisdiction(client, {
      changedByDigest: digest(`jurisdiction-actor:${establishmentId}`),
      decisionTicketDigest: digest(`jurisdiction-ticket:${establishmentId}`),
      establishmentId,
      evidenceDigest: digest(`jurisdiction-evidence:${establishmentId}`),
      expiresAt,
      jurisdictionUf: "PA",
      status: "verified",
      validFrom,
    });
    await transitionCredentialServiceScope(client, {
      changedByDigest: digest(`scope-actor:${establishmentId}`),
      decisionTicketDigest: digest(`scope-ticket:${establishmentId}`),
      establishmentId,
      evidenceDigest: digest(`scope-evidence:${establishmentId}`),
      expiresAt,
      jurisdictionUf: "PA",
      serviceNature: "establishment",
      status: "enabled",
      validFrom,
    });
  });
}

async function seedOperatorProfile(
  client: TenantClient,
  subject: string,
  status: "pending" | "suspended" | "verified",
): Promise<void> {
  const verified = status !== "pending";
  await client.query(
    `insert into renave.operator_identity_profile (
       tenant_id, subject, hmac_key_id, identity_hmac,
       envelope_schema_version, envelope_key_id, envelope_nonce,
       envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
       status, verification_source, source_evidence_digest,
       changed_by_subject_hash, verified_by_subject_hash, verified_at
     ) values (
       renave.current_tenant_id(), $1, 'cpf-hmac-v1', $2,
       1, 'cpf-envelope-v1', $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       case when $11::bytea is null then null else pg_catalog.clock_timestamp() end
     )`,
    [
      subject,
      digest(`cpf-hmac:${tenantA.id}:${subject}`),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      Buffer.alloc(128, 3),
      digest(`cpf-aad:${tenantA.id}:${subject}`),
      status,
      verified ? "regulated_provider" : "unverified_candidate",
      digest(`cpf-evidence:${tenantA.id}:${subject}`),
      digest(`cpf-changer:${tenantA.id}:${subject}`),
      verified ? digest(`cpf-verifier:${tenantA.id}:${subject}`) : null,
    ],
  );
}

async function seedEstablishmentProfile(
  client: TenantClient,
  establishmentId: string,
  status: "pending" | "suspended" | "verified",
): Promise<void> {
  const verified = status !== "pending";
  await client.query(
    `insert into renave.establishment_renave_profile (
       tenant_id, establishment_id, hmac_key_id, email_hmac,
       envelope_schema_version, envelope_key_id, envelope_nonce,
       envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
       status, verification_source, source_evidence_digest,
       changed_by_subject_hash, verified_by_subject_hash, verified_at
     ) values (
       renave.current_tenant_id(), $1, 'email-hmac-v1', $2,
       1, 'email-envelope-v1', $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       case when $11::bytea is null then null else pg_catalog.clock_timestamp() end
     )`,
    [
      establishmentId,
      digest(`email-hmac:${tenantA.id}:${establishmentId}`),
      Buffer.alloc(12, 4),
      Buffer.alloc(16, 5),
      Buffer.alloc(256, 6),
      digest(`email-aad:${tenantA.id}:${establishmentId}`),
      status,
      verified ? "mailbox_challenge" : "unverified_candidate",
      digest(`email-evidence:${tenantA.id}:${establishmentId}`),
      digest(`email-changer:${tenantA.id}:${establishmentId}`),
      verified
        ? digest(`email-verifier:${tenantA.id}:${establishmentId}`)
        : null,
    ],
  );
}

beforeAll(async () => {
  appPool = createPool(urls.app, { max: 4 });
  migratorPool = createPool(urls.migrator, { max: 2 });
  credentialScopeProvisionerPool = createPool(urls.credentialScopeProvisioner, {
    max: 2,
  });
  tenantA = await provisionTenant(migratorPool, {
    displayName: "Readiness A",
    slug: "readiness-a",
  });
  tenantB = await provisionTenant(migratorPool, {
    displayName: "Readiness B",
    slug: "readiness-b",
  });
  [storeA, otherStoreA, pendingStoreA, suspendedStoreA, missingStoreA] =
    await withTenant(appPool, tenantA.id, async (client) => [
      await createEstablishment(client, {
        cnpj: "11222333000181",
        tradeName: "Loja autorizada",
      }),
      await createEstablishment(client, {
        cnpj: "12ABC34501DE35",
        tradeName: "Loja fora do escopo",
      }),
      await createEstablishment(client, {
        cnpj: cnpj(1),
        tradeName: "Loja com perfis pendentes",
      }),
      await createEstablishment(client, {
        cnpj: cnpj(2),
        tradeName: "Loja com perfis suspensos",
      }),
      await createEstablishment(client, {
        cnpj: cnpj(3),
        tradeName: "Loja sem perfis",
      }),
    ]);
  storeB = await withTenant(appPool, tenantB.id, (client) =>
    createEstablishment(client, {
      cnpj: "11222333000181",
      tradeName: "Loja outro tenant",
    }),
  );
  await withTenant(migratorPool, tenantA.id, async (client) => {
    await grantAndConfirm(client, OPERATOR, storeA.id);
    await grantAndConfirm(client, PENDING_OPERATOR, pendingStoreA.id);
    await grantAndConfirm(client, SUSPENDED_OPERATOR, suspendedStoreA.id);
    await grantAndConfirm(client, MISSING_OPERATOR, missingStoreA.id);
    await seedOperatorProfile(client, OPERATOR, "verified");
    await seedEstablishmentProfile(client, storeA.id, "verified");
    await seedOperatorProfile(client, PENDING_OPERATOR, "pending");
    await seedEstablishmentProfile(client, pendingStoreA.id, "pending");
    await seedOperatorProfile(client, SUSPENDED_OPERATOR, "suspended");
    await seedEstablishmentProfile(client, suspendedStoreA.id, "suspended");
  });
  await Promise.all(
    [storeA, pendingStoreA, suspendedStoreA, missingStoreA].map((store) =>
      enableEstablishmentScope(tenantA.id, store.id),
    ),
  );
});

afterAll(async () => {
  await Promise.all([
    appPool?.end(),
    migratorPool?.end(),
    credentialScopeProvisionerPool?.end(),
  ]);
});

function useCase(status: "healthy" | "expired" = "healthy") {
  return new PostgresRenaveReadinessUseCase({
    certificateTemporalStatus: () => status,
    integrationConfigured: true,
    pool: appPool,
    queryLimiterConfigured: true,
  });
}

describe("prontidão RENAVE com PostgreSQL", () => {
  it("libera somente consultas da loja autorizada e com gates locais prontos", async () => {
    await expect(
      useCase().execute({
        establishmentId: storeA.id,
        subject: OPERATOR,
        tenantId: tenantA.id,
      }),
    ).resolves.toEqual({
      certificate: "ready",
      environment: "homologation",
      establishmentContact: "verified",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "ready",
    });
  });

  it("fecha consultas quando o certificado expira sem perder o vínculo", async () => {
    await expect(
      useCase("expired").execute({
        establishmentId: storeA.id,
        subject: OPERATOR,
        tenantId: tenantA.id,
      }),
    ).resolves.toMatchObject({
      certificate: "blocked",
      establishmentContact: "verified",
      link: "confirmed",
      mutations: "blocked",
      operatorIdentity: "verified",
      queries: "blocked",
    });
  });

  it.each([
    ["pendentes", PENDING_OPERATOR, () => pendingStoreA.id, "pending"],
    ["suspensos", SUSPENDED_OPERATOR, () => suspendedStoreA.id, "suspended"],
    ["ausentes", MISSING_OPERATOR, () => missingStoreA.id, "missing"],
  ] as const)(
    "projeta perfis %s sem expor metadados",
    async (_, subject, storeId, expectedStatus) => {
      await expect(
        useCase().execute({
          establishmentId: storeId(),
          subject,
          tenantId: tenantA.id,
        }),
      ).resolves.toMatchObject({
        certificate: "ready",
        establishmentContact: expectedStatus,
        link: "confirmed",
        mutations: "blocked",
        operatorIdentity: expectedStatus,
        queries: "ready",
      });
    },
  );

  it("mantém o runtime da API sem capacidade de gravar perfis", async () => {
    await expect(
      withTenant(appPool, tenantA.id, (client) =>
        client.query(
          `insert into renave.operator_identity_profile (
             tenant_id, subject, hmac_key_id, identity_hmac,
             envelope_schema_version, envelope_key_id, envelope_nonce,
             envelope_auth_tag, envelope_ciphertext, envelope_aad_sha256,
             status, verification_source, source_evidence_digest,
             changed_by_subject_hash
           ) values (
             renave.current_tenant_id(), 'oidc|forbidden-profile',
             'cpf-hmac-v1', $1, 1, 'cpf-envelope-v1', $2, $3, $4, $5,
             'pending', 'unverified_candidate', $6, $7
           )`,
          [
            digest("forbidden-hmac"),
            Buffer.alloc(12, 1),
            Buffer.alloc(16, 2),
            Buffer.alloc(128, 3),
            digest("forbidden-aad"),
            digest("forbidden-evidence"),
            digest("forbidden-changer"),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    ["outro estabelecimento", () => tenantA.id, () => otherStoreA.id],
    ["outro tenant", () => tenantB.id, () => storeB.id],
  ] as const)("recusa escopo de %s", async (_, tenantId, establishmentId) => {
    await expect(
      useCase().execute({
        establishmentId: establishmentId(),
        subject: OPERATOR,
        tenantId: tenantId(),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});
