import { describe, expect, it, vi } from "vitest";

import { runMunicipalityCatalogPublishCli } from "../../src/municipality-catalog-publish-cli.js";
import {
  MunicipalityCatalogPublicationRejectedError,
  municipalityCatalogPublisherPoolConfig,
  municipalityCatalogPublisherRoleIsSafe,
  publishVerifiedMunicipalityCatalog,
} from "../../src/municipality-catalog-publisher.js";
import type { VerifiedMunicipalityCatalogSnapshot } from "../../src/municipality-catalog-publication.js";

const snapshot = Object.freeze({
  artifactSha256: "b".repeat(64),
  codes: Object.freeze([1_501_402, 2_611_533, 3_303_807, 5_101_837]),
  manifestSha256: "c".repeat(64),
  observedAt: "2026-11-24T20:00:00.000Z",
  rowCount: 4,
  sourceSha256: "a".repeat(64),
  version: `renave-municipios-v1-${"a".repeat(64)}`,
}) satisfies VerifiedMunicipalityCatalogSnapshot;

const safeRole = Object.freeze({
  current_user: "renave_migrator",
  has_set_role: false,
  rolbypassrls: false,
  rolcanlogin: true,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolreplication: false,
  rolsuper: false,
  session_user: "renave_migrator",
});

describe("publicador do catálogo municipal", () => {
  it("fixa pool unitário e TLS autenticado para banco remoto", () => {
    expect(
      municipalityCatalogPublisherPoolConfig(
        "postgresql://publisher:secret@db.internal:5432/renave",
        "CA CONFIÁVEL",
      ),
    ).toMatchObject({
      application_name: "renavestoque-municipality-catalog-publisher",
      max: 1,
      ssl: { ca: "CA CONFIÁVEL", rejectUnauthorized: true },
    });
    expect(
      municipalityCatalogPublisherPoolConfig(
        "postgresql://publisher:secret@127.0.0.1:5432/renave",
        undefined,
      ),
    ).not.toHaveProperty("ssl");
  });

  it.each([
    "postgresql://publisher:secret@db.internal:5432/renave",
    "postgresql://publisher:secret@db.internal:5432/renave?sslmode=no-verify",
    "https://publisher:secret@db.internal/renave",
    "postgresql://db.internal/renave",
  ])("recusa configuração de banco ambígua sem expô-la: %s", (url) => {
    expect(() =>
      municipalityCatalogPublisherPoolConfig(url, undefined),
    ).toThrow(MunicipalityCatalogPublicationRejectedError);
  });

  it("exige o migrator direto e recusa cada capacidade elevada", () => {
    expect(municipalityCatalogPublisherRoleIsSafe(safeRole)).toBe(true);
    for (const mutation of [
      { current_user: "renave_app" },
      { session_user: "renave_app" },
      { rolcanlogin: false },
      { rolsuper: true },
      { rolbypassrls: true },
      { rolinherit: true },
      { rolcreatedb: true },
      { rolcreaterole: true },
      { rolreplication: true },
      { has_set_role: true },
    ]) {
      expect(
        municipalityCatalogPublisherRoleIsSafe({
          ...safeRole,
          ...mutation,
        }),
      ).toBe(false);
    }
    expect(municipalityCatalogPublisherRoleIsSafe(undefined)).toBe(false);
  });

  it.each([
    {
      maximumAgeMs: 3_600_000,
      now: new Date("2026-11-24T19:59:59.999Z"),
    },
    {
      maximumAgeMs: 3_600_000,
      now: new Date("2026-11-24T21:00:00.001Z"),
    },
    { maximumAgeMs: 0, now: new Date("2026-11-24T20:00:00.000Z") },
    {
      maximumAgeMs: 86_400_001,
      now: new Date("2026-11-24T20:00:00.000Z"),
    },
  ])("recusa política temporal antes de abrir conexão", async (policy) => {
    const connect = vi.fn();
    await expect(
      publishVerifiedMunicipalityCatalog(
        { connect } as never,
        snapshot,
        policy,
      ),
    ).rejects.toBeInstanceOf(MunicipalityCatalogPublicationRejectedError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("sanitiza falhas da CLI sem ecoar argumentos", async () => {
    const previousExitCode = process.exitCode;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await runMunicipalityCatalogPublishCli([
        "publish",
        "--manifest",
        "/segredo/manifest.json",
      ]);
      expect(String(write.mock.calls[0]?.[0] ?? "")).toBe(
        '{"code":"MUNICIPALITY_CATALOG_PUBLICATION_REJECTED"}\n',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
    }
  });
});
