import { randomUUID } from "node:crypto";

import { withTenant, type TenantClient } from "@seu-renave/db/tenant-runtime";
import type { Pool } from "pg";

import { EvidenceCipher, type EvidenceBinding } from "./crypto.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REFERENCE =
  /^pev1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;
const ACTIONS = [
  "renave.identity.verify",
  "renave.stock.read",
  "renave.vehicle.eligibility.read",
] as const;
type ProtectedEvidenceAction = (typeof ACTIONS)[number];

export interface ProtectedEvidenceContext {
  action: ProtectedEvidenceAction;
  actorSubject: string;
  establishmentId: string;
  request: unknown;
  tenantId: string;
  traceId?: string;
}

export class ProtectedEvidenceInputError extends Error {
  override name = "ProtectedEvidenceInputError";
}

export class ProtectedEvidenceTransitionError extends Error {
  readonly code = "PROTECTED_EVIDENCE_TRANSITION_REJECTED";
  override name = "ProtectedEvidenceTransitionError";
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new ProtectedEvidenceInputError(`${field} inválido.`);
  }
}

function evidenceId(reference: string): string {
  const match = REFERENCE.exec(reference);
  if (!match?.[1]) {
    throw new ProtectedEvidenceInputError("Referência de evidência inválida.");
  }
  return match[1].toLowerCase();
}

/**
 * Adapter por requisição, já preso ao TenantClient transacional e ao
 * estabelecimento autorizado. Compatível estruturalmente com
 * `ProtectedEvidencePort` de `@seu-renave/renave-application`.
 */
export class PostgresProtectedEvidenceStore {
  private readonly tenantId: string;
  private readonly establishmentId: string;
  private readonly action: ProtectedEvidenceAction;

  constructor(
    private readonly pool: Pool,
    private readonly cipher: EvidenceCipher,
    binding: {
      action: ProtectedEvidenceAction;
      establishmentId: string;
      tenantId: string;
    },
  ) {
    assertUuid(binding.tenantId, "tenantId");
    assertUuid(binding.establishmentId, "establishmentId");
    if (!ACTIONS.includes(binding.action)) {
      throw new ProtectedEvidenceInputError("Ação de evidência inválida.");
    }
    this.tenantId = binding.tenantId.toLowerCase();
    this.establishmentId = binding.establishmentId.toLowerCase();
    this.action = binding.action;
  }

  async begin(
    context: ProtectedEvidenceContext,
  ): Promise<{ payloadReference: string }> {
    if (
      context.action !== this.action ||
      context.tenantId.toLowerCase() !== this.tenantId ||
      context.establishmentId.toLowerCase() !== this.establishmentId
    ) {
      throw new ProtectedEvidenceInputError(
        "Contexto da evidência não corresponde ao binding autorizado.",
      );
    }
    const id = randomUUID();
    const binding = this.binding(id);
    const encrypted = this.cipher.encrypt(context, binding, "request");
    const result = await withTenant(this.pool, this.tenantId, (client) =>
      client.query(
        `insert into renave.protected_evidence (
           id, tenant_id, establishment_id, action,
           request_key_id, request_nonce, request_auth_tag, request_ciphertext
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          this.tenantId,
          this.establishmentId,
          this.action,
          encrypted.keyId,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.ciphertext,
        ],
      ),
    );
    if (result.rowCount !== 1) throw new ProtectedEvidenceTransitionError();
    return { payloadReference: `pev1_${id}` };
  }

  async complete(input: {
    payloadReference: string;
    response: unknown;
  }): Promise<void> {
    await withTenant(this.pool, this.tenantId, (client) =>
      this.completeWithClient(client, input),
    );
  }

  async completeWithClient(
    client: TenantClient,
    input: { payloadReference: string; response: unknown },
  ): Promise<void> {
    const id = evidenceId(input.payloadReference);
    const encrypted = this.cipher.encrypt(
      input.response,
      this.binding(id),
      "response",
    );
    const result = await client.query(
      `update renave.protected_evidence
            set status = 'completed', response_key_id = $5,
                response_nonce = $6, response_auth_tag = $7,
                response_ciphertext = $8
          where id = $1 and tenant_id = $2 and establishment_id = $3
            and action = $4 and status = 'pending'
        returning id`,
      [
        id,
        this.tenantId,
        this.establishmentId,
        this.action,
        encrypted.keyId,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.ciphertext,
      ],
    );
    if (result.rowCount !== 1) throw new ProtectedEvidenceTransitionError();
  }

  async fail(input: {
    errorCode: string;
    payloadReference: string;
  }): Promise<void> {
    await withTenant(this.pool, this.tenantId, (client) =>
      this.failWithClient(client, input),
    );
  }

  async failWithClient(
    client: TenantClient,
    input: { errorCode: string; payloadReference: string },
  ): Promise<void> {
    if (!ERROR_CODE.test(input.errorCode)) {
      throw new ProtectedEvidenceInputError("Código de falha inválido.");
    }
    const id = evidenceId(input.payloadReference);
    const result = await client.query(
      `update renave.protected_evidence
            set status = 'failed', failure_code = $5
          where id = $1 and tenant_id = $2 and establishment_id = $3
            and action = $4 and status = 'pending'
        returning id`,
      [id, this.tenantId, this.establishmentId, this.action, input.errorCode],
    );
    if (result.rowCount !== 1) throw new ProtectedEvidenceTransitionError();
  }

  private binding(evidenceIdValue: string): EvidenceBinding {
    return {
      action: this.action,
      establishmentId: this.establishmentId,
      evidenceId: evidenceIdValue,
      tenantId: this.tenantId,
    };
  }
}
