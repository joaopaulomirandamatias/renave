import { createServer, type Server } from "node:http";

export interface HealthState {
  ready: boolean;
}

export async function startLoopbackHealthServer(
  port: number,
  state: HealthState,
  signal?: AbortSignal,
): Promise<{ close(): Promise<void>; server: Server }> {
  if (signal?.aborted)
    throw new DOMException("Operação abortada", "AbortError");
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        allow: "GET, HEAD",
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end('{"status":"method_not_allowed"}');
      return;
    }
    const ready = state.ready;
    const isReadiness = request.url === "/ready";
    const isHealth = request.url === "/health";
    if (!isReadiness && !isHealth) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        request.method === "HEAD" ? undefined : '{"status":"not_found"}',
      );
      return;
    }
    const accepted = isHealth || ready;
    response.writeHead(accepted ? 200 : 503, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(
      request.method === "HEAD"
        ? undefined
        : JSON.stringify({
            status: isHealth ? "alive" : ready ? "ready" : "not_ready",
          }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      server.close();
      reject(new DOMException("Operação abortada", "AbortError"));
    };
    const failed = (error: Error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    server.once("error", failed);
    signal?.addEventListener("abort", abort, { once: true });
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        server.close();
        reject(new DOMException("Operação abortada", "AbortError"));
        return;
      }
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    server,
  };
}
