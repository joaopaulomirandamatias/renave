import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";

import type { TenantClient } from "./tenant-context.js";
import { appendAuditEvent } from "./audit-events.js";
import { parseCnpj } from "./cnpj.js";
import {
  createEstablishment,
  getEstablishment,
  type Establishment,
} from "./establishments.js";

interface TenantAdministrationState {
  destroyed: boolean;
  readonly hmacKey: Buffer;
}

const tenantAdministrationState = new WeakMap<
  PostgresTenantAdministration,
  TenantAdministrationState
>();

export interface CreateAdminEstablishmentInput {
  actorIp: string;
  actorSubject: string;
  cnpj: string;
  idempotencyKey: string;
  traceId?: string;
  tradeName: string;
}

export interface CreateAdminEstablishmentResult {
  credentialLinkStatus: "not_started";
  establishment: Establishment;
  replayed: boolean;
}

interface IdempotencyRow {
  actor_digest: Buffer;
  request_digest: Buffer;
  result_establishment_id: string | null;
}

interface DatabaseError {
  code?: string;
  constraint?: string;
}

export class TenantAdminInputError extends Error {
  override name = "TenantAdminInputError";
}

export class TenantAdminAccessDeniedError extends Error {
  override name = "TenantAdminAccessDeniedError";
  constructor() {
    super("A administração do tenant não foi autorizada.");
  }
}

export class TenantAdminCnpjConflictError extends Error {
  override name = "TenantAdminCnpjConflictError";
  constructor() {
    super("Já existe um estabelecimento com este CNPJ no tenant.");
  }
}

export class TenantAdminIdempotencyConflictError extends Error {
  override name = "TenantAdminIdempotencyConflictError";
  constructor() {
    super("A chave de idempotência já foi usada em outra requisição.");
  }
}

export class TenantAdminStorageError extends Error {
  readonly transient: boolean;
  override name = "TenantAdminStorageError";
  constructor(transient = false) {
    super("A administração do tenant não pôde ser persistida.");
    this.transient = transient;
  }
}

function validate(input: CreateAdminEstablishmentInput): {
  cnpj: string;
  traceId: string | undefined;
  tradeName: string;
} {
  if (
    typeof input.actorSubject !== "string" ||
    input.actorSubject.trim() !== input.actorSubject ||
    input.actorSubject.length < 1 ||
    input.actorSubject.length > 255
  ) {
    throw new TenantAdminInputError("Subject OIDC inválido.");
  }
  if (typeof input.actorIp !== "string" || isIP(input.actorIp) === 0) {
    throw new TenantAdminInputError("Endereço do ator inválido.");
  }
  if (
    typeof input.tradeName !== "string" ||
    input.tradeName.trim() !== input.tradeName ||
    input.tradeName.length < 1 ||
    input.tradeName.length > 160 ||
    /[\p{Cc}\p{Cf}]/u.test(input.tradeName)
  ) {
    throw new TenantAdminInputError("Nome comercial inválido.");
  }
  if (
    input.traceId !== undefined &&
    (typeof input.traceId !== "string" ||
      input.traceId.trim() !== input.traceId ||
      input.traceId.length < 1 ||
      input.traceId.length > 255)
  ) {
    throw new TenantAdminInputError("Identificador de rastreio inválido.");
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.idempotencyKey,
    )
  ) {
    throw new TenantAdminInputError("Chave de idempotência inválida.");
  }
  let cnpj: string;
  try {
    cnpj = parseCnpj(input.cnpj);
  } catch {
    throw new TenantAdminInputError("CNPJ inválido.");
  }
  return { cnpj, traceId: input.traceId, tradeName: input.tradeName };
}

function isDatabaseError(value: unknown): value is DatabaseError {
  return typeof value === "object" && value !== null;
}

/**
 * Composição transacional do cadastro administrativo. O chamador deve fornecer
 * um TenantClient do TenantActionRunner; replay, criação e auditoria ficam na
 * mesma transação RLS.
 */
export class PostgresTenantAdministration {
  constructor(hmacKey: Buffer) {
    if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
      throw new TenantAdminInputError(
        "A chave HMAC administrativa deve ter ao menos 32 bytes.",
      );
    }
    tenantAdministrationState.set(this, {
      destroyed: false,
      hmacKey: Buffer.from(hmacKey),
    });
    Object.freeze(this);
  }

  async create(
    client: TenantClient,
    input: CreateAdminEstablishmentInput,
  ): Promise<CreateAdminEstablishmentResult> {
    const state = tenantAdministrationState.get(this);
    if (!state || state.destroyed) {
      throw new TenantAdminInputError("Administração do tenant indisponível.");
    }
    const normalized = validate(input);
    try {
      const locked = await client.query<{ allowed: boolean }>(
        "select renave.lock_current_tenant_admin($1) as allowed",
        [input.actorSubject],
      );
      if (locked.rows[0]?.allowed !== true) {
        throw new TenantAdminAccessDeniedError();
      }

      const tenant = await client.query<{ tenant_id: string }>(
        "select renave.current_tenant_id()::text as tenant_id",
      );
      const tenantId = tenant.rows[0]?.tenant_id;
      if (!tenantId) throw new TenantAdminStorageError();
      const actorDigest = createHmac("sha256", state.hmacKey)
        .update("tenant-admin-idempotency-actor-v1\0", "utf8")
        .update(tenantId, "utf8")
        .update("\0", "utf8")
        .update(input.actorSubject, "utf8")
        .digest();
      const idempotencyKeyDigest = createHmac("sha256", state.hmacKey)
        .update("tenant-admin-idempotency-key-v1\0", "utf8")
        .update(tenantId, "utf8")
        .update("\0", "utf8")
        .update(input.idempotencyKey.toLowerCase(), "utf8")
        .digest();
      const requestDigest = createHash("sha256")
        .update(
          JSON.stringify({
            action: "tenant.establishment.create",
            cnpj: normalized.cnpj,
            tradeName: normalized.tradeName,
          }),
          "utf8",
        )
        .digest();

      let claimed;
      try {
        claimed = await client.query<{ claimed: boolean }>(
          `insert into renave.admin_mutation_idempotency (
           tenant_id, action, key_digest, actor_digest, request_digest
         ) values (
           renave.current_tenant_id(), 'tenant.establishment.create', $1, $2, $3
         ) on conflict (tenant_id, action, key_digest) do nothing
         returning true as claimed`,
          [idempotencyKeyDigest, actorDigest, requestDigest],
        );

        if (claimed.rows.length === 0) {
          const existing = await client.query<IdempotencyRow>(
            `select actor_digest, request_digest, result_establishment_id
             from renave.admin_mutation_idempotency
            where action = 'tenant.establishment.create' and key_digest = $1
            for update`,
            [idempotencyKeyDigest],
          );
          const row = existing.rows[0];
          if (
            !row ||
            !row.actor_digest.equals(actorDigest) ||
            !row.request_digest.equals(requestDigest)
          ) {
            throw new TenantAdminIdempotencyConflictError();
          }
          if (row.result_establishment_id === null) {
            throw new TenantAdminStorageError(true);
          }
          const establishment = await getEstablishment(
            client,
            row.result_establishment_id,
          );
          if (!establishment) throw new TenantAdminStorageError();
          return {
            credentialLinkStatus: "not_started",
            establishment,
            replayed: true,
          };
        }

        const establishment = await createEstablishment(client, normalized);
        await appendAuditEvent(client, {
          action: "tenant.establishment.create",
          actorIp: input.actorIp,
          actorSubject: input.actorSubject,
          establishmentId: establishment.id,
          outcome: "succeeded",
          ...(normalized.traceId === undefined
            ? {}
            : { traceId: normalized.traceId }),
        });
        const completed = await client.query(
          `update renave.admin_mutation_idempotency
            set result_establishment_id = $2
          where action = 'tenant.establishment.create' and key_digest = $1`,
          [idempotencyKeyDigest, establishment.id],
        );
        if (completed.rowCount !== 1) throw new TenantAdminStorageError();
        return {
          credentialLinkStatus: "not_started",
          establishment,
          replayed: false,
        };
      } finally {
        actorDigest.fill(0);
        idempotencyKeyDigest.fill(0);
        requestDigest.fill(0);
      }
    } catch (error) {
      if (
        error instanceof TenantAdminInputError ||
        error instanceof TenantAdminAccessDeniedError ||
        error instanceof TenantAdminCnpjConflictError ||
        error instanceof TenantAdminIdempotencyConflictError ||
        error instanceof TenantAdminStorageError
      ) {
        throw error;
      }
      if (isDatabaseError(error)) {
        if (
          error.code === "23505" &&
          error.constraint === "establishment_tenant_cnpj_key"
        ) {
          throw new TenantAdminCnpjConflictError();
        }
        if (error.code === "23514" || error.code === "22P02") {
          throw new TenantAdminInputError(
            "Dados do estabelecimento inválidos.",
          );
        }
        if (error.code === "42501") {
          throw new TenantAdminAccessDeniedError();
        }
        if (error.code === "40001" || error.code === "40P01") {
          throw new TenantAdminStorageError(true);
        }
      }
      throw new TenantAdminStorageError();
    }
  }

  destroy(): void {
    const state = tenantAdministrationState.get(this);
    if (!state || state.destroyed) return;
    state.destroyed = true;
    state.hmacKey.fill(0);
  }
}
