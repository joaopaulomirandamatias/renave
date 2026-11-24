import { createHash } from "node:crypto";

import {
  authorize,
  AuthorizationDeniedError,
} from "@seu-renave/access-control";
import {
  appendAuditEvent,
  confirmCredentialLinkFromPreflight,
  getAuthorizationContext,
  getEstablishment,
  rejectCredentialLinkFromPreflight,
  withTenant,
} from "@seu-renave/db/api-runtime";
import {
  EvidenceCipher,
  PostgresProtectedEvidenceStore,
} from "@seu-renave/protected-evidence";
import {
  normalizeCnpj,
  type RenaveQueryConnector,
  type RenaveServerContext,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

const ACTION = "renave.identity.verify" as const;

export interface RenaveLinkPreflightInput {
  actorIp: string;
  establishmentId: string;
  subject: string;
  tenantId: string;
  traceId?: string;
}

export interface RenaveLinkPreflightResult {
  environment: "homologation";
  status: "ready";
}

export interface RenaveLinkPreflightUseCase {
  authorize(
    input: Omit<RenaveLinkPreflightInput, "actorIp" | "traceId">,
  ): Promise<void>;
  execute(input: RenaveLinkPreflightInput): Promise<RenaveLinkPreflightResult>;
}

export class PostgresRenaveLinkPreflightUseCase implements RenaveLinkPreflightUseCase {
  constructor(
    private readonly options: {
      certificateThumbprintSha256: string;
      cipher: EvidenceCipher;
      connector: Pick<RenaveQueryConnector, "verifyIdentity">;
      integratorCnpj: string;
      pool: Pool;
    },
  ) {}

  async authorize(
    input: Omit<RenaveLinkPreflightInput, "actorIp" | "traceId">,
  ): Promise<void> {
    await this.authorizedEstablishment(input);
  }

  private async authorizedEstablishment(
    input: Omit<RenaveLinkPreflightInput, "actorIp" | "traceId">,
  ) {
    return await withTenant(
      this.options.pool,
      input.tenantId,
      async (client) => {
        const context = await getAuthorizationContext(client, input.subject);
        const decision = authorize(
          context ?? {
            grants: [],
            subject: input.subject,
            tenantId: input.tenantId,
          },
          {
            action: ACTION,
            establishmentId: input.establishmentId,
            tenantId: input.tenantId,
          },
        );
        if (!decision.allowed) {
          throw new AuthorizationDeniedError(decision.reason);
        }
        const establishment = await getEstablishment(
          client,
          input.establishmentId,
        );
        if (!establishment || establishment.status !== "active") {
          throw Object.assign(new Error("Estabelecimento indisponível"), {
            code: "ESTABLISHMENT_UNAVAILABLE",
          });
        }
        return establishment;
      },
    );
  }

  async execute(
    input: RenaveLinkPreflightInput,
  ): Promise<RenaveLinkPreflightResult> {
    const establishment = await this.authorizedEstablishment(input);

    const establishmentCnpj = normalizeCnpj(establishment.cnpj);
    const renaveContext: RenaveServerContext = {
      environment: "homologation",
      establishmentCnpj,
      establishmentId: input.establishmentId,
      integratorCnpj: this.options.integratorCnpj,
      tenantId: input.tenantId,
    };
    const request = { action: ACTION, environment: "homologation" } as const;
    const evidence = new PostgresProtectedEvidenceStore(
      this.options.pool,
      this.options.cipher,
      {
        action: ACTION,
        establishmentId: input.establishmentId,
        tenantId: input.tenantId,
      },
    );
    const { payloadReference } = await evidence.begin({
      action: ACTION,
      actorSubject: input.subject,
      establishmentId: input.establishmentId,
      request,
      tenantId: input.tenantId,
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const auditInput = (
      outcome: "attempted" | "rejected" | "succeeded",
      confirmed?: { establishment: string; integrator: string },
    ) => ({
      action: ACTION,
      actorIp: input.actorIp,
      actorSubject: input.subject,
      certificateThumbprintSha256: this.options.certificateThumbprintSha256,
      cnpjSent: establishmentCnpj,
      establishmentId: input.establishmentId,
      outcome,
      payloadReference,
      requestSha256: hash(request),
      ...(confirmed
        ? {
            cnpjConfirmed: confirmed.establishment,
            integratorCnpjConfirmed: confirmed.integrator,
            responseSha256: hash({ status: "ready" }),
          }
        : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });

    try {
      await withTenant(this.options.pool, input.tenantId, (client) =>
        appendAuditEvent(client, auditInput("attempted")),
      );
      const identity =
        await this.options.connector.verifyIdentity(renaveContext);
      await withTenant(this.options.pool, input.tenantId, async (client) => {
        await evidence.completeWithClient(client, {
          payloadReference,
          response: identity,
        });
        await appendAuditEvent(
          client,
          auditInput("succeeded", {
            establishment: identity.confirmedEstablishmentCnpj,
            integrator: identity.confirmedIntegratorCnpj,
          }),
        );
        await confirmCredentialLinkFromPreflight(
          client,
          input.establishmentId,
          input.subject,
        );
      });
      return { environment: "homologation", status: "ready" };
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "RENAVE_PREFLIGHT_ERROR";
      await withTenant(this.options.pool, input.tenantId, async (client) => {
        await evidence.failWithClient(client, {
          errorCode: code,
          payloadReference,
        });
        await appendAuditEvent(client, auditInput("rejected"));
        if (code === "RENAVE_IDENTITY_MISMATCH") {
          await rejectCredentialLinkFromPreflight(
            client,
            input.establishmentId,
            input.subject,
          );
        }
      }).catch(() => undefined);
      throw error;
    }
  }
}
