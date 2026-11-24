import type { ReconciliationWorkerAppConfig } from "./config.js";
import { startLoopbackHealthServer } from "./health.js";
import { SanitizedWorkerLogger } from "./logger.js";
import { runReconciliationLoop } from "./loop.js";
import {
  createOperationalRuntime,
  type OperationalRuntime,
} from "./runtime.js";

export interface ReconciliationWorkerAppDependencies {
  createRuntime: typeof createOperationalRuntime;
  logger: SanitizedWorkerLogger;
  startHealth: typeof startLoopbackHealthServer;
}

const defaults: ReconciliationWorkerAppDependencies = {
  createRuntime: createOperationalRuntime,
  logger: new SanitizedWorkerLogger(),
  startHealth: startLoopbackHealthServer,
};

function lifecycle(
  logger: SanitizedWorkerLogger,
  event: Parameters<SanitizedWorkerLogger["lifecycle"]>[0],
): void {
  try {
    logger.lifecycle(event);
  } catch {
    // Logging é best-effort e nunca impede cleanup ou shutdown.
  }
}

export async function runReconciliationWorkerApp(
  config: ReconciliationWorkerAppConfig,
  signal: AbortSignal,
  dependencies: ReconciliationWorkerAppDependencies = defaults,
): Promise<void> {
  if (config.mode === "disabled") {
    lifecycle(dependencies.logger, "disabled");
    return;
  }
  let runtime: OperationalRuntime | undefined;
  try {
    runtime = await dependencies.createRuntime(config, signal);
    if (signal.aborted) return;
    if (config.dryRun) {
      if (!(await runtime.preflight(signal))) {
        lifecycle(dependencies.logger, "preflight_failed");
        throw new Error("Cobertura de chaves indisponível");
      }
      if (!signal.aborted) lifecycle(dependencies.logger, "dry_run_ready");
      return;
    }
    if (signal.aborted) return;
    const readiness = { ready: false };
    const health = await dependencies.startHealth(
      config.healthPort,
      readiness,
      signal,
    );
    try {
      if (signal.aborted) return;
      lifecycle(dependencies.logger, "started");
      await runReconciliationLoop({
        preflight: runtime.preflight,
        pollIntervalMs: config.pollIntervalMs,
        readiness,
        signal,
        worker: runtime.worker,
      });
    } finally {
      await health.close();
    }
  } finally {
    try {
      await runtime?.close();
    } finally {
      if (runtime && !config.dryRun) {
        lifecycle(dependencies.logger, "stopped");
      }
    }
  }
}
