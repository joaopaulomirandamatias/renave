import { describe, expect, it, vi } from "vitest";

import { areRuntimeDependenciesReady } from "./runtime.js";

describe("areRuntimeDependenciesReady", () => {
  it("aceita runtime sem integração quando os bancos estão prontos", () => {
    expect(areRuntimeDependenciesReady({ databasesReady: true })).toBe(true);
  });

  it("recusa banco indisponível mesmo com certificado válido", () => {
    const isCertificateValidAt = vi.fn(() => true);

    expect(
      areRuntimeDependenciesReady({
        databasesReady: false,
        mtls: { isCertificateValidAt },
      }),
    ).toBe(false);
    expect(isCertificateValidAt).not.toHaveBeenCalled();
  });

  it("recusa certificado que expirou durante a execução", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const isCertificateValidAt = vi.fn(() => false);

    expect(
      areRuntimeDependenciesReady({
        databasesReady: true,
        mtls: { isCertificateValidAt },
        now,
      }),
    ).toBe(false);
    expect(isCertificateValidAt).toHaveBeenCalledWith(now);
  });
});
