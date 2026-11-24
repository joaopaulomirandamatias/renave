import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext } from "@seu-renave/access-control";
import {
  RenaveHttpError,
  type MutationResult,
  type RenaveVehicle,
  type StockQueryResult,
} from "@seu-renave/renave-connector";

import {
  VehicleLookupService,
  type VehicleLookupAuditRecord,
  type VehicleLookupFinalizationPort,
  type VehicleLookupPorts,
} from "./vehicle-lookup.js";

const TENANT_ID = "5b13742c-4c89-4658-83f7-c247540f178c";
const ESTABLISHMENT_ID = "7e7577ea-131b-48cb-8437-ce779f609417";
const SUBJECT = "oidc|operador-1";
const ESTABLISHMENT_CNPJ = "11222333000181";
const INTEGRATOR_CNPJ = "12ABC34501DE35";
const CERTIFICATE_SHA256 = "d".repeat(64);
const PAYLOAD_REFERENCE = "pev1_11111111-1111-4111-8111-111111111111";

const operatorContext: AuthorizationContext = {
  grants: [{ establishmentIds: [ESTABLISHMENT_ID], role: "renave_operator" }],
  subject: SUBJECT,
  tenantId: TENANT_ID,
};

const identity = {
  confirmedEstablishmentCnpj: ESTABLISHMENT_CNPJ,
  confirmedIntegratorCnpj: INTEGRATOR_CNPJ,
  environment: "homologation" as const,
  establishmentId: ESTABLISHMENT_ID,
  tenantId: TENANT_ID,
};

const stockEvidence = {
  codigoSegurancaCrv: "segredo",
  estado: "CONFIRMADO" as const,
  id: 7,
  placa: "ABC1D23",
  renavam: "00607701676",
};

const stockResult: MutationResult<StockQueryResult> = {
  result: {
    evidence: [stockEvidence],
    publicResult: [{ estado: "CONFIRMADO", id: 7, placa: "ABC1D23" }],
  },
  verifiedIdentity: identity,
};

const vehicleResult: MutationResult<RenaveVehicle> = {
  result: {
    chassi: "9BWZZZ377VT004251",
    placa: "ABC1D23",
    renavam: "00607701676",
    restricoes: [{ codigoTipo: "01", tipo: "Administrativa" }],
    veiculoAcabado: true,
  },
  verifiedIdentity: identity,
};

function harness(options?: {
  stock?: MutationResult<StockQueryResult>;
  stockError?: Error;
  vehicle?: MutationResult<RenaveVehicle>;
  vehicleError?: Error;
}) {
  const calls: string[] = [];
  const attempted: VehicleLookupAuditRecord[] = [];
  const getStocksByPlate = vi.fn(async () => {
    calls.push("stock");
    if (options?.stockError) throw options.stockError;
    return options?.stock ?? stockResult;
  });
  const getVehicleByPlate = vi.fn(async () => {
    calls.push("vehicle");
    if (options?.vehicleError) throw options.vehicleError;
    return options?.vehicle ?? vehicleResult;
  });
  const fail = vi.fn(
    async (_input: Parameters<VehicleLookupFinalizationPort["fail"]>[0]) => {
      calls.push("finalize-failure");
    },
  );
  const succeed = vi.fn(
    async (_input: Parameters<VehicleLookupFinalizationPort["succeed"]>[0]) => {
      calls.push("finalize-success");
    },
  );
  const ports: VehicleLookupPorts = {
    audit: {
      append: vi.fn(async (record) => {
        attempted.push(record);
        calls.push("audit-attempt");
      }),
    },
    authorizationContexts: { load: vi.fn(async () => operatorContext) },
    connector: { getStocksByPlate, getVehicleByPlate },
    establishments: {
      load: vi.fn(async () => ({
        cnpj: ESTABLISHMENT_CNPJ,
        id: ESTABLISHMENT_ID,
        status: "active" as const,
        tenantId: TENANT_ID,
      })),
    },
    finalization: { fail, succeed },
    protectedEvidence: {
      begin: vi.fn(async () => ({ payloadReference: PAYLOAD_REFERENCE })),
    },
  };
  return {
    attempted,
    calls,
    fail,
    getStocksByPlate,
    getVehicleByPlate,
    ports,
    service: new VehicleLookupService(ports, {
      certificateThumbprintSha256: CERTIFICATE_SHA256,
      integratorCnpj: INTEGRATOR_CNPJ,
    }),
    succeed,
  };
}

const input = {
  actorIp: "198.51.100.10",
  establishmentId: ESTABLISHMENT_ID,
  plate: " abc1d23 ",
  subject: SUBJECT,
  tenantId: TENANT_ID,
  traceId: "trace-vehicle-1",
};

describe("VehicleLookupService", () => {
  it("prova o estoque antes do veículo e finaliza antes de retornar", async () => {
    const test = harness();

    const result = await test.service.execute(input);

    expect(result).toEqual(vehicleResult.result);
    expect(test.calls).toEqual([
      "audit-attempt",
      "stock",
      "vehicle",
      "finalize-success",
    ]);
    expect(test.getStocksByPlate).toHaveBeenCalledWith(
      expect.objectContaining({
        establishmentId: ESTABLISHMENT_ID,
        tenantId: TENANT_ID,
      }),
      "ABC1D23",
    );
    expect(test.getVehicleByPlate).toHaveBeenCalledWith(
      expect.any(Object),
      "ABC1D23",
    );
    expect(test.succeed).toHaveBeenCalledWith({
      audit: expect.objectContaining({
        action: "renave.vehicle.read",
        outcome: "succeeded",
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
      evidenceResponse: {
        stock: stockEvidence,
        vehicle: vehicleResult.result,
      },
      payloadReference: PAYLOAD_REFERENCE,
    });
    expect(JSON.stringify(test.attempted)).not.toContain("ABC1D23");
    expect(JSON.stringify(test.attempted)).not.toContain("00607701676");
  });

  it.each([
    ["ausente", []],
    ["solicitado", [{ ...stockEvidence, estado: "SOLICITADO" as const }]],
    [
      "cancelado",
      [{ ...stockEvidence, cancelamentoEstoque: { motivo: "cancelado" } }],
    ],
    ["ambíguo", [stockEvidence, { ...stockEvidence, id: 8 }]],
  ])("oculta veículo quando o estoque é %s", async (_label, evidence) => {
    const test = harness({
      stock: {
        result: {
          evidence,
          publicResult: evidence.map((record) => ({
            estado: record.estado,
            id: record.id,
            placa: record.placa,
          })),
        },
        verifiedIdentity: identity,
      },
    });

    await expect(test.service.execute(input)).rejects.toMatchObject({
      code: "VEHICLE_NOT_AVAILABLE",
    });
    expect(test.getVehicleByPlate).not.toHaveBeenCalled();
    expect(test.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "VEHICLE_NOT_AVAILABLE" }),
    );
  });

  it.each([404, 422])(
    "uniformiza HTTP %i como indisponível",
    async (status) => {
      const test = harness({
        vehicleError: new RenaveHttpError(status, "get-vehicle-by-plate"),
      });
      await expect(test.service.execute(input)).rejects.toMatchObject({
        code: "VEHICLE_NOT_AVAILABLE",
      });
    },
  );

  it("preserva falha técnica sem retry e finaliza a rejeição", async () => {
    const error = new RenaveHttpError(503, "get-vehicle-by-plate");
    const test = harness({ vehicleError: error });

    await expect(test.service.execute(input)).rejects.toBe(error);
    expect(test.getStocksByPlate).toHaveBeenCalledOnce();
    expect(test.getVehicleByPlate).toHaveBeenCalledOnce();
    expect(test.fail).toHaveBeenCalledOnce();
    expect(test.succeed).not.toHaveBeenCalled();
  });

  it("recusa identidade divergente antes da segunda consulta", async () => {
    const test = harness({
      stock: {
        ...stockResult,
        verifiedIdentity: { ...identity, tenantId: "outro-tenant" },
      },
    });
    await expect(test.service.execute(input)).rejects.toMatchObject({
      code: "VEHICLE_LOOKUP_VERIFIED_IDENTITY_MISMATCH",
    });
    expect(test.getVehicleByPlate).not.toHaveBeenCalled();
  });

  it("reconstrói DTO e rejeita campos de tipo incompatível", async () => {
    const test = harness({
      vehicle: {
        result: {
          ...(vehicleResult.result as object),
          chassi: { segredo: true },
        } as unknown as RenaveVehicle,
        verifiedIdentity: identity,
      },
    });
    await expect(test.service.execute(input)).rejects.toMatchObject({
      code: "RENAVE_VEHICLE_LOOKUP_RESULT_INVALID",
    });
  });
});
