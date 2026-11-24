import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runReconciliationWorkerMain } from "./entrypoint.js";
import type { ReconciliationWorkerAppConfig } from "./config.js";

function processPort() {
  const events = new EventEmitter();
  const writes: string[] = [];
  return {
    port: {
      env: {},
      exitCode: undefined as string | number | null | undefined,
      off: events.off.bind(events),
      once: events.once.bind(events),
      stderr: { write: (value: string) => writes.push(value) },
    },
    events,
    writes,
  };
}

describe("entrypoint", () => {
  it("propaga SIGTERM como abort e remove listeners ao sair", async () => {
    const target = processPort();
    const runApp = vi.fn(
      async (_config: { mode: "disabled" }, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    const running = runReconciliationWorkerMain({
      loadConfig: () => ({ mode: "disabled" }),
      process: target.port,
      runApp,
    });
    target.events.emit("SIGTERM");
    await running;
    expect(runApp.mock.calls[0]?.[1].aborted).toBe(true);
    expect(target.events.listenerCount("SIGINT")).toBe(0);
    expect(target.events.listenerCount("SIGTERM")).toBe(0);
    expect(target.port.exitCode).toBeUndefined();
  });

  it("falha com saída sanitizada e exitCode 1", async () => {
    const target = processPort();
    await runReconciliationWorkerMain({
      loadConfig: () => {
        throw new Error("postgres://secret@host/cpf=12345678901");
      },
      process: target.port,
      runApp: vi.fn(),
    });
    expect(target.port.exitCode).toBe(1);
    expect(target.writes).toEqual([
      '{"component":"renave-reconciliation-worker","event":"failed"}\n',
    ]);
  });

  it("encerra limpo quando startup abortado por sinal rejeita", async () => {
    const target = processPort();
    const runApp = vi.fn(
      async (_config: ReconciliationWorkerAppConfig, signal: AbortSignal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          ),
        );
      },
    );
    const running = runReconciliationWorkerMain({
      loadConfig: () => ({ mode: "disabled" }),
      process: target.port,
      runApp,
    });
    target.events.emit("SIGTERM");
    await running;
    expect(target.writes).toEqual([]);
    expect(target.port.exitCode).toBeUndefined();
  });
});
