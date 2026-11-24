import { runReconciliationWorkerApp } from "./app.js";
import {
  loadReconciliationWorkerAppConfig,
  type ReconciliationWorkerAppConfig,
} from "./config.js";

export interface ReconciliationWorkerProcessPort {
  readonly env: NodeJS.ProcessEnv;
  exitCode: string | number | null | undefined;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  readonly stderr: { write(value: string): unknown };
}

export interface ReconciliationWorkerMainDependencies {
  loadConfig(env: NodeJS.ProcessEnv): ReconciliationWorkerAppConfig;
  process: ReconciliationWorkerProcessPort;
  runApp(
    config: ReconciliationWorkerAppConfig,
    signal: AbortSignal,
  ): Promise<void>;
}

const defaults: ReconciliationWorkerMainDependencies = {
  loadConfig: loadReconciliationWorkerAppConfig,
  process,
  runApp: runReconciliationWorkerApp,
};

export async function runReconciliationWorkerMain(
  dependencies: ReconciliationWorkerMainDependencies = defaults,
): Promise<void> {
  const stop = new AbortController();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stop.abort();
  };
  dependencies.process.once("SIGINT", shutdown);
  dependencies.process.once("SIGTERM", shutdown);
  try {
    try {
      const config = dependencies.loadConfig(dependencies.process.env);
      await dependencies.runApp(config, stop.signal);
    } catch {
      if (stop.signal.aborted) return;
      dependencies.process.stderr.write(
        '{"component":"renave-reconciliation-worker","event":"failed"}\n',
      );
      dependencies.process.exitCode = 1;
    }
  } finally {
    dependencies.process.off("SIGINT", shutdown);
    dependencies.process.off("SIGTERM", shutdown);
  }
}
