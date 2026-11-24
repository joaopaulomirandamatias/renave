import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getAuthorizationContext: vi.fn(),
  getCredentialLink: vi.fn(),
  getEstablishment: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock("@seu-renave/db", () => db);

import {
  publicCertificateReadiness,
  PostgresRenaveReadinessUseCase,
  summarizeRenaveReadiness,
} from "./readiness-use-case.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "oidc|operator-1";

beforeEach(() => {
  vi.clearAllMocks();
  db.withTenant.mockImplementation(
    async (
      _pool: unknown,
      _tenantId: string,
      work: (client: object) => unknown,
    ) => await work({}),
  );
  db.getAuthorizationContext.mockResolvedValue({
    grants: [{ establishmentIds: [ESTABLISHMENT_ID], role: "renave_operator" }],
    subject: SUBJECT,
    tenantId: TENANT_ID,
  });
  db.getEstablishment.mockResolvedValue({
    id: ESTABLISHMENT_ID,
    status: "active",
    tenantId: TENANT_ID,
  });
  db.getCredentialLink.mockResolvedValue({ status: "confirmed" });
});

describe("prontidão RENAVE sanitizada", () => {
  it.each([
    ["healthy", "ready"],
    ["expiring_90d", "warning"],
    ["expiring_1d", "warning"],
    ["expired", "blocked"],
    ["not_yet_valid", "blocked"],
    ["invalid_clock", "blocked"],
  ] as const)("projeta %s como %s", (source, expected) => {
    expect(publicCertificateReadiness(true, source)).toBe(expected);
  });

  it("distingue integração desabilitada sem afirmar falha de certificado", () => {
    expect(publicCertificateReadiness(false)).toBe("unavailable");
    expect(
      summarizeRenaveReadiness({
        integrationConfigured: false,
        link: "not_started",
        queryLimiterConfigured: false,
      }),
    ).toEqual({
      certificate: "unavailable",
      environment: "homologation",
      integration: "disabled",
      link: "not_started",
      mutations: "blocked",
      queries: "blocked",
    });
  });

  it.each(["confirmed", "enabled"] as const)(
    "libera somente consultas locais quando o vínculo está %s",
    (link) => {
      expect(
        summarizeRenaveReadiness({
          certificateStatus: "expiring_30d",
          integrationConfigured: true,
          link,
          queryLimiterConfigured: true,
        }),
      ).toEqual({
        certificate: "warning",
        environment: "homologation",
        integration: "configured",
        link,
        mutations: "blocked",
        queries: "ready",
      });
    },
  );

  it.each([
    ["expired", true, "confirmed"],
    ["healthy", false, "confirmed"],
    ["healthy", true, "pending"],
  ] as const)(
    "mantém consultas bloqueadas quando falta um gate",
    (certificateStatus, queryLimiterConfigured, link) => {
      expect(
        summarizeRenaveReadiness({
          certificateStatus,
          integrationConfigured: true,
          link,
          queryLimiterConfigured,
        }).queries,
      ).toBe("blocked");
    },
  );

  it("carrega autorização, estabelecimento e vínculo no mesmo tenant", async () => {
    const temporalStatus = vi.fn(() => "healthy" as const);
    const useCase = new PostgresRenaveReadinessUseCase({
      certificateTemporalStatus: temporalStatus,
      integrationConfigured: true,
      pool: {} as never,
      queryLimiterConfigured: true,
    });

    await expect(
      useCase.execute({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).resolves.toMatchObject({ queries: "ready" });

    expect(db.withTenant).toHaveBeenCalledOnce();
    expect(db.withTenant).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
    expect(db.getAuthorizationContext).toHaveBeenCalledOnce();
    expect(db.getEstablishment).toHaveBeenCalledOnce();
    expect(db.getCredentialLink).toHaveBeenCalledOnce();
    expect(temporalStatus).toHaveBeenCalledOnce();
  });

  it("nega contexto de outro tenant antes de consultar a loja ou certificado", async () => {
    db.getAuthorizationContext.mockResolvedValueOnce({
      grants: [
        { establishmentIds: [ESTABLISHMENT_ID], role: "renave_operator" },
      ],
      subject: SUBJECT,
      tenantId: OTHER_TENANT_ID,
    });
    const temporalStatus = vi.fn(() => "healthy" as const);
    const useCase = new PostgresRenaveReadinessUseCase({
      certificateTemporalStatus: temporalStatus,
      integrationConfigured: true,
      pool: {} as never,
      queryLimiterConfigured: true,
    });

    await expect(
      useCase.execute({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      reason: "TENANT_MISMATCH",
    });
    expect(db.getEstablishment).not.toHaveBeenCalled();
    expect(db.getCredentialLink).not.toHaveBeenCalled();
    expect(temporalStatus).not.toHaveBeenCalled();
  });

  it("nega operador fora do escopo sem revelar a existência da loja", async () => {
    db.getAuthorizationContext.mockResolvedValueOnce({
      grants: [
        {
          establishmentIds: ["33333333-3333-4333-8333-333333333333"],
          role: "renave_operator",
        },
      ],
      subject: SUBJECT,
      tenantId: TENANT_ID,
    });
    const useCase = new PostgresRenaveReadinessUseCase({
      integrationConfigured: false,
      pool: {} as never,
      queryLimiterConfigured: false,
    });

    await expect(
      useCase.execute({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(db.getEstablishment).not.toHaveBeenCalled();
    expect(db.getCredentialLink).not.toHaveBeenCalled();
  });

  it("falha fechada se a leitura temporal local lançar erro", async () => {
    const useCase = new PostgresRenaveReadinessUseCase({
      certificateTemporalStatus: () => {
        throw new Error("/run/secrets/certificate.pem");
      },
      integrationConfigured: true,
      pool: {} as never,
      queryLimiterConfigured: true,
    });

    await expect(
      useCase.execute({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).resolves.toEqual({
      certificate: "blocked",
      environment: "homologation",
      integration: "configured",
      link: "confirmed",
      mutations: "blocked",
      queries: "blocked",
    });
  });
});
