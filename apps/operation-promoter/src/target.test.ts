import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";

import { OperationPromoterError } from "./errors.js";
import {
  parseOperationPromoterTarget,
  validateDatabaseConfig,
} from "./target.js";

const DATABASE_ID = "00000000-0000-4000-8000-000000000074";

function targetJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      database: { host: "db.internal", name: "renave", port: 5432 },
      decisionKeyringDigest: Buffer.alloc(32, 0x32).toString("base64url"),
      environment: "homologation",
      executorWorkloadDigest: Buffer.alloc(32, 0x31).toString("base64url"),
      logicalDatabaseId: DATABASE_ID,
      schemaVersion: 1,
      ...overrides,
    }),
  );
}

describe("operation promoter target", () => {
  it("valida destino exato, role na URL e CA pública", () => {
    const bytes = targetJson();
    const target = parseOperationPromoterTarget(bytes);
    bytes.fill(0);
    const config = validateDatabaseConfig({
      caBytes: Buffer.from(rootCertificates[0]!),
      databaseUrlBytes: Buffer.from(
        "postgresql://renave_operation_promoter:secret@db.internal:5432/renave",
      ),
      target,
    });
    expect(config.servername).toBe("db.internal");
    expect(config.connectionString).not.toContain("sslmode=disable");
    target.executorWorkloadDigest.fill(0);
    target.decisionKeyringDigest.fill(0);
  });

  it.each([
    "postgresql://renave_app:secret@db.internal:5432/renave",
    "postgresql://renave_operation_promoter:secret@other.internal:5432/renave",
    "postgresql://renave_operation_promoter:secret@db.internal:5432/other",
    "postgresql://renave_operation_promoter:secret@db.internal:5432/renave?sslmode=disable",
    "http://renave_operation_promoter:secret@db.internal:5432/renave",
  ])("rejeita DSN fora do destino fechado", (databaseUrl) => {
    const target = parseOperationPromoterTarget(targetJson());
    expect(() =>
      validateDatabaseConfig({
        caBytes: Buffer.from(rootCertificates[0]!),
        databaseUrlBytes: Buffer.from(databaseUrl),
        target,
      }),
    ).toThrow(OperationPromoterError);
    target.executorWorkloadDigest.fill(0);
    target.decisionKeyringDigest.fill(0);
  });

  it("rejeita target com campos extras, ambiente ou digest inválido", () => {
    for (const value of [
      targetJson({ extra: true }),
      targetJson({ environment: "development" }),
      targetJson({ executorWorkloadDigest: "AA" }),
      targetJson({ logicalDatabaseId: "renave-hml" }),
    ]) {
      expect(() => parseOperationPromoterTarget(value)).toThrow(
        OperationPromoterError,
      );
      value.fill(0);
    }
  });

  it("rejeita CA inválida ou contendo chave privada", () => {
    const target = parseOperationPromoterTarget(targetJson());
    for (const ca of [
      "invalid",
      "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----",
    ]) {
      expect(() =>
        validateDatabaseConfig({
          caBytes: Buffer.from(ca),
          databaseUrlBytes: Buffer.from(
            "postgresql://renave_operation_promoter:secret@db.internal:5432/renave",
          ),
          target,
        }),
      ).toThrow(OperationPromoterError);
    }
    target.executorWorkloadDigest.fill(0);
    target.decisionKeyringDigest.fill(0);
  });
});
