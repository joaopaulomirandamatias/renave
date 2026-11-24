import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  getEstablishmentRenaveProfileStatus,
  getOperatorIdentityProfileStatus,
  resolveVerifiedRenavePrincipals,
  RenavePrincipalResolutionStorageError,
  RenavePrincipalResolutionUnavailableError,
  RenaveProfileInputError,
} from "../../src/renave-profiles.js";
import type { TenantClient } from "../../src/tenant-context.js";

function client(query: ReturnType<typeof vi.fn>): TenantClient {
  return { query } as unknown as TenantClient;
}

describe("renave profile status repository", () => {
  it("mapeia somente o status sanitizado do operador", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          profile_status: "verified",
        },
      ],
    });

    await expect(
      getOperatorIdentityProfileStatus(client(query), "oidc|operator-1"),
    ).resolves.toBe("verified");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("get_operator_identity_profile_status"),
      ["oidc|operator-1"],
    );
  });

  it("mapeia ausência sem inventar estado", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      getEstablishmentRenaveProfileStatus(client(query), randomUUID()),
    ).resolves.toBeNull();
  });

  it.each(["", " oidc|operator", "oidc|operator ", "x".repeat(256)])(
    "recusa subject inválido %j antes da consulta",
    async (subject) => {
      const query = vi.fn();
      await expect(
        getOperatorIdentityProfileStatus(client(query), subject),
      ).rejects.toBeInstanceOf(RenaveProfileInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-uuid", "00000000-0000-0000-0000"])(
    "recusa estabelecimento inválido %j antes da consulta",
    async (establishmentId) => {
      const query = vi.fn();
      await expect(
        getEstablishmentRenaveProfileStatus(client(query), establishmentId),
      ).rejects.toBeInstanceOf(RenaveProfileInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])(
    "recusa digest de idempotência com %s bytes antes da consulta",
    async (idempotencyKeyDigest) => {
      const query = vi.fn();
      await expect(
        resolveVerifiedRenavePrincipals(client(query), {
          establishmentId: randomUUID(),
          idempotencyKeyDigest,
          subject: "oidc|operator-1",
        }),
      ).rejects.toBeInstanceOf(RenaveProfileInputError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("mapeia envelopes verificados com cópias defensivas", async () => {
    const tenantId = randomUUID();
    const establishmentId = randomUUID();
    const operatorCiphertext = Buffer.alloc(128, 1);
    const establishmentCiphertext = Buffer.alloc(512, 2);
    const row = {
      active_tenant_id: tenantId,
      establishment_email_hmac: Buffer.alloc(32, 3),
      establishment_envelope_aad_sha256: Buffer.alloc(32, 4),
      establishment_envelope_auth_tag: Buffer.alloc(16, 5),
      establishment_envelope_ciphertext: establishmentCiphertext,
      establishment_envelope_key_id: "email-envelope-v1",
      establishment_envelope_nonce: Buffer.alloc(12, 6),
      establishment_envelope_schema_version: 1,
      establishment_hmac_key_id: "email-hmac-v1",
      establishment_profile_id: randomUUID(),
      establishment_profile_version: "1",
      operator_envelope_aad_sha256: Buffer.alloc(32, 7),
      operator_envelope_auth_tag: Buffer.alloc(16, 8),
      operator_envelope_ciphertext: operatorCiphertext,
      operator_envelope_key_id: "cpf-envelope-v1",
      operator_envelope_nonce: Buffer.alloc(12, 9),
      operator_envelope_schema_version: 1,
      operator_hmac_key_id: "cpf-hmac-v1",
      operator_identity_hmac: Buffer.alloc(32, 10),
      operator_profile_id: randomUUID(),
      operator_profile_version: "1",
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const idempotencyKeyDigest = Buffer.alloc(32, 11);

    const resolved = await resolveVerifiedRenavePrincipals(client(query), {
      establishmentId,
      idempotencyKeyDigest,
      subject: "oidc|operator-1",
    });
    const resolutionCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("resolve_verified_renave_principals"),
    );
    const queryDigest = resolutionCall?.[1]?.[2] as Buffer;
    expect(queryDigest).not.toBe(idempotencyKeyDigest);
    expect(queryDigest.equals(Buffer.alloc(32))).toBe(true);
    expect(idempotencyKeyDigest.equals(Buffer.alloc(32, 11))).toBe(true);

    expect(resolved).toMatchObject({
      establishment: {
        binding: {
          establishmentId,
          purpose: "establishment-email",
          tenantId,
        },
        envelope: {
          envelopeSchemaVersion: 1,
          keyId: "email-envelope-v1",
        },
      },
      operator: {
        binding: {
          purpose: "operator-cpf",
          subject: "oidc|operator-1",
          tenantId,
        },
        envelope: {
          envelopeSchemaVersion: 1,
          keyId: "cpf-envelope-v1",
        },
      },
    });
    const copiedBuffers = [
      [row.operator_envelope_nonce, resolved.operator.envelope.nonce],
      [row.operator_envelope_auth_tag, resolved.operator.envelope.authTag],
      [operatorCiphertext, resolved.operator.envelope.ciphertext],
      [row.operator_envelope_aad_sha256, resolved.operator.envelope.aadSha256],
      [row.operator_identity_hmac, resolved.operator.envelope.hmac.digest],
      [row.establishment_envelope_nonce, resolved.establishment.envelope.nonce],
      [
        row.establishment_envelope_auth_tag,
        resolved.establishment.envelope.authTag,
      ],
      [establishmentCiphertext, resolved.establishment.envelope.ciphertext],
      [
        row.establishment_envelope_aad_sha256,
        resolved.establishment.envelope.aadSha256,
      ],
      [
        row.establishment_email_hmac,
        resolved.establishment.envelope.hmac.digest,
      ],
    ] as const;
    for (const [source, copy] of copiedBuffers) {
      expect(copy).not.toBe(source);
      const snapshot = Buffer.from(copy);
      source.fill(0);
      expect(copy.equals(snapshot)).toBe(true);
    }
  });

  it("sanitiza indisponibilidade sem propagar o erro do banco", async () => {
    const query = vi.fn().mockRejectedValue(
      Object.assign(new Error("renave principals: indisponíveis"), {
        code: "42501",
      }),
    );
    await expect(
      resolveVerifiedRenavePrincipals(client(query), {
        establishmentId: randomUUID(),
        idempotencyKeyDigest: Buffer.alloc(32),
        subject: "oidc|operator-1",
      }),
    ).rejects.toBeInstanceOf(RenavePrincipalResolutionUnavailableError);
  });

  it("falha fechado para envelope ou erro inesperado", async () => {
    const invalid = vi.fn().mockResolvedValue({
      rows: [
        {
          active_tenant_id: randomUUID(),
          establishment_profile_id: randomUUID(),
          operator_profile_id: randomUUID(),
        },
      ],
    });
    await expect(
      resolveVerifiedRenavePrincipals(client(invalid), {
        establishmentId: randomUUID(),
        idempotencyKeyDigest: Buffer.alloc(32),
        subject: "oidc|operator-1",
      }),
    ).rejects.toBeInstanceOf(RenavePrincipalResolutionStorageError);

    const failed = vi.fn().mockRejectedValue(new Error("driver details"));
    await expect(
      resolveVerifiedRenavePrincipals(client(failed), {
        establishmentId: randomUUID(),
        idempotencyKeyDigest: Buffer.alloc(32),
        subject: "oidc|operator-1",
      }),
    ).rejects.toBeInstanceOf(RenavePrincipalResolutionStorageError);
  });
});
