import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import {
  assertPinConfirmation,
  inspectPinWithClient,
  provisioningDatabaseConfig,
  STOCK_ENTRY_PIN_WRITE_ONCE_ACK,
} from "./pin-provisioner.js";

function bundle() {
  let seed = 0;
  return generateStockEntryKeyBundle("hml-confirm", (size) =>
    Buffer.alloc(size, ++seed),
  );
}

describe("provisionamento do pin HELD_LOCAL", () => {
  it("exige confirmação exata da geração, fingerprint e backup", () => {
    const value = bundle();
    try {
      expect(() =>
        assertPinConfirmation({
          acknowledgement: STOCK_ENTRY_PIN_WRITE_ONCE_ACK,
          bundle: value,
          confirmFingerprint: value.digests.fingerprint.toString("hex"),
          confirmGeneration: value.digests.generationId,
        }),
      ).not.toThrow();
      expect(() =>
        assertPinConfirmation({
          acknowledgement: "no",
          bundle: value,
          confirmFingerprint: value.digests.fingerprint.toString("hex"),
          confirmGeneration: value.digests.generationId,
        }),
      ).toThrow(expect.objectContaining({ code: "PIN_CONFIRMATION_INVALID" }));
    } finally {
      destroyStockEntryKeyBundle(value);
    }
  });

  it("recusa papel diferente do migrator sem consultar o pin", async () => {
    const value = bundle();
    const query = vi.fn(async (sql: string) => {
      if (
        sql === "begin" ||
        sql.startsWith("set local") ||
        sql === "rollback"
      ) {
        return { rows: [] };
      }
      if (sql.includes("from pg_catalog.pg_roles")) {
        return {
          rows: [
            {
              current_bypassrls: false,
              current_createdb: false,
              current_createrole: false,
              current_name: "renave_app",
              current_super: false,
              session_bypassrls: false,
              session_createdb: false,
              session_createrole: false,
              session_name: "renave_app",
              session_super: false,
            },
          ],
        };
      }
      throw new Error("consulta inesperada");
    });
    try {
      await expect(
        inspectPinWithClient({ query } as unknown as PoolClient, value),
      ).rejects.toMatchObject({ code: "DATABASE_ROLE_INVALID" });
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes("count(*)")),
      ).toBe(false);
    } finally {
      destroyStockEntryKeyBundle(value);
    }
  });

  it("recusa banco remoto sem CA e qualquer parâmetro de query", () => {
    expect(() =>
      provisioningDatabaseConfig(
        "postgres://renave_migrator:secret@db.example/renave",
        undefined,
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }));
    expect(() =>
      provisioningDatabaseConfig(
        "postgres://renave_migrator:secret@127.0.0.1/renave?sslmode=disable",
        undefined,
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }));
    expect(
      provisioningDatabaseConfig(
        "postgres://renave_migrator:secret@db.example/renave",
        "trusted-ca",
      ).ssl,
    ).toEqual({ ca: "trusted-ca", rejectUnauthorized: true });
  });
});
