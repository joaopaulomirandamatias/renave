import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceCipher } from "@seu-renave/protected-evidence";
import type {
  RenaveQueryConnector,
  RenaveVehicleLookupConnector,
} from "@seu-renave/renave-connector";
import type { Pool } from "pg";

const database = vi.hoisted(() => ({
  getAuthorizationContext: vi.fn(),
  getCredentialLink: vi.fn(),
  getEstablishment: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock("@seu-renave/db/api-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seu-renave/db/api-runtime")>()),
  getAuthorizationContext: database.getAuthorizationContext,
  getCredentialLink: database.getCredentialLink,
  getEstablishment: database.getEstablishment,
  withTenant: database.withTenant,
}));

import { PostgresVehicleLookupUseCase } from "./vehicle-lookup-use-case.js";

const TENANT_ID = "5b13742c-4c89-4658-83f7-c247540f178c";
const ESTABLISHMENT_ID = "7e7577ea-131b-48cb-8437-ce779f609417";
const SUBJECT = "oidc|operador-1";

function useCase() {
  return new PostgresVehicleLookupUseCase({
    certificateThumbprintSha256: "a".repeat(64),
    cipher: {} as EvidenceCipher,
    integratorCnpj: "12ABC34501DE35",
    pool: {} as Pool,
    stockConnector: {} as Pick<RenaveQueryConnector, "getStocksByPlate">,
    vehicleConnector: {} as Pick<
      RenaveVehicleLookupConnector,
      "getVehicleByPlate"
    >,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  database.withTenant.mockImplementation(
    async (_pool, _tenantId, callback: (client: object) => unknown) =>
      callback({}),
  );
  database.getAuthorizationContext.mockResolvedValue({
    grants: [{ establishmentIds: [ESTABLISHMENT_ID], role: "renave_operator" }],
    subject: SUBJECT,
    tenantId: TENANT_ID,
  });
  database.getEstablishment.mockResolvedValue({
    id: ESTABLISHMENT_ID,
    status: "active",
  });
  database.getCredentialLink.mockResolvedValue({ status: "confirmed" });
});

describe("PostgresVehicleLookupUseCase.authorize", () => {
  it("aceita operador vinculado, estabelecimento ativo e vínculo confirmado", async () => {
    await expect(
      useCase().authorize({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).resolves.toBeUndefined();

    expect(database.withTenant).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
    expect(database.getAuthorizationContext).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
    );
    expect(database.getEstablishment).toHaveBeenCalledWith(
      expect.anything(),
      ESTABLISHMENT_ID,
    );
    expect(database.getCredentialLink).toHaveBeenCalledWith(
      expect.anything(),
      ESTABLISHMENT_ID,
    );
  });

  it("nega BOLA antes de consultar estabelecimento ou vínculo", async () => {
    database.getAuthorizationContext.mockResolvedValue({
      grants: [
        {
          establishmentIds: ["18f6096f-463d-4afe-a0c7-e56900adf494"],
          role: "renave_operator",
        },
      ],
      subject: SUBJECT,
      tenantId: TENANT_ID,
    });

    await expect(
      useCase().authorize({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(database.getEstablishment).not.toHaveBeenCalled();
    expect(database.getCredentialLink).not.toHaveBeenCalled();
  });

  it.each([null, { status: "pending" }, { status: "rejected" }])(
    "recusa vínculo não confirmado %#",
    async (link) => {
      database.getCredentialLink.mockResolvedValue(link);
      await expect(
        useCase().authorize({
          establishmentId: ESTABLISHMENT_ID,
          subject: SUBJECT,
          tenantId: TENANT_ID,
        }),
      ).rejects.toMatchObject({ code: "RENAVE_LINK_NOT_READY" });
    },
  );

  it("recusa estabelecimento inativo", async () => {
    database.getEstablishment.mockResolvedValue({
      id: ESTABLISHMENT_ID,
      status: "inactive",
    });
    await expect(
      useCase().authorize({
        establishmentId: ESTABLISHMENT_ID,
        subject: SUBJECT,
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({ code: "ESTABLISHMENT_UNAVAILABLE" });
  });
});
