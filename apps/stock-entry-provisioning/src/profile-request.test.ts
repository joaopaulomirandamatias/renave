import { describe, expect, it } from "vitest";

import { parseProfileProvisioningRequest } from "./profile-request.js";

const base = {
  schemaVersion: 1,
  tenantId: "11111111-1111-4111-8111-111111111111",
  actorSubject: "oidc-admin-subject",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
};

describe("request administrativo de perfis", () => {
  it("aceita somente o schema exato de staging", () => {
    const request = parseProfileProvisioningRequest(
      JSON.stringify({
        ...base,
        command: "stage-operator",
        profileId: "33333333-3333-4333-8333-333333333333",
        subject: "operator-subject",
        cpf: "52998224725",
      }),
    );
    expect(request.command).toBe("stage-operator");
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...request, status: "verified" }),
      ),
    ).toThrow();
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...request, verificationSource: "serpro" }),
      ),
    ).toThrow();
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...request, verifiedAt: new Date().toISOString() }),
      ),
    ).toThrow();
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...request, verifier: "human" }),
      ),
    ).toThrow();
  });

  it("exige confirmação fechada e versão positiva para suspensão", () => {
    const valid = {
      ...base,
      command: "suspend-establishment",
      establishmentId: "44444444-4444-4444-8444-444444444444",
      expectedVersion: 2,
      reasonCode: "access_revoked",
      confirmation: "SUSPEND_RENAVE_PROFILE",
    };
    expect(parseProfileProvisioningRequest(JSON.stringify(valid)).command).toBe(
      "suspend-establishment",
    );
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...valid, confirmation: "yes" }),
      ),
    ).toThrow();
    expect(() =>
      parseProfileProvisioningRequest(
        JSON.stringify({ ...valid, expectedVersion: 0 }),
      ),
    ).toThrow();
  });
});
