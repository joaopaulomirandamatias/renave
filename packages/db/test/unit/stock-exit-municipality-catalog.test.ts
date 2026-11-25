import { expect, it, vi } from "vitest";
import {
  PostgresStockExitMunicipalityCatalog,
  StockExitMunicipalityCatalogUnavailableError,
} from "../../src/api-runtime.js";
import type { TenantClient } from "../../src/tenant-context.js";

const catalog = new PostgresStockExitMunicipalityCatalog();

it("recusa códigos fora do intervalo int32 positivo antes de consultar", async () => {
  const query = vi.fn();
  const client = { query } as unknown as TenantClient;
  for (const invalid of [0, -1, 1.3, NaN, Infinity, 2_147_483_648]) {
    await expect(catalog.contains(client, invalid)).resolves.toBe(false);
  }
  expect(query).not.toHaveBeenCalled();
});

it("consulta somente o lookup vigente da saída", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [{ state: "READY", present: true, release_version: "fixture" }],
  });
  await expect(
    catalog.contains({ query } as unknown as TenantClient, 1_501_402),
  ).resolves.toBe(true);
  expect(String(query.mock.calls[0]?.[0])).toContain(
    "renave_stock_exit_barriers.lookup_municipality",
  );
  expect(String(query.mock.calls[0]?.[0])).not.toContain(
    "renave_reference.lookup_municipality",
  );
});

it("distingue ausência na release de indisponibilidade e de resposta inválida", async () => {
  const query = vi.fn();
  const client = { query } as unknown as TenantClient;
  for (const present of [true, false]) {
    query.mockResolvedValueOnce({
      rows: [{ state: "READY", present, release_version: "fixture" }],
    });
    await expect(catalog.contains(client, 2_147_483_647)).resolves.toBe(
      present,
    );
  }
  for (const rows of [
    [],
    [{ state: "UNAVAILABLE", present: false, release_version: null }],
    [{ state: "READY", present: null, release_version: "fixture" }],
    [{ state: "READY", present: false, release_version: null }],
    [{ state: "READY", present: true, release_version: " " }],
    [{ state: "INVALID", present: true, release_version: "fixture" }],
    Array(2).fill({
      state: "READY",
      present: true,
      release_version: "fixture",
    }),
  ]) {
    query.mockResolvedValueOnce({ rows });
    await expect(catalog.contains(client, 1)).rejects.toBeInstanceOf(
      StockExitMunicipalityCatalogUnavailableError,
    );
  }
  query.mockRejectedValueOnce(new Error("detalhe confidencial do driver"));
  await expect(catalog.contains(client, 1)).rejects.toMatchObject({
    message: "Catálogo municipal do RENAVE indisponível.",
    code: "STOCK_EXIT_MUNICIPALITY_CATALOG_UNAVAILABLE",
  });
});
