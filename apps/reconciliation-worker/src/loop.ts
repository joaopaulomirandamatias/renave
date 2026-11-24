import type { ReconciliationWorker } from "@seu-renave/renave-reconciliation-worker";

export interface ReconciliationLoopInput {
  preflight(signal: AbortSignal): Promise<boolean>;
  pollIntervalMs: number;
  readiness: { ready: boolean };
  signal: AbortSignal;
  worker: ReconciliationWorker;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timeout: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Loop estritamente serial: cobertura precede cada ciclo e nunca há overlap. */
export async function runReconciliationLoop(
  input: ReconciliationLoopInput,
): Promise<void> {
  while (!input.signal.aborted) {
    let ready = false;
    try {
      ready = await input.preflight(input.signal);
    } catch {
      ready = false;
    }
    input.readiness.ready = ready && !input.signal.aborted;
    if (ready && !input.signal.aborted) {
      try {
        const summary = await input.worker.runCycle(input.signal);
        if (summary.keyUnavailable > 0) input.readiness.ready = false;
      } catch {
        input.readiness.ready = false;
      }
    }
    if (!input.signal.aborted) {
      await sleep(input.pollIntervalMs, input.signal);
    }
  }
  input.readiness.ready = false;
}
