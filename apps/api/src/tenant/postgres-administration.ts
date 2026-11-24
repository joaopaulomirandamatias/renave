import {
  PostgresTenantAdministration,
  type TenantClient,
} from "@seu-renave/db/api-runtime";

import type { TenantEstablishmentAdministration } from "./admin-establishments.js";

/**
 * Adapta a porta HTTP ao contrato de persistência. Hashes e HMACs são
 * deliberadamente calculados no pacote DB, que também conhece o tenant RLS.
 */
export class PostgresTenantEstablishmentAdministration implements TenantEstablishmentAdministration {
  private readonly hmacKey: Buffer;
  private readonly repository: PostgresTenantAdministration;

  constructor(hmacKey: Buffer) {
    if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
      throw new TypeError("A chave HMAC administrativa deve ter 32 bytes.");
    }
    this.hmacKey = Buffer.from(hmacKey);
    this.repository = new PostgresTenantAdministration(this.hmacKey);
  }

  async create(
    client: TenantClient,
    input: Parameters<TenantEstablishmentAdministration["create"]>[1],
  ): ReturnType<TenantEstablishmentAdministration["create"]> {
    const result = await this.repository.create(client, {
      actorIp: input.actorIp,
      actorSubject: input.actorSubject,
      cnpj: input.cnpj,
      idempotencyKey: input.idempotencyKey,
      traceId: input.traceId,
      tradeName: input.tradeName,
    });
    return {
      establishment: {
        id: result.establishment.id,
        tradeName: result.establishment.tradeName,
      },
      replayed: result.replayed,
    };
  }

  destroy(): void {
    this.repository.destroy();
    this.hmacKey.fill(0);
  }
}
