import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  encryptOperationReconciliationProjection,
  OperationReconciliationProjectionCipher,
  prepareOperationReconciliationProjection,
} from "@seu-renave/protected-evidence";
import { prepareRenaveMutation } from "@seu-renave/renave-connector";
import type { Pool } from "pg";

import type { EnabledWorkerConfig } from "./config.js";
import { createOperationalRuntime } from "./runtime.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const OUTBOX_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_OWNER = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";
const CORRELATION_ID = "77777777-7777-4777-8777-777777777777";
const OLD_KEY = Buffer.alloc(32, 0x31);
const ACTIVE_KEY = Buffer.alloc(32, 0x32);
const LIMITER_KEY = Buffer.alloc(32, 0x33);

function enabled(
  overrides: Partial<EnabledWorkerConfig> = {},
): EnabledWorkerConfig {
  return {
    activeProjectionKeyId: "projection-k2",
    appEnvironment: "homologation",
    databaseTlsCa: undefined,
    databaseUrl: "postgres://worker:redacted@127.0.0.1/renave",
    dryRun: false,
    healthPort: 9464,
    heartbeatIntervalMs: 30_000,
    integratorCnpj: "69418503000188",
    leaseOwner: LEASE_OWNER,
    limiterHmacKeyBase64: LIMITER_KEY.toString("base64"),
    mode: "enabled",
    mtlsCa: "ca",
    mtlsCertificate: "certificate",
    mtlsKey: "private-key",
    mtlsKeyPassphrase: undefined,
    pollIntervalMs: 5_000,
    projectionKeysBase64: [
      { keyBase64: OLD_KEY.toString("base64"), keyId: "projection-k1" },
      { keyBase64: ACTIVE_KEY.toString("base64"), keyId: "projection-k2" },
    ],
    tenantAllowlist: [TENANT_ID],
    ...overrides,
  };
}

function hmac(domain: string, values: readonly string[]): Buffer {
  const digest = createHmac("sha256", LIMITER_KEY).update(domain, "utf8");
  for (const value of values) digest.update("\0", "utf8").update(value, "utf8");
  return digest.digest();
}

async function oldEnvelope() {
  const request = await prepareRenaveMutation("request-stock-entry", {
    cpfOperadorResponsavel: "123.456.789-01",
    dataCompra: "2026-11-24",
    emailEstabelecimento: "estabelecimento@example.test",
    emailVendedor: "vendedor@example.test",
    valorCompra: 100,
    veiculo: {
      codigoSegurancaCrv: "12345678901",
      dataHoraMedicaoHodometro: "2026-11-24T09:00:00-03:00",
      documentoProprietarioAtual: "00000000000",
      placa: "QTP4H82",
      quilometragemHodometro: 1,
      renavam: "10987654321",
      tipoCrv: "DIGITAL",
      tipoDocumentoProprietarioAtual: "CPF",
    },
  });
  const projection = prepareOperationReconciliationProjection(request);
  const cipher = new OperationReconciliationProjectionCipher({
    activeKeyId: "projection-k1",
    environment: "homologation",
    masterKeys: new Map([["projection-k1", OLD_KEY]]),
  });
  try {
    const binding = {
      environment: "homologation" as const,
      establishmentId: ESTABLISHMENT_ID,
      generation: 1,
      kind: "USED_STOCK_ENTRY" as const,
      mutationFamily: "STOCK_ENTRY" as const,
      operationId: OPERATION_ID,
      requestSchemaVersion: 1,
      sourceRequestSha256: request.requestSha256,
      tenantId: TENANT_ID,
    };
    return {
      binding,
      envelope: encryptOperationReconciliationProjection(
        cipher,
        projection,
        binding,
      ),
    };
  } finally {
    cipher.destroy();
    projection.destroy();
  }
}

function safeRole() {
  return {
    current_user: "renave_operation_worker",
    has_database_connect: true,
    has_database_create: false,
    has_database_ownership: false,
    has_database_temporary: false,
    has_protected_object_ownership: false,
    has_set_role: false,
    rolbypassrls: false,
    rolcanlogin: true,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolsuper: false,
    session_user: "renave_operation_worker",
  };
}

class FakePool extends EventEmitter {
  readonly directQueries: { sql: string; values: readonly unknown[] }[] = [];
  readonly transactionQueries: { sql: string; values: readonly unknown[] }[] =
    [];
  claimed = false;
  ended = false;

  constructor(readonly row: Awaited<ReturnType<typeof oldEnvelope>>) {
    super();
  }

  async query(sql: string, values: readonly unknown[] = []) {
    this.directQueries.push({
      sql,
      values: values.map((value) =>
        Buffer.isBuffer(value) ? Buffer.from(value) : value,
      ),
    });
    if (sql.includes("from pg_catalog.pg_roles roles")) {
      return { rows: [safeRole()] };
    }
    if (sql.includes("operation_worker_contract_ready")) {
      return { rows: [{ ready: true }] };
    }
    if (sql.includes("acquire_serpro_query_permit")) {
      return {
        rows: [{ allowed: true, limited_scope: null, retry_after_seconds: 0 }],
      };
    }
    if (sql.includes("release_serpro_query_permit")) {
      return { rows: [{ released: true }] };
    }
    throw new Error("consulta direta inesperada");
  }

  async connect() {
    return {
      query: async (sql: string, values: readonly unknown[] = []) => {
        this.transactionQueries.push({ sql, values });
        if (
          sql === "begin" ||
          sql === "commit" ||
          sql === "rollback" ||
          sql.includes("set_config")
        ) {
          return { rows: [] };
        }
        const envelope = this.row.envelope;
        const common = {
          establishment_id: ESTABLISHMENT_ID,
          kind: "USED_STOCK_ENTRY",
          mutation_family: "STOCK_ENTRY",
          operation_id: OPERATION_ID,
          projection_auth_tag: Buffer.from(envelope.authTag),
          projection_ciphertext: Buffer.from(envelope.ciphertext),
          projection_generation: "1",
          projection_key_id: envelope.keyId,
          projection_kind: envelope.projectionKind,
          projection_nonce: Buffer.from(envelope.nonce),
          projection_schema_version: envelope.projectionSchemaVersion,
          projection_size: envelope.projectionByteLength,
          request_schema_version: 1,
          source_request_sha256: Buffer.from(
            this.row.binding.sourceRequestSha256,
            "hex",
          ),
        };
        if (sql.includes("preflight_pending_operation")) {
          return { rows: [common] };
        }
        if (sql.includes("claim_operation_reconciliation_leases")) {
          if (this.claimed) return { rows: [] };
          this.claimed = true;
          return {
            rows: [
              {
                attempt_count: 1,
                lease_expires_at: new Date(Date.now() + 300_000),
                lease_token: LEASE_TOKEN,
                operation_id: OPERATION_ID,
                operation_version: "3",
                outbox_id: OUTBOX_ID,
              },
            ],
          };
        }
        if (sql.includes("begin_operation_reconciliation")) {
          return {
            rows: [
              {
                ...common,
                attempt_count: 1,
                correlation_id: CORRELATION_ID,
                establishment_cnpj: "11222333000181",
                lease_expires_at: new Date(Date.now() + 300_000),
                operation_version: "3",
                outbox_id: OUTBOX_ID,
                sent_at: new Date(Date.now() - 10_000),
              },
            ],
          };
        }
        if (sql.includes("complete_operation_reconciliation_confirmed")) {
          return {
            rows: [
              {
                completed_at: new Date(),
                operation_id: OPERATION_ID,
                operation_version: "4",
                reconcile_outbox_id: OUTBOX_ID,
              },
            ],
          };
        }
        if (sql.includes("renew_operation_reconciliation_lease")) {
          return { rows: [{ value: true }] };
        }
        throw new Error("consulta transacional inesperada");
      },
      release: vi.fn(),
    };
  }

  async end() {
    this.ended = true;
  }
}

describe("composição operacional", () => {
  it("valida papel/certificado a cada ciclo, decripta envelope antigo e usa somente GET", async () => {
    const row = await oldEnvelope();
    const pool = new FakePool(row);
    const requests: { init: RequestInit; url: string }[] = [];
    const certificate = vi.fn(() => true);
    const closeMtls = vi.fn();
    const runtime = await createOperationalRuntime(
      enabled(),
      new AbortController().signal,
      {
        createPool: async () => pool as unknown as Pool,
        readMtlsMaterial: async () => ({ ca: "ca", cert: "cert", key: "key" }),
        createMtlsClient: () => ({
          close: closeMtls,
          getCertificateTemporalStatus: () => "healthy",
          isCertificateValidAt: certificate,
          request: async (url, init) => {
            requests.push({ init, url });
            if (url.endsWith("/api/cliente-autenticado")) {
              return new Response(
                JSON.stringify({
                  cnpj: "11222333000181",
                  cnpjIntegradora: "69418503000188",
                }),
              );
            }
            return new Response(
              JSON.stringify([
                {
                  codigoSegurancaCrv: "12345678901",
                  entradaEstoque: {
                    cpfOperadorResponsavel: "12345678901",
                    dataHoraRegistro: new Date(
                      Date.now() - 5_000,
                    ).toISOString(),
                  },
                  estado: "CONFIRMADO",
                  id: 7,
                  placa: "QTP4H82",
                  renavam: "10987654321",
                  tipoCrv: "DIGITAL",
                },
              ]),
            );
          },
        }),
      },
    );
    try {
      await expect(
        runtime.preflight(new AbortController().signal),
      ).resolves.toBe(true);
      await expect(
        runtime.preflight(new AbortController().signal),
      ).resolves.toBe(true);
      await expect(runtime.worker.runCycle()).resolves.toMatchObject({
        claimed: 1,
        confirmed: 1,
      });
      expect(certificate).toHaveBeenCalledTimes(2);
      expect(
        pool.directQueries.filter(({ sql }) =>
          sql.includes("from pg_catalog.pg_roles roles"),
        ),
      ).toHaveLength(3);
      expect(requests).toHaveLength(2);
      expect(
        requests.every(
          ({ init, url }) =>
            init.method === "GET" &&
            init.body === undefined &&
            url.startsWith("https://hom.renave.estaleiro.serpro.gov.br/") &&
            !url.includes("solicitacoes-entrada-estoque"),
        ),
      ).toBe(true);
      const acquire = pool.directQueries.find(({ sql }) =>
        sql.includes("acquire_serpro_query_permit"),
      );
      expect(acquire?.values[2]).toEqual(
        hmac("serpro-query-actor-v1", [
          "renave-reconciliation-worker-v1",
          TENANT_ID,
          ESTABLISHMENT_ID,
        ]),
      );
    } finally {
      await runtime.close();
    }
    expect(closeMtls).toHaveBeenCalledOnce();
    expect(pool.ended).toBe(true);
  });

  it("degrada após erro idle do pool e revalida validade temporal do certificado", async () => {
    const pool = new FakePool(await oldEnvelope());
    let valid = true;
    const runtime = await createOperationalRuntime(
      enabled(),
      new AbortController().signal,
      {
        createPool: async () => pool as unknown as Pool,
        readMtlsMaterial: async () => ({ ca: "ca", cert: "cert", key: "key" }),
        createMtlsClient: () => ({
          close: vi.fn(),
          getCertificateTemporalStatus: () => "healthy",
          isCertificateValidAt: () => valid,
          request: vi.fn(),
        }),
      },
    );
    expect(await runtime.preflight(new AbortController().signal)).toBe(true);
    valid = false;
    expect(await runtime.preflight(new AbortController().signal)).toBe(false);
    valid = true;
    pool.emit("error", new Error("postgres://secret"));
    expect(await runtime.preflight(new AbortController().signal)).toBe(false);
    expect(pool.listenerCount("error")).toBe(1);
    await runtime.close();
    expect(pool.listenerCount("error")).toBe(0);
  });

  it("recusa reutilizar a chave HMAC como master de projeção antes de compor recursos", async () => {
    const createPool = vi.fn();
    await expect(
      createOperationalRuntime(
        enabled({
          limiterHmacKeyBase64: OLD_KEY.toString("base64"),
        }),
        new AbortController().signal,
        {
          createPool,
          createMtlsClient: vi.fn() as never,
          readMtlsMaterial: vi.fn() as never,
        },
      ),
    ).rejects.toThrow("Material criptográfico inválido");
    expect(createPool).not.toHaveBeenCalled();
  });
});
