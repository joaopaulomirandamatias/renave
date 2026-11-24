import { describe, expect, it, vi } from "vitest";

import { runReconciliationWorkerApp } from "./app.js";
import type { EnabledWorkerConfig } from "./config.js";

const enabled = {
  activeProjectionKeyId: "key-1",
  appEnvironment: "homologation",
  databaseTlsCa: undefined,
  databaseUrl: "postgres://redacted@localhost/db",
  dryRun: true,
  healthPort: 9464,
  heartbeatIntervalMs: 30_000,
  integratorCnpj: "11222333000181",
  leaseOwner: "22222222-2222-4222-8222-222222222222",
  limiterHmacKeyBase64: Buffer.alloc(32).toString("base64"),
  mode: "enabled",
  mtlsCa: "ca",
  mtlsCertificate: "certificate",
  mtlsKey: "private-key",
  mtlsKeyPassphrase: undefined,
  pollIntervalMs: 5_000,
  projectionKeysBase64: [
    {
      keyBase64: Buffer.alloc(32).toString("base64"),
      keyId: "key-1",
    },
  ],
  tenantAllowlist: ["11111111-1111-4111-8111-111111111111"],
} satisfies EnabledWorkerConfig;

describe("ativação do app", () => {
  it("disabled não compõe pool, arquivos ou socket", async () => {
    const createRuntime = vi.fn();
    const startHealth = vi.fn();
    await runReconciliationWorkerApp(
      { mode: "disabled" },
      new AbortController().signal,
      {
        createRuntime,
        logger: { lifecycle: vi.fn() } as never,
        startHealth,
      },
    );
    expect(createRuntime).not.toHaveBeenCalled();
    expect(startHealth).not.toHaveBeenCalled();
  });

  it("dry-run atesta cobertura e fecha recursos sem claim, limiter, GET ou socket", async () => {
    const preflight = vi.fn().mockResolvedValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const runCycle = vi.fn();
    const startHealth = vi.fn();
    await runReconciliationWorkerApp(enabled, new AbortController().signal, {
      createRuntime: vi.fn().mockResolvedValue({
        preflight,
        close,
        worker: { runCycle },
      }),
      logger: { lifecycle: vi.fn() } as never,
      startHealth,
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(runCycle).not.toHaveBeenCalled();
    expect(startHealth).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("falha fechado no dry-run corrompido sem abrir health nem executar claim", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const runCycle = vi.fn();
    const lifecycle = vi.fn();
    const startHealth = vi.fn();
    await expect(
      runReconciliationWorkerApp(enabled, new AbortController().signal, {
        createRuntime: vi.fn().mockResolvedValue({
          close,
          preflight: vi.fn().mockResolvedValue(false),
          worker: { runCycle },
        }),
        logger: { lifecycle } as never,
        startHealth,
      }),
    ).rejects.toThrow("Cobertura de chaves indisponível");
    expect(lifecycle).toHaveBeenCalledWith("preflight_failed");
    expect(runCycle).not.toHaveBeenCalled();
    expect(startHealth).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborto após composição fecha runtime sem abrir health", async () => {
    const stop = new AbortController();
    const close = vi.fn().mockResolvedValue(undefined);
    const startHealth = vi.fn();
    await runReconciliationWorkerApp(
      { ...enabled, dryRun: false },
      stop.signal,
      {
        createRuntime: vi.fn(async () => {
          stop.abort();
          return {
            close,
            preflight: vi.fn(),
            worker: { runCycle: vi.fn() },
          } as never;
        }),
        logger: { lifecycle: vi.fn() } as never,
        startHealth,
      },
    );
    expect(startHealth).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("logger com falha nunca impede fechar health e runtime", async () => {
    const stop = new AbortController();
    const closeRuntime = vi.fn().mockResolvedValue(undefined);
    const closeHealth = vi.fn().mockResolvedValue(undefined);
    const runCycle = vi.fn(async () => stop.abort());
    await runReconciliationWorkerApp(
      { ...enabled, dryRun: false, pollIntervalMs: 0 },
      stop.signal,
      {
        createRuntime: vi.fn().mockResolvedValue({
          close: closeRuntime,
          preflight: vi.fn().mockResolvedValue(true),
          worker: { runCycle },
        }),
        logger: {
          lifecycle: vi.fn(() => {
            throw new Error("logger failed");
          }),
        } as never,
        startHealth: vi.fn().mockResolvedValue({
          close: closeHealth,
          server: {},
        }),
      },
    );
    expect(runCycle).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
  });
});
