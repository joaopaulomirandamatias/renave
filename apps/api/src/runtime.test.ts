import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  areRuntimeDependenciesReady,
  closeRuntimeResources,
  createRuntimeCleanupCoordinator,
  rollbackRuntimeResources,
} from "./runtime.js";

describe("runtime cleanup", () => {
  it("encerra recursos uma única vez em chamadas concorrentes e deixa pools por último", async () => {
    const cleanup = createRuntimeCleanupCoordinator();
    const events: string[] = [];

    cleanup.registerPool(() => {
      events.push("pool-1");
    });
    cleanup.registerResource(() => {
      events.push("resource-1");
    });
    cleanup.registerPool(async () => {
      events.push("pool-2");
      throw new Error("pool indisponível");
    });
    cleanup.registerResource(() => {
      events.push("resource-2");
      throw new Error("recurso indisponível");
    });

    const first = cleanup.close();
    const second = cleanup.close();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(cleanup.close()).resolves.toBe(true);
    expect(events).toEqual(["resource-2", "resource-1", "pool-1", "pool-2"]);
  });

  it("relata uma falha genérica no shutdown somente depois de tentar tudo", async () => {
    const cleanup = createRuntimeCleanupCoordinator();
    const laterResource = vi.fn();
    const pool = vi.fn();
    cleanup.registerResource(laterResource);
    cleanup.registerResource(() => {
      throw new Error("detalhe interno");
    });
    cleanup.registerPool(pool);

    await expect(closeRuntimeResources(cleanup, true)).rejects.toEqual(
      new Error("Falha ao encerrar runtime"),
    );
    expect(laterResource).toHaveBeenCalledOnce();
    expect(pool).toHaveBeenCalledOnce();
  });

  it("preserva o erro original mesmo quando o cleanup do rollback falha", async () => {
    const cleanup = createRuntimeCleanupCoordinator();
    const original = new Error("falha original");
    cleanup.registerResource(() => {
      throw new Error("falha secundária");
    });

    await expect(rollbackRuntimeResources(cleanup, original)).rejects.toBe(
      original,
    );
  });

  it("mantém todos os recursos sensíveis registrados no lifecycle", () => {
    const source = readFileSync(
      new URL("./runtime.ts", import.meta.url),
      "utf8",
    );

    for (const registration of [
      "cleanup.registerPool(() => pool.end())",
      "cleanup.registerResource(() => loginRateLimiter!.destroy())",
      "cleanup.registerResource(() => serproQueryLimiter!.destroy())",
      "cleanup.registerResource(() => tenantAdminLimiter!.destroy())",
      "cleanup.registerResource(() => tenantAdministration!.destroy())",
      "cleanup.registerResource(() => stockEntryComposition!.destroy())",
      "cleanup.registerResource(() => platformConsole!.destroy())",
      "cleanup.registerResource(() => mtls!.close())",
      "cleanup.registerResource(() => cipher.destroy())",
      "return rollbackRuntimeResources(cleanup, error)",
    ]) {
      expect(source).toContain(registration);
    }
  });
});

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

  it("mantém readiness enquanto o certificado válido está em faixa de aviso", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const isCertificateValidAt = vi.fn(() => true);

    expect(
      areRuntimeDependenciesReady({
        databasesReady: true,
        mtls: { isCertificateValidAt },
        now,
      }),
    ).toBe(true);
    expect(isCertificateValidAt).toHaveBeenCalledWith(now);
  });
});
