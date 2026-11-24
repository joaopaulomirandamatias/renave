import { describe, expect, it, vi } from "vitest";

import { runReconciliationLoop } from "./loop.js";

describe("loop operacional", () => {
  it("não chama claim quando falta chave e revalida cobertura em cada ciclo", async () => {
    const stop = new AbortController();
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const runCycle = vi.fn(async () => stop.abort());
    const readiness = { ready: true };
    await runReconciliationLoop({
      preflight: check,
      pollIntervalMs: 0,
      readiness,
      signal: stop.signal,
      worker: { runCycle } as never,
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(readiness.ready).toBe(false);
  });

  it("executa ciclos em série, sem overlap", async () => {
    const stop = new AbortController();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const runCycle = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      calls += 1;
      if (calls === 3) stop.abort();
    });
    await runReconciliationLoop({
      preflight: async () => true,
      pollIntervalMs: 0,
      readiness: { ready: false },
      signal: stop.signal,
      worker: { runCycle } as never,
    });
    expect(runCycle).toHaveBeenCalledTimes(3);
    expect(maximum).toBe(1);
  });

  it("mantém fail-closed sob erro persistente sem executar claim", async () => {
    const stop = new AbortController();
    const check = vi.fn(async () => {
      if (check.mock.calls.length === 3) stop.abort();
      throw new Error("raw database secret");
    });
    const runCycle = vi.fn();
    const readiness = { ready: true };
    await runReconciliationLoop({
      preflight: check,
      pollIntervalMs: 1,
      readiness,
      signal: stop.signal,
      worker: { runCycle } as never,
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(runCycle).not.toHaveBeenCalled();
    expect(readiness.ready).toBe(false);
  });

  it("degrada readiness quando a corrida encontra chave indisponível", async () => {
    const stop = new AbortController();
    const readiness = { ready: false };
    await runReconciliationLoop({
      preflight: async () => true,
      pollIntervalMs: 0,
      readiness,
      signal: stop.signal,
      worker: {
        runCycle: vi.fn(async () => {
          stop.abort();
          return {
            claimed: 1,
            confirmed: 0,
            keyUnavailable: 1,
            manualReview: 0,
            released: 1,
          };
        }),
      } as never,
    });
    expect(readiness.ready).toBe(false);
  });
});
