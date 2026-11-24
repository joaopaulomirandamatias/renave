import { describe, expect, it, vi } from "vitest";

import { main } from "./main.js";

describe("operation promoter main", () => {
  it("rejeita argumentos sem reproduzir seu conteúdo no log", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(await main(["tenant-secret", "operation-secret"])).toBe(1);
      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("OPERATION_PROMOTER_CONFIG_INVALID");
      expect(output).not.toContain("tenant-secret");
      expect(output).not.toContain("operation-secret");
    } finally {
      write.mockRestore();
    }
  });
});
