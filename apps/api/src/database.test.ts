import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPool, readFile } = vi.hoisted(() => ({
  createPool: vi.fn(() => ({ kind: "pool" })),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("@seu-renave/db/api-runtime", () => ({ createPool }));

import { createRuntimePool } from "./database.js";

describe("pool da API", () => {
  beforeEach(() => {
    createPool.mockClear();
    readFile.mockReset();
  });

  it("usa CA já carregada sem reler path arbitrário", async () => {
    await createRuntimePool({
      applicationName: "seu-renave-api-business",
      ca: "trusted-ca",
      caFile: undefined,
      connectionString: "postgres://app@db/renave",
      max: 4,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(createPool).toHaveBeenCalledWith(
      "postgres://app@db/renave",
      expect.objectContaining({
        ssl: { ca: "trusted-ca", rejectUnauthorized: true },
      }),
    );
  });

  it("recusa fontes concorrentes de CA antes de qualquer leitura", async () => {
    await expect(
      createRuntimePool({
        applicationName: "seu-renave-api-identity",
        ca: "trusted-ca",
        caFile: "/must/not/be/read",
        connectionString: "postgres://identity@db/identity",
        max: 4,
      }),
    ).rejects.toThrow("fontes concorrentes");
    expect(readFile).not.toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();
  });
});
