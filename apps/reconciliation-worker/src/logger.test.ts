import { describe, expect, it } from "vitest";

import { SanitizedWorkerLogger } from "./logger.js";

describe("logger sanitizado", () => {
  it("não serializa IDs de tenant/operação", () => {
    const lines: string[] = [];
    const logger = new SanitizedWorkerLogger({
      write: (line) => lines.push(line),
    });
    logger.write({
      attemptCount: 3,
      event: "confirmed",
      operationId: "operation-sentinel",
      tenantId: "tenant-sentinel",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("operation-sentinel");
    expect(lines[0]).not.toContain("tenant-sentinel");
    expect(JSON.parse(lines[0]!)).toEqual({
      attemptCount: 3,
      component: "renave-reconciliation-worker",
      event: "confirmed",
    });
  });
});
