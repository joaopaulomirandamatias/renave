import { randomUUID } from "node:crypto";

import {
  assertProfileProvisionerSession,
  assertProfileReaderSession,
} from "@seu-renave/db";
import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";
import { Client, type PoolClient } from "pg";
import { describe, expect, inject, it } from "vitest";

import {
  destroyProfileAdminMasterKey,
  generateProfileAdminMasterKey,
} from "../profile-admin-key.js";
import { executeProfileCommand } from "../profile-provisioner.js";

function bundle() {
  let seed = 0;
  return generateStockEntryKeyBundle("hml-profile-integration", (size) =>
    Buffer.alloc(size, ++seed),
  );
}

describe("administração de perfis no PostgreSQL", () => {
  it("faz stage idempotente, status sanitizado e suspensão confirmada", async () => {
    const urls = inject("dbUrls");
    const admin = new Client({ connectionString: urls.admin });
    const profile = new Client({ connectionString: urls.profileProvisioner });
    const reader = new Client({ connectionString: urls.profileReader });
    await Promise.all([admin.connect(), profile.connect(), reader.connect()]);
    const tenantId = randomUUID();
    const profileId = randomUUID();
    const subject = `operator-${randomUUID()}`;
    const value = bundle();
    const adminKey = generateProfileAdminMasterKey(
      "profile-admin-it-v1",
      (size) => Buffer.alloc(size, 21),
    );
    try {
      await admin.query(
        `insert into renave.tenant (id, slug, display_name)
         values ($1, $2, 'Profile integration')`,
        [tenantId, `profile-${tenantId}`],
      );
      await admin.query(
        `insert into renave.tenant_user (tenant_id, subject) values ($1, $2)`,
        [tenantId, subject],
      );
      await assertProfileProvisionerSession(profile);
      await assertProfileReaderSession(reader);
      await expect(assertProfileReaderSession(profile)).rejects.toThrow();
      await expect(assertProfileProvisionerSession(reader)).rejects.toThrow();
      const client = profile as unknown as PoolClient;
      const readerClient = reader as unknown as PoolClient;
      const stage = {
        schemaVersion: 1 as const,
        command: "stage-operator" as const,
        tenantId,
        profileId,
        subject,
        cpf: "52998224725",
        actorSubject: "integration-admin",
        idempotencyKey: randomUUID(),
      };
      expect(
        await executeProfileCommand(client, {
          adminKey,
          bundle: value,
          request: stage,
        }),
      ).toEqual({
        profileId,
        status: "pending",
        version: 1,
        replayed: false,
      });
      expect(
        await executeProfileCommand(client, {
          adminKey,
          bundle: value,
          request: stage,
        }),
      ).toEqual({
        profileId,
        status: "pending",
        version: 1,
        replayed: true,
      });
      expect(
        await executeProfileCommand(readerClient, {
          request: {
            schemaVersion: 1,
            command: "profile-status",
            tenantId,
            profileKind: "operator",
            subject,
          },
        }),
      ).toEqual({ profileId, status: "pending", version: 1 });
      await expect(
        executeProfileCommand(client, {
          request: {
            schemaVersion: 1,
            command: "profile-status",
            tenantId,
            profileKind: "operator",
            subject,
          },
        }),
      ).rejects.toThrow();
      await expect(
        executeProfileCommand(readerClient, {
          adminKey,
          bundle: value,
          request: stage,
        }),
      ).rejects.toThrow();
      const suspend = {
        schemaVersion: 1 as const,
        command: "suspend-operator" as const,
        tenantId,
        subject,
        expectedVersion: 1,
        reasonCode: "access_revoked",
        confirmation: "SUSPEND_RENAVE_PROFILE" as const,
        actorSubject: "integration-admin",
        idempotencyKey: randomUUID(),
      };
      expect(
        await executeProfileCommand(client, {
          adminKey,
          bundle: value,
          request: suspend,
        }),
      ).toEqual({
        profileId,
        status: "suspended",
        version: 2,
        replayed: false,
      });
      expect(
        await executeProfileCommand(client, {
          adminKey,
          bundle: value,
          request: suspend,
        }),
      ).toEqual({
        profileId,
        status: "suspended",
        version: 2,
        replayed: true,
      });
      await expect(
        executeProfileCommand(client, {
          adminKey,
          bundle: value,
          request: { ...suspend, idempotencyKey: randomUUID() },
        }),
      ).rejects.toThrow();
    } finally {
      destroyProfileAdminMasterKey(adminKey);
      destroyStockEntryKeyBundle(value);
      await Promise.all([admin.end(), profile.end(), reader.end()]);
    }
  });
});
