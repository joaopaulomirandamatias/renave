import type {
  ReconciliationLoggerPort,
  ReconciliationWorkerEvent,
} from "@seu-renave/renave-reconciliation-worker";

export interface JsonLogSink {
  write(line: string): void;
}

/** Logger fechado: IDs de tenant/operação e dados remotos nunca entram no JSON. */
export class SanitizedWorkerLogger implements ReconciliationLoggerPort {
  readonly #write: (line: string) => void;

  constructor(sink: JsonLogSink = process.stdout) {
    const write = sink.write;
    if (typeof write !== "function") throw new TypeError("Logger inválido");
    this.#write = write.bind(sink);
    Object.freeze(this);
  }

  write(event: ReconciliationWorkerEvent): void {
    this.#write(
      `${JSON.stringify({
        attemptCount: event.attemptCount,
        component: "renave-reconciliation-worker",
        event: event.event,
      })}\n`,
    );
  }

  lifecycle(
    event:
      | "disabled"
      | "dry_run_ready"
      | "failed"
      | "preflight_failed"
      | "started"
      | "stopped",
  ) {
    this.#write(
      `${JSON.stringify({
        component: "renave-reconciliation-worker",
        event,
      })}\n`,
    );
  }
}
