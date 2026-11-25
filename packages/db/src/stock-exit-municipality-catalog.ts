import type { TenantClient } from "./tenant-context.js";

export class StockExitMunicipalityCatalogUnavailableError extends Error {
  override name = "StockExitMunicipalityCatalogUnavailableError";
  readonly code = "STOCK_EXIT_MUNICIPALITY_CATALOG_UNAVAILABLE";

  constructor() {
    super("Catálogo municipal do RENAVE indisponível.");
  }
}

export class PostgresStockExitMunicipalityCatalog {
  async contains(client: TenantClient, code: number): Promise<boolean> {
    if (!Number.isSafeInteger(code) || code <= 0 || code > 2_147_483_647) {
      return false;
    }

    try {
      const { rows } = await client.query<{
        state: string;
        present: boolean | null;
        release_version: string | null;
      }>(
        `select state, present, release_version
           from renave_stock_exit_barriers.lookup_municipality($1::integer)`,
        [code],
      );
      const row = rows[0];
      if (
        rows.length === 1 &&
        row?.state === "READY" &&
        typeof row.release_version === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.release_version) &&
        typeof row.present === "boolean"
      ) {
        return row.present;
      }
    } catch {
      // O driver pode incluir detalhes da conexão na mensagem.
    }
    throw new StockExitMunicipalityCatalogUnavailableError();
  }
}
