import { Client, type PoolClient } from "pg";
import { describe, expect, inject, it } from "vitest";

import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import {
  inspectPinWithClient,
  provisionPinWithClient,
} from "../pin-provisioner.js";

function bundle() {
  let seed = 0;
  return generateStockEntryKeyBundle("hml-integration", (size) =>
    Buffer.alloc(size, ++seed),
  );
}

describe("pin write-once no PostgreSQL", () => {
  it("provisiona uma vez e recusa repetição ou mutação", async () => {
    const urls = inject("dbUrls");
    const migrator = new Client({ connectionString: urls.migrator });
    await migrator.connect();
    const value = bundle();
    try {
      expect(
        await inspectPinWithClient(migrator as unknown as PoolClient, value),
      ).toBe("absent");
      await provisionPinWithClient(migrator as unknown as PoolClient, value);
      expect(
        await inspectPinWithClient(migrator as unknown as PoolClient, value),
      ).toBe("matching");
      await expect(
        provisionPinWithClient(migrator as unknown as PoolClient, value),
      ).rejects.toMatchObject({ code: "PIN_STATE_DIVERGENT" });
      await expect(
        migrator.query(
          `update renave_runtime.stock_entry_runtime_key_generation
              set generation_id = 'forbidden'`,
        ),
      ).rejects.toThrow();
      await expect(
        migrator.query(
          `delete from renave_runtime.stock_entry_runtime_key_generation`,
        ),
      ).rejects.toThrow();
      await expect(
        migrator.query(
          `truncate renave_runtime.stock_entry_runtime_key_generation`,
        ),
      ).rejects.toThrow();
    } finally {
      destroyStockEntryKeyBundle(value);
      await migrator.end();
    }
  });

  it("recusa explicitamente o papel de runtime", async () => {
    const urls = inject("dbUrls");
    const app = new Client({ connectionString: urls.app });
    await app.connect();
    const value = bundle();
    try {
      await expect(
        inspectPinWithClient(app as unknown as PoolClient, value),
      ).rejects.toMatchObject({ code: "DATABASE_ROLE_INVALID" });
    } finally {
      destroyStockEntryKeyBundle(value);
      await app.end();
    }
  });

  it("recusa superuser que usa SET ROLE para parecer migrator", async () => {
    const urls = inject("dbUrls");
    const admin = new Client({ connectionString: urls.admin });
    await admin.connect();
    const value = bundle();
    try {
      await admin.query("set role renave_migrator");
      await expect(
        inspectPinWithClient(admin as unknown as PoolClient, value),
      ).rejects.toMatchObject({ code: "DATABASE_ROLE_INVALID" });
    } finally {
      await admin.query("reset role").catch(() => undefined);
      destroyStockEntryKeyBundle(value);
      await admin.end();
    }
  });
});
