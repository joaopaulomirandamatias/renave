import { describe, expect, it } from "vitest";

import {
  assertAuthorized,
  AuthorizationDeniedError,
  authorize,
  type AuthorizationContext,
} from "./index.js";

const operator: AuthorizationContext = {
  grants: [{ establishmentIds: ["establishment-a"], role: "renave_operator" }],
  subject: "operator-1",
  tenantId: "tenant-a",
};

describe("authorize", () => {
  it("autoriza operador somente no estabelecimento atribuído", () => {
    expect(
      authorize(operator, {
        action: "renave.stock.read",
        establishmentId: "establishment-a",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true, matchedRole: "renave_operator" });

    expect(
      authorize(operator, {
        action: "renave.stock-entry.request",
        establishmentId: "establishment-b",
        tenantId: "tenant-a",
      }),
    ).toEqual({ allowed: false, reason: "ESTABLISHMENT_SCOPE_DENIED" });
  });

  it("nega troca de tenant mesmo com o mesmo papel", () => {
    expect(
      authorize(operator, {
        action: "renave.vehicle.eligibility.read",
        establishmentId: "establishment-a",
        tenantId: "tenant-b",
      }),
    ).toEqual({ allowed: false, reason: "TENANT_MISMATCH" });
  });

  it("autoriza consulta veicular somente no tenant e estabelecimento atribuídos", () => {
    expect(
      authorize(operator, {
        action: "renave.vehicle.read",
        establishmentId: "establishment-a",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true, matchedRole: "renave_operator" });
    expect(
      authorize(operator, {
        action: "renave.vehicle.read",
        establishmentId: "establishment-b",
        tenantId: "tenant-a",
      }),
    ).toEqual({ allowed: false, reason: "ESTABLISHMENT_SCOPE_DENIED" });
    expect(
      authorize(operator, {
        action: "renave.vehicle.read",
        establishmentId: "establishment-a",
        tenantId: "tenant-b",
      }),
    ).toEqual({ allowed: false, reason: "TENANT_MISMATCH" });
  });

  it("exige estabelecimento nas ações RENAVE", () => {
    expect(
      authorize(operator, {
        action: "renave.identity.verify",
        tenantId: "tenant-a",
      }),
    ).toEqual({ allowed: false, reason: "ESTABLISHMENT_REQUIRED" });
  });

  it("administra o tenant e todos os seus estabelecimentos", () => {
    const admin: AuthorizationContext = {
      grants: [{ establishmentIds: "*", role: "tenant_admin" }],
      subject: "admin-1",
      tenantId: "tenant-a",
    };
    expect(
      authorize(admin, {
        action: "tenant.user.manage",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(admin, {
        action: "renave.stock-entry.request",
        establishmentId: "any-establishment",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("auditor lê e exporta com justificativa, mas não opera o RENAVE", () => {
    const auditor: AuthorizationContext = {
      grants: [{ establishmentIds: "*", role: "compliance_auditor" }],
      subject: "auditor-1",
      tenantId: "tenant-a",
    };
    expect(
      authorize(auditor, {
        action: "audit.read",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(auditor, {
        action: "audit.export",
        tenantId: "tenant-a",
      }),
    ).toEqual({ allowed: false, reason: "JUSTIFICATION_REQUIRED" });
    expect(
      authorize(auditor, {
        action: "audit.export",
        justification: "Fiscalização formal 2026-11",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(auditor, {
        action: "renave.stock-entry.request",
        establishmentId: "establishment-a",
        tenantId: "tenant-a",
      }),
    ).toEqual({ allowed: false, reason: "ROLE_DENIED" });
  });

  it("falha fechada para contexto vazio", () => {
    expect(
      authorize(
        { grants: [], subject: "", tenantId: "" },
        {
          action: "audit.read",
          tenantId: "",
        },
      ),
    ).toEqual({ allowed: false, reason: "INVALID_CONTEXT" });
  });

  it("assertAuthorized preserva o motivo estruturado", () => {
    try {
      assertAuthorized(operator, {
        action: "audit.read",
        tenantId: "tenant-a",
      });
      throw new Error("deveria negar a autorização");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationDeniedError);
      expect(error).toMatchObject({
        code: "AUTHORIZATION_DENIED",
        reason: "ROLE_DENIED",
      });
    }
  });
});
