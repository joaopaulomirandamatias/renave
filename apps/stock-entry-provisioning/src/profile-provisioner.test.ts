import { describe, expect, it } from "vitest";

import {
  profileProvisioningDatabaseConfig,
  profileStatusDatabaseConfig,
} from "./profile-provisioner.js";

describe("conexão administrativa de perfis", () => {
  it("exige CA mesmo em loopback e força validação TLS", () => {
    const url =
      "postgres://renave_profile_provisioner:secret@127.0.0.1:5432/renave";
    expect(() =>
      profileProvisioningDatabaseConfig(url, undefined),
    ).toThrowError(
      expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }),
    );
    expect(profileProvisioningDatabaseConfig(url, "CA")).toMatchObject({
      application_name: "seu-renave-profile-provisioning",
      max: 1,
      ssl: { ca: "CA", rejectUnauthorized: true },
    });
    expect(
      profileStatusDatabaseConfig(
        "postgres://renave_profile_reader:secret@127.0.0.1:5432/renave",
        "CA",
      ),
    ).toMatchObject({
      application_name: "seu-renave-profile-status",
      max: 1,
      ssl: { ca: "CA", rejectUnauthorized: true },
    });
  });

  it("recusa parâmetros na URL e credenciais incompletas", () => {
    expect(() =>
      profileProvisioningDatabaseConfig(
        "postgres://renave_profile_provisioner:secret@db/renave?sslmode=disable",
        "CA",
      ),
    ).toThrow();
    expect(() =>
      profileProvisioningDatabaseConfig("postgres://db/renave", "CA"),
    ).toThrow();
  });
});
