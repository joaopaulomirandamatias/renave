import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { probeApiLoopback, runApiHealthProbe } from "./health-probe.js";

const servers: Server[] = [];

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number; server: Server }> {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  return { port: (instance.address() as AddressInfo).port, server: instance };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (instance) =>
          new Promise<void>((resolve) => instance.close(() => resolve())),
      ),
  );
});

describe("probe local da API", () => {
  it("consulta somente loopback e diferencia health de readiness", async () => {
    const seen: string[] = [];
    const target = await server((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.writeHead(request.url === "/health" ? 200 : 503);
      response.end("ignored-body");
    });
    await expect(
      runApiHealthProbe(["health"], { PORT: String(target.port) }),
    ).resolves.toBe(0);
    await expect(
      runApiHealthProbe(["readiness"], { PORT: String(target.port) }),
    ).resolves.toBe(1);
    expect(seen).toEqual(["GET /health", "GET /readiness"]);
  });

  it("falha fechado para argumento, porta e destino indisponível", async () => {
    await expect(runApiHealthProbe([], {})).resolves.toBe(1);
    await expect(runApiHealthProbe(["other"], {})).resolves.toBe(1);
    await expect(runApiHealthProbe(["readiness"], { PORT: "0" })).resolves.toBe(
      1,
    );
    await expect(probeApiLoopback("readiness", 65_534, 50)).resolves.toBe(
      false,
    );
  });

  it("encerra no timeout sem imprimir resposta ou erro", async () => {
    const target = await server(() => {
      // Mantém a resposta pendente para exercitar o timeout fechado.
    });
    await expect(probeApiLoopback("readiness", target.port, 20)).resolves.toBe(
      false,
    );
  });
});
