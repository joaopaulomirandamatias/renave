import { createHash } from "node:crypto";

import { grantTenantUserAccess } from "../../src/authorization.js";
import type { TenantClient } from "../../src/tenant-context.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export interface OperationAuthorizationSnapshot {
  establishmentProfileId: string;
  establishmentProfileVersion: string;
  operatorProfileId: string;
  operatorProfileVersion: string;
  subject: string;
}

/** Cria somente os principals verificados usados por fixtures HELD_LOCAL. */
export async function seedVerifiedOperationPrincipals(
  client: TenantClient,
  input: { establishmentId: string; label: string },
): Promise<OperationAuthorizationSnapshot> {
  const subject = `oidc|operation-fixture-${input.label}`;
  await grantTenantUserAccess(client, subject, [
    {
      establishmentIds: [input.establishmentId],
      role: "renave_operator",
    },
  ]);
  const operator = await client.query<{ id: string; version: string }>(
    `insert into renave.operator_identity_profile (
       tenant_id,subject,hmac_key_id,identity_hmac,
       envelope_schema_version,envelope_key_id,envelope_nonce,
       envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
       status,verification_source,source_evidence_digest,
       changed_by_subject_hash,verified_by_subject_hash,verified_at
     ) values (
       renave.current_tenant_id(),$1,'cpf-hmac-v1',$2,
       1,'cpf-envelope-v1',$3,$4,$5,$6,
       'verified','regulated_provider',$7,$8,$9,
       pg_catalog.clock_timestamp()
     ) returning id,version::text`,
    [
      subject,
      digest(`operator-hmac:${input.label}`),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      Buffer.alloc(128, 3),
      digest(`operator-aad:${input.label}`),
      digest(`operator-evidence:${input.label}`),
      digest(`operator-changer:${input.label}`),
      digest(`operator-verifier:${input.label}`),
    ],
  );
  const establishment = await client.query<{
    id: string;
    version: string;
  }>(
    `insert into renave.establishment_renave_profile (
       tenant_id,establishment_id,hmac_key_id,email_hmac,
       envelope_schema_version,envelope_key_id,envelope_nonce,
       envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
       status,verification_source,source_evidence_digest,
       changed_by_subject_hash,verified_by_subject_hash,verified_at
     ) values (
       renave.current_tenant_id(),$1,'email-hmac-v1',$2,
       1,'email-envelope-v1',$3,$4,$5,$6,
       'verified','mailbox_challenge',$7,$8,$9,
       pg_catalog.clock_timestamp()
     ) returning id,version::text`,
    [
      input.establishmentId,
      digest(`establishment-hmac:${input.label}`),
      Buffer.alloc(12, 4),
      Buffer.alloc(16, 5),
      Buffer.alloc(512, 6),
      digest(`establishment-aad:${input.label}`),
      digest(`establishment-evidence:${input.label}`),
      digest(`establishment-changer:${input.label}`),
      digest(`establishment-verifier:${input.label}`),
    ],
  );
  return {
    establishmentProfileId: establishment.rows[0]!.id,
    establishmentProfileVersion: establishment.rows[0]!.version,
    operatorProfileId: operator.rows[0]!.id,
    operatorProfileVersion: operator.rows[0]!.version,
    subject,
  };
}

/**
 * Test-only bridge for historical PENDING_SEND fixtures created through the
 * pre-HELD_LOCAL owner function. Production never backfills this binding.
 */
export async function bindHistoricalOperationForDispatch(
  client: TenantClient,
  input: {
    establishmentId: string;
    label: string;
    operationId: string;
  },
): Promise<void> {
  const subject = `oidc|dispatch-fixture-${input.operationId}`;
  await client.query(
    `insert into renave.tenant_user (tenant_id,subject,status)
     values (renave.current_tenant_id(),$1,'active')`,
    [subject],
  );
  await client.query(
    `insert into renave.tenant_role_grant (tenant_id,subject,role)
     values (renave.current_tenant_id(),$1,'renave_operator')`,
    [subject],
  );
  await client.query(
    `insert into renave.establishment_role_scope (
       tenant_id,subject,role,establishment_id
     ) values (renave.current_tenant_id(),$1,'renave_operator',$2)`,
    [subject, input.establishmentId],
  );
  await client.query(
    `insert into renave.credential_link (
       tenant_id,establishment_id,status,version
     ) values (renave.current_tenant_id(),$1,'enabled',1)
     on conflict (tenant_id,establishment_id) do nothing`,
    [input.establishmentId],
  );
  const operator = await client.query<{ id: string }>(
    `insert into renave.operator_identity_profile (
       tenant_id,subject,hmac_key_id,identity_hmac,
       envelope_schema_version,envelope_key_id,envelope_nonce,
       envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
       status,verification_source,source_evidence_digest,
       changed_by_subject_hash,verified_by_subject_hash,verified_at
     ) values (
       renave.current_tenant_id(),$1,'cpf-hmac-v1',$2,
       1,'cpf-envelope-v1',$3,$4,$5,$6,
       'verified','regulated_provider',$7,$8,$9,
       pg_catalog.clock_timestamp()
     ) returning id`,
    [
      subject,
      digest(`operator-hmac:${input.label}`),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      Buffer.alloc(128, 3),
      digest(`operator-aad:${input.label}`),
      digest(`operator-evidence:${input.label}`),
      digest(`operator-changer:${input.label}`),
      digest(`operator-verifier:${input.label}`),
    ],
  );
  await client.query(
    `insert into renave.establishment_renave_profile (
       tenant_id,establishment_id,hmac_key_id,email_hmac,
       envelope_schema_version,envelope_key_id,envelope_nonce,
       envelope_auth_tag,envelope_ciphertext,envelope_aad_sha256,
       status,verification_source,source_evidence_digest,
       changed_by_subject_hash,verified_by_subject_hash,verified_at
     ) values (
       renave.current_tenant_id(),$1,'email-hmac-v1',$2,
       1,'email-envelope-v1',$3,$4,$5,$6,
       'verified','mailbox_challenge',$7,$8,$9,
       pg_catalog.clock_timestamp()
     ) on conflict (tenant_id,establishment_id) do nothing`,
    [
      input.establishmentId,
      digest(`establishment-hmac:${input.label}`),
      Buffer.alloc(12, 4),
      Buffer.alloc(16, 5),
      Buffer.alloc(512, 6),
      digest(`establishment-aad:${input.label}`),
      digest(`establishment-evidence:${input.label}`),
      digest(`establishment-changer:${input.label}`),
      digest(`establishment-verifier:${input.label}`),
    ],
  );
  const establishment = await client.query<{ id: string }>(
    `select id from renave.establishment_renave_profile
      where tenant_id=renave.current_tenant_id() and establishment_id=$1`,
    [input.establishmentId],
  );
  await client.query(
    `insert into renave.establishment_regulatory_jurisdiction (
       tenant_id,establishment_id,jurisdiction_uf,status,version,generation,
       valid_from,expires_at,evidence_digest,decision_ticket_digest,
       changed_by_digest
     ) values (
       renave.current_tenant_id(),$1,'PA','verified',1,1,
       pg_catalog.clock_timestamp()-interval '1 minute',
       pg_catalog.clock_timestamp()+interval '1 hour',$2,$3,$4
     ) on conflict (tenant_id,establishment_id,jurisdiction_uf) do nothing`,
    [
      input.establishmentId,
      digest(`jurisdiction-evidence:${input.label}`),
      digest(`jurisdiction-ticket:${input.label}`),
      digest(`jurisdiction-actor:${input.label}`),
    ],
  );
  await client.query(
    `insert into renave.credential_service_scope (
       tenant_id,establishment_id,service_nature,jurisdiction_uf,
       jurisdiction_generation,status,version,generation,valid_from,
       expires_at,evidence_digest,decision_ticket_digest,changed_by_digest
     ) values (
       renave.current_tenant_id(),$1,'establishment','PA',1,'enabled',1,1,
       pg_catalog.clock_timestamp()-interval '1 minute',
       pg_catalog.clock_timestamp()+interval '1 hour',$2,$3,$4
     ) on conflict (
       tenant_id,establishment_id,service_nature,jurisdiction_uf
     ) do nothing`,
    [
      input.establishmentId,
      digest(`scope-evidence:${input.label}`),
      digest(`scope-ticket:${input.label}`),
      digest(`scope-actor:${input.label}`),
    ],
  );
  await client.query(
    `insert into renave.operation_authorization_binding (
       tenant_id,operation_id,service_nature,jurisdiction_uf,
       jurisdiction_generation,scope_generation,credential_link_version,
       operator_profile_id,operator_profile_version,
       establishment_profile_id,establishment_profile_version
     ) values (
       renave.current_tenant_id(),$1,'establishment','PA',1,1,1,$2,1,$3,1
     )`,
    [input.operationId, operator.rows[0]!.id, establishment.rows[0]!.id],
  );
}
