export interface WebFeatures {
  readonly stockEntryOperationsEnabled: boolean;
}

/**
 * Feature flags regulatórias são fail-closed: somente o valor canônico
 * `true`, injetado no build, habilita a apresentação do fluxo local.
 */
export function loadWebFeatures(
  environment: Readonly<Record<string, unknown>>,
): WebFeatures {
  return Object.freeze({
    stockEntryOperationsEnabled:
      environment.VITE_RENAVE_STOCK_ENTRY_LOCAL_ENABLED === "true",
  });
}
