import type { IdentityService } from "@seu-renave/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { TenantActionRunner } from "../auth/request-access-guard.js";
import { loadConfig } from "../config.js";
import type {
  OperationPendingReader,
  PendingOperationDetailProjection,
  PendingOperationSummaryProjection,
} from "./operation-pending-routes.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const SESSION = {
  expiresAt: Date.now() + 60_000,
  mfaVerified: false,
  roles: ["idp-role-must-not-authorize"],
  subject: "oidc|tenant-user",
};
const apps: ReturnType<typeof buildApp>[] = [];

const summary: PendingOperationSummaryProjection = {
  correlationId: "44444444-4444-4444-8444-444444444444",
  createdAt: new Date("2026-11-24T13:00:00.000Z"),
  kind: "USED_STOCK_ENTRY",
  operationId: OPERATION_ID,
  reasonCode: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
  sentAt: new Date("2026-11-24T13:01:00.000Z"),
  status: "PENDING_RECONCILIATION",
  updatedAt: new Date("2026-11-24T13:02:00.000Z"),
};

const detail: PendingOperationDetailProjection = {
  operation: {
    ...summary,
    finalizedAt: null,
    remoteRecordId: null,
    remoteState: null,
    version: "4",
  },
  timeline: [
    {
      changedAt: new Date("2026-11-24T13:00:00.000Z"),
      previousStatus: null,
      reasonCode: "CREATED",
      status: "PENDING_SEND",
      version: "1",
    },
    {
      changedAt: new Date("2026-11-24T13:02:00.000Z"),
      previousStatus: "SENT",
      reasonCode: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
      status: "PENDING_RECONCILIATION",
      version: "4",
    },
  ],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function readerWith(
  overrides: Partial<OperationPendingReader> = {},
): OperationPendingReader {
  return {
    get: vi.fn(async () => detail),
    list: vi.fn(async () => ({ items: [summary], truncated: false })),
    ...overrides,
  };
}

function setup(
  options: {
    authenticated?: boolean;
    reader?: OperationPendingReader;
    runner?: "allowed" | "denied" | "missing";
  } = {},
) {
  const getSession = vi.fn(async () =>
    options.authenticated === false ? undefined : SESSION,
  );
  const identity = {
    config: { publicOrigin: "https://app.test" },
    getSession,
  } as unknown as IdentityService;
  const run = vi.fn(
    async (input: unknown, work: (context: unknown) => unknown) => {
      if (options.runner === "denied") {
        return { allowed: false as const, reason: "ACCESS_DENIED" as const };
      }
      return {
        allowed: true as const,
        value: await work({ authorization: {}, client: {}, session: SESSION }),
      };
    },
  );
  const reader = options.reader ?? readerWith();
  const app = buildApp({
    config: loadConfig(),
    identity,
    logger: false,
    operationPendingReader: reader,
    ...(options.runner === "missing"
      ? {}
      : {
          tenantActionRunner: { run } as unknown as TenantActionRunner,
        }),
  });
  apps.push(app);
  return { app, getSession, reader, run };
}

function listUrl(suffix = "") {
  return `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/pending-operations${suffix}`;
}

function detailUrl(operationId = OPERATION_ID, suffix = "") {
  return `/api/tenants/${TENANT_ID}/establishments/${ESTABLISHMENT_ID}/operations/${operationId}${suffix}`;
}

const cookie = { cookie: "renave_session=opaque-session" };

describe("fila tenant-scoped de operações pendentes", () => {
  it("lista somente a projeção pública e executa leitura no runner autorizado", async () => {
    const tainted = {
      ...summary,
      actorSubjectHash: "actor-secret",
      idempotencyKeyDigest: "idempotency-secret",
      outboxId: "outbox-secret",
      requestCiphertext: "cipher-secret",
      tenantId: "tenant-secret",
    } as PendingOperationSummaryProjection;
    const reader = readerWith({
      list: vi.fn(async () => ({ items: [tainted], truncated: true })),
    });
    const { app, run } = setup({ reader });

    const response = await app.inject({
      headers: cookie,
      method: "GET",
      url: listUrl("?limit=20"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        {
          correlationId: "44444444-4444-4444-8444-444444444444",
          createdAt: "2026-11-24T13:00:00.000Z",
          kind: "USED_STOCK_ENTRY",
          operationId: OPERATION_ID,
          reasonCode: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
          sentAt: "2026-11-24T13:01:00.000Z",
          status: "PENDING_RECONCILIATION",
          updatedAt: "2026-11-24T13:02:00.000Z",
        },
      ],
      truncated: true,
    });
    expect(run).toHaveBeenCalledWith(
      {
        action: "renave.operation.read",
        establishmentId: ESTABLISHMENT_ID,
        session: SESSION,
        tenantId: TENANT_ID,
      },
      expect.any(Function),
    );
    expect(reader.list).toHaveBeenCalledWith(
      {},
      { establishmentId: ESTABLISHMENT_ID, limit: 20 },
    );
    for (const forbidden of [
      "actor-secret",
      "cipher-secret",
      "idempotency-secret",
      "outbox-secret",
      "tenant-secret",
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("retorna detalhe e timeline sem propagar campos técnicos extras", async () => {
    const taintedDetail = {
      operation: {
        ...detail.operation,
        leaseToken: "lease-secret",
        requestSha256: "hash-secret",
      },
      timeline: detail.timeline.map((item) => ({
        ...item,
        actorHash: "actor-secret",
      })),
    } as PendingOperationDetailProjection;
    const reader = readerWith({ get: vi.fn(async () => taintedDetail) });
    const { app } = setup({ reader });

    const response = await app.inject({
      headers: cookie,
      method: "GET",
      url: detailUrl(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operation: {
        correlationId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-11-24T13:00:00.000Z",
        finalizedAt: null,
        kind: "USED_STOCK_ENTRY",
        operationId: OPERATION_ID,
        reasonCode: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
        remoteRecordId: null,
        remoteState: null,
        sentAt: "2026-11-24T13:01:00.000Z",
        status: "PENDING_RECONCILIATION",
        updatedAt: "2026-11-24T13:02:00.000Z",
        version: "4",
      },
      timeline: [
        {
          changedAt: "2026-11-24T13:00:00.000Z",
          previousStatus: null,
          reasonCode: "CREATED",
          status: "PENDING_SEND",
          version: "1",
        },
        {
          changedAt: "2026-11-24T13:02:00.000Z",
          previousStatus: "SENT",
          reasonCode: "RENAVE_MUTATION_OUTCOME_UNKNOWN",
          status: "PENDING_RECONCILIATION",
          version: "4",
        },
      ],
    });
    expect(reader.get).toHaveBeenCalledWith(
      {},
      { establishmentId: ESTABLISHMENT_ID, operationId: OPERATION_ID },
    );
    expect(response.body).not.toContain("lease-secret");
    expect(response.body).not.toContain("hash-secret");
    expect(response.body).not.toContain("actor-secret");
  });

  it("substitui códigos técnicos desconhecidos por ausência de motivo público", async () => {
    const reader = readerWith({
      get: vi.fn(async () => ({
        operation: {
          ...detail.operation,
          reasonCode: "DATABASE_INTERNAL_FAILURE",
        },
        timeline: [
          {
            ...detail.timeline[0]!,
            reasonCode: "PRIVATE_CONNECTOR_DIAGNOSTIC",
          },
        ],
      })),
      list: vi.fn(async () => ({
        items: [{ ...summary, reasonCode: "DATABASE_INTERNAL_FAILURE" }],
        truncated: false,
      })),
    });
    const { app } = setup({ reader });

    const [list, operation] = await Promise.all([
      app.inject({ headers: cookie, method: "GET", url: listUrl() }),
      app.inject({ headers: cookie, method: "GET", url: detailUrl() }),
    ]);

    expect(list.json()).toMatchObject({ items: [{ reasonCode: null }] });
    expect(operation.json()).toMatchObject({
      operation: { reasonCode: null },
      timeline: [{ reasonCode: null }],
    });
    expect(reader.list).toHaveBeenCalledWith(
      {},
      { establishmentId: ESTABLISHMENT_ID, limit: 50 },
    );
    expect(list.body).not.toContain("DATABASE_INTERNAL_FAILURE");
    expect(operation.body).not.toContain("PRIVATE_CONNECTOR_DIAGNOSTIC");
  });

  it("autentica antes de consultar o runner ou o reader", async () => {
    const { app, reader, run } = setup({ authenticated: false });
    const response = await app.inject({ method: "GET", url: listUrl() });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(run).not.toHaveBeenCalled();
    expect(reader.list).not.toHaveBeenCalled();
  });

  it("não distingue BOLA, operação ausente e identificador inválido", async () => {
    const denied = setup({ runner: "denied" });
    const deniedResponse = await denied.app.inject({
      headers: cookie,
      method: "GET",
      url: detailUrl(),
    });
    expect(deniedResponse.statusCode).toBe(404);
    expect(deniedResponse.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });
    expect(denied.reader.get).not.toHaveBeenCalled();

    const missingReader = readerWith({ get: vi.fn(async () => null) });
    const missing = setup({ reader: missingReader });
    const missingResponse = await missing.app.inject({
      headers: cookie,
      method: "GET",
      url: detailUrl(),
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });

    const malformed = setup();
    const malformedResponse = await malformed.app.inject({
      headers: cookie,
      method: "GET",
      url: detailUrl("not-a-uuid"),
    });
    expect(malformedResponse.statusCode).toBe(404);
    expect(malformedResponse.json()).toEqual({
      code: "TENANT_RESOURCE_NOT_FOUND",
    });
    expect(malformed.run).not.toHaveBeenCalled();
  });

  it("aceita somente limit inteiro entre 1 e 50 e rejeita filtros extras", async () => {
    for (const suffix of [
      "?limit=0",
      "?limit=51",
      "?limit=1.5",
      "?limit=01",
      "?status=MANUAL_REVIEW",
      "?limit=10&cursor=secret",
    ]) {
      const { app, reader, run } = setup();
      const response = await app.inject({
        headers: cookie,
        method: "GET",
        url: listUrl(suffix),
      });
      expect(response.statusCode, suffix).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
      expect(run).not.toHaveBeenCalled();
      expect(reader.list).not.toHaveBeenCalled();
    }
  });

  it("rejeita query no detalhe e falha fechado sem composição", async () => {
    const withQuery = setup();
    const invalid = await withQuery.app.inject({
      headers: cookie,
      method: "GET",
      url: detailUrl(OPERATION_ID, "?include=payload"),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(withQuery.run).not.toHaveBeenCalled();

    const unavailable = setup({ runner: "missing" });
    const missing = await unavailable.app.inject({
      headers: cookie,
      method: "GET",
      url: listUrl(),
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toEqual({ code: "OPERATION_READER_UNAVAILABLE" });
    expect(unavailable.reader.list).not.toHaveBeenCalled();
  });

  it("não revela falha interna do reader", async () => {
    const reader = readerWith({
      list: vi.fn(async () => {
        throw new Error("postgres://secret@private-db/ciphertext");
      }),
    });
    const { app } = setup({ reader });
    const response = await app.inject({
      headers: cookie,
      method: "GET",
      url: listUrl(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "OPERATION_READER_UNAVAILABLE",
    });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("private-db");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("projeta tanto USED_STOCK_ENTRY quanto USED_STOCK_EXIT na fila e no detalhe", async () => {
    const exitOperationId = "55555555-5555-4555-8555-555555555555";
    const exitSummary: PendingOperationSummaryProjection = {
      ...summary,
      kind: "USED_STOCK_EXIT",
      operationId: exitOperationId,
      status: "MANUAL_REVIEW",
      reasonCode: "RENAVE_RECONCILIATION_AMBIGUOUS",
    };
    const exitDetail: PendingOperationDetailProjection = {
      ...detail,
      operation: {
        ...detail.operation,
        kind: "USED_STOCK_EXIT",
        operationId: exitOperationId,
        status: "MANUAL_REVIEW",
        reasonCode: "RENAVE_RECONCILIATION_AMBIGUOUS",
      },
    };
    const reader = readerWith({
      get: vi.fn(async () => exitDetail),
      list: vi.fn(async () => ({
        items: [summary, exitSummary],
        truncated: false,
      })),
    });
    const { app } = setup({ reader });

    const [listRes, detailRes] = await Promise.all([
      app.inject({ headers: cookie, method: "GET", url: listUrl() }),
      app.inject({
        headers: cookie,
        method: "GET",
        url: detailUrl(exitOperationId),
      }),
    ]);

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject({
      items: [
        { kind: "USED_STOCK_ENTRY", operationId: OPERATION_ID },
        { kind: "USED_STOCK_EXIT", operationId: exitOperationId },
      ],
      truncated: false,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json()).toMatchObject({
      operation: {
        kind: "USED_STOCK_EXIT",
        operationId: exitOperationId,
        reasonCode: "RENAVE_RECONCILIATION_AMBIGUOUS",
        status: "MANUAL_REVIEW",
      },
    });
  });

  it("falha fechado (503) quando o reader devolve kind desconhecido", async () => {
    const unknownKind =
      "UNKNOWN_MUTATION" as PendingOperationSummaryProjection["kind"];
    const reader = readerWith({
      get: vi.fn(async () => ({
        ...detail,
        operation: { ...detail.operation, kind: unknownKind },
      })),
      list: vi.fn(async () => ({
        items: [{ ...summary, kind: unknownKind }],
        truncated: false,
      })),
    });
    const { app } = setup({ reader });

    const [listRes, detailRes] = await Promise.all([
      app.inject({ headers: cookie, method: "GET", url: listUrl() }),
      app.inject({ headers: cookie, method: "GET", url: detailUrl() }),
    ]);

    expect(listRes.statusCode).toBe(503);
    expect(listRes.json()).toMatchObject({
      code: "OPERATION_READER_UNAVAILABLE",
    });
    expect(listRes.body).not.toContain("UNKNOWN_MUTATION");

    expect(detailRes.statusCode).toBe(503);
    expect(detailRes.json()).toMatchObject({
      code: "OPERATION_READER_UNAVAILABLE",
    });
    expect(detailRes.body).not.toContain("UNKNOWN_MUTATION");
  });
});
