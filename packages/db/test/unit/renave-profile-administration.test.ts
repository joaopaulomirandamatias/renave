import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  assertProfileProvisionerSession,
  stageOperatorRenaveProfile,
} from "../../src/renave-profile-administration.js";

describe("RENAVE profile administration adapter", () => {
  it("zera todas as cópias sensíveis depois da query", async () => {
    let valuesSeen: unknown[] = [];
    const database = {
      async query<T extends QueryResultRow>(
        _text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        valuesSeen = values ?? [];
        return {
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [
            {
              profile_id: "10000000-0000-4000-8000-000000000001",
              profile_status: "pending",
              profile_version: "1",
              replayed: false,
            } as unknown as T,
          ],
        };
      },
    };

    await stageOperatorRenaveProfile(database, {
      tenantId: "10000000-0000-4000-8000-000000000002",
      subject: "oidc|operator",
      profileId: "10000000-0000-4000-8000-000000000001",
      hmacKeyId: "hmac-v1",
      identityHmac: Buffer.alloc(32, 1),
      envelope: {
        schemaVersion: 1,
        keyId: "envelope-v1",
        nonce: Buffer.alloc(12, 2),
        authTag: Buffer.alloc(16, 3),
        ciphertext: Buffer.alloc(128, 4),
        aadSha256: Buffer.alloc(32, 5),
      },
      assertion: { digest: Buffer.alloc(32, 6), keyId: "assertion-v1" },
      changedBy: { digest: Buffer.alloc(32, 7), keyId: "actor-v1" },
    });

    const sensitiveCopies = valuesSeen.filter(Buffer.isBuffer);
    expect(sensitiveCopies).toHaveLength(7);
    for (const value of sensitiveCopies) {
      expect(value.equals(Buffer.alloc(value.length))).toBe(true);
    }
  });

  it("recusa papel homônimo com qualquer atributo privilegiado", async () => {
    const database = {
      async query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
        return {
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [
            {
              current_role: "renave_profile_provisioner",
              session_role: "renave_profile_provisioner",
              rolbypassrls: true,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolsuper: false,
            } as unknown as T,
          ],
        };
      },
    };
    await expect(assertProfileProvisionerSession(database)).rejects.toThrow(
      "Conexão deve usar exclusivamente",
    );
  });
});
