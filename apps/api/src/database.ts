import { readFile } from "node:fs/promises";

import { createPool } from "@seu-renave/db/api-runtime";
import type { Pool } from "pg";

export interface RuntimePoolOptions {
  applicationName: "seu-renave-api-business" | "seu-renave-api-identity";
  ca?: string;
  caFile: string | undefined;
  connectionString: string;
  max: number;
}

/**
 * Cria um pool com timeouts finitos. Em conexão remota o config já exige CA;
 * aqui ela é injetada diretamente, sem parâmetros TLS controlados pela URL.
 */
export async function createRuntimePool(
  options: RuntimePoolOptions,
): Promise<Pool> {
  if (options.ca !== undefined && options.caFile !== undefined) {
    throw new Error("A CA do banco possui fontes concorrentes");
  }
  const ca =
    options.ca ??
    (options.caFile
      ? await readFile(options.caFile, { encoding: "utf8" })
      : undefined);
  return createPool(options.connectionString, {
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    lock_timeout: 5_000,
    max: options.max,
    query_timeout: 17_000,
    statement_timeout: 15_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
}
