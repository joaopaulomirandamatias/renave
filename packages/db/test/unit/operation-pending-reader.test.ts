import { describe, expect, it, vi } from "vitest";

import {
  getPendingOperationDetail,
  listPendingOperations,
  OperationPendingReaderStorageError,
} from "../../src/operation-pending-reader.js";
import type { TenantClient } from "../../src/tenant-context.js";

const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_EXIT_ID = "44444444-4444-4444-8444-444444444444";
const CORRELATION_ID = "55555555-5555-4555-8555-555555555555";

function baseRow(kind: string, operationId = OPERATION_ENTRY_ID) {
  return {
    correlation_id: CORRELATION_ID,
    created_at: new Date("2026-11-24T13:00:00.000Z"),
    kind,
    operation_id: operationId,
    reason_code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
    sent_at: new Date("2026-11-24T13:01:00.000Z"),
    status: "PENDING_RECONCILIATION",
    updated_at: new Date("2026-11-24T13:02:00.000Z"),
  };
}

describe("operation-pending-reader (multi-tipo read-only)", () => {
  it("aceita USED_STOCK_ENTRY e USED_STOCK_EXIT em listPendingOperations", async () => {
    const query = vi.fn(async () => ({
      rows: [
        baseRow("USED_STOCK_ENTRY", OPERATION_ENTRY_ID),
        baseRow("USED_STOCK_EXIT", OPERATION_EXIT_ID),
      ],
    }));

    const page = await listPendingOperations(
      { query } as unknown as TenantClient,
      { establishmentId: ESTABLISHMENT_ID, limit: 10 },
    );

    expect(page.truncated).toBe(false);
    expect(page.items.map((item) => item.kind)).toEqual([
      "USED_STOCK_ENTRY",
      "USED_STOCK_EXIT",
    ]);
  });

  it("aceita USED_STOCK_EXIT em getPendingOperationDetail", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("get_operation_detail")) {
        return {
          rows: [
            {
              ...baseRow("USED_STOCK_EXIT", OPERATION_EXIT_ID),
              finalized_at: null,
              remote_record_id: "42",
              remote_state: "FINALIZADO",
              version: "1",
            },
          ],
        };
      }
      return {
        rows: [
          {
            changed_at: new Date("2026-11-24T13:02:00.000Z"),
            previous_status: null,
            reason_code: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
            status: "PENDING_RECONCILIATION",
            version: "1",
          },
        ],
      };
    });

    const detail = await getPendingOperationDetail(
      { query } as unknown as TenantClient,
      { establishmentId: ESTABLISHMENT_ID, operationId: OPERATION_EXIT_ID },
    );

    expect(detail?.operation.kind).toBe("USED_STOCK_EXIT");
    expect(detail?.operation.remoteRecordId).toBe(42);
  });

  it("recusa kind desconhecido com OperationPendingReaderStorageError (fail-closed)", async () => {
    const listClient = {
      query: vi.fn(async () => ({
        rows: [baseRow("UNSUPPORTED_KIND")],
      })),
    } as unknown as TenantClient;
    await expect(
      listPendingOperations(listClient, {
        establishmentId: ESTABLISHMENT_ID,
        limit: 10,
      }),
    ).rejects.toThrow(OperationPendingReaderStorageError);

    const detailClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            ...baseRow("UNSUPPORTED_KIND"),
            finalized_at: null,
            remote_record_id: null,
            remote_state: null,
            version: "1",
          },
        ],
      })),
    } as unknown as TenantClient;
    await expect(
      getPendingOperationDetail(detailClient, {
        establishmentId: ESTABLISHMENT_ID,
        operationId: OPERATION_ENTRY_ID,
      }),
    ).rejects.toThrow(OperationPendingReaderStorageError);
  });
});
