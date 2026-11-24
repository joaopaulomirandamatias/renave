import { describe, expect, it, vi } from "vitest";

import { installApiGracefulShutdown, type ApiProcessPort } from "./shutdown.js";

function fakeProcess() {
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const writes: string[] = [];
  const processPort: ApiProcessPort = {
    exitCode: undefined,
    off: vi.fn((event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    once: vi.fn((event, listener) => {
      listeners.set(event, listener);
    }),
    stderr: { write: (value) => writes.push(value) },
  };
  return { listeners, processPort, writes };
}

describe("encerramento gracioso da API", () => {
  it("fecha Fastify uma vez e remove os handlers de sinal", async () => {
    const process = fakeProcess();
    const close = vi.fn(async () => undefined);
    installApiGracefulShutdown({ close } as never, process.processPort);

    process.listeners.get("SIGTERM")?.();
    process.listeners.get("SIGINT")?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(process.listeners.size).toBe(0));
    expect(process.processPort.exitCode).toBeUndefined();
    expect(process.writes).toEqual([]);
  });

  it("falha fechado e não imprime o erro de shutdown", async () => {
    const process = fakeProcess();
    const secret = "postgres://user:password@database/internal";
    const close = vi.fn(async () => {
      throw new Error(secret);
    });
    installApiGracefulShutdown({ close } as never, process.processPort);

    process.listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(process.processPort.exitCode).toBe(1));
    expect(process.writes.join("")).toBe(
      '{"component":"seu-renave-api","event":"shutdown_failed"}\n',
    );
    expect(process.writes.join("")).not.toContain(secret);
    expect(process.listeners.size).toBe(0);
  });

  it("permite remover handlers antes de qualquer sinal", () => {
    const process = fakeProcess();
    const remove = installApiGracefulShutdown(
      { close: vi.fn() } as never,
      process.processPort,
    );
    remove();
    remove();
    expect(process.listeners.size).toBe(0);
  });
});
