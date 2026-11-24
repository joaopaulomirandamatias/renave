import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { startLoopbackHealthServer } from "./health.js";

describe("health local", () => {
  it("escuta apenas no loopback e separa liveness de readiness", async () => {
    const state = { ready: false };
    const health = await startLoopbackHealthServer(0, state);
    try {
      const address = health.server.address() as AddressInfo;
      expect(address.address).toBe("127.0.0.1");
      await expect(
        fetch(`http://127.0.0.1:${address.port}/health`).then(
          (response) => response.status,
        ),
      ).resolves.toBe(200);
      await expect(
        fetch(`http://127.0.0.1:${address.port}/ready`).then(
          (response) => response.status,
        ),
      ).resolves.toBe(503);
      state.ready = true;
      await expect(
        fetch(`http://127.0.0.1:${address.port}/ready`).then(
          (response) => response.status,
        ),
      ).resolves.toBe(200);
      const head = await fetch(`http://127.0.0.1:${address.port}/health`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await fetch(`http://127.0.0.1:${address.port}/health`, {
        method: "POST",
      });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      await health.close();
    }
  });

  it("não abre socket quando já abortado", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(
      startLoopbackHealthServer(0, { ready: false }, stop.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
