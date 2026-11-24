import { request } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 3_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export type ApiHealthProbeTarget = "health" | "readiness";

function portFrom(env: NodeJS.ProcessEnv): number | null {
  const raw = env.PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/u.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export async function probeApiLoopback(
  target: ApiHealthProbeTarget,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (
    (target !== "health" && target !== "readiness") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const probe = request(
      {
        headers: { accept: "application/json" },
        host: "127.0.0.1",
        method: "GET",
        path: `/${target}`,
        port,
      },
      (response) => {
        const accepted = response.statusCode === 200;
        response.resume();
        response.once("end", () => finish(accepted));
        response.once("error", () => finish(false));
      },
    );
    probe.once("error", () => finish(false));
    probe.setTimeout(timeoutMs, () => {
      probe.destroy();
      finish(false);
    });
    probe.end();
  });
}

export async function runApiHealthProbe(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  if (args.length !== 1 || (args[0] !== "health" && args[0] !== "readiness")) {
    return 1;
  }
  const port = portFrom(env);
  if (port === null) return 1;
  return (await probeApiLoopback(args[0], port, timeoutMs)) ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runApiHealthProbe(process.argv.slice(2));
}
