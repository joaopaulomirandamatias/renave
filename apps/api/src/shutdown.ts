import type { FastifyInstance } from "fastify";

export interface ApiProcessPort {
  exitCode: string | number | null | undefined;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  readonly stderr: { write(value: string): unknown };
}

export function installApiGracefulShutdown(
  app: Pick<FastifyInstance, "close">,
  processPort: ApiProcessPort = process,
): () => void {
  let stopping = false;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    processPort.off("SIGINT", shutdown);
    processPort.off("SIGTERM", shutdown);
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void app
      .close()
      .catch(() => {
        processPort.stderr.write(
          '{"component":"seu-renave-api","event":"shutdown_failed"}\n',
        );
        processPort.exitCode = 1;
      })
      .finally(remove);
  };
  processPort.once("SIGINT", shutdown);
  processPort.once("SIGTERM", shutdown);
  return remove;
}
