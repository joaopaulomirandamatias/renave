export interface WebFeatures {
  readonly platformConsoleEnabled: boolean;
  readonly stockEntryOperationsEnabled: boolean;
  readonly stockExitOperationsEnabled: boolean;
}

/**
 * Feature flags regulatórias são fail-closed: somente o valor canônico
 * `true`, injetado no build, habilita a apresentação do fluxo local.
 */
export function loadWebFeatures(
  environment: Readonly<Record<string, unknown>>,
): WebFeatures {
  return Object.freeze({
    platformConsoleEnabled:
      environment.VITE_PLATFORM_CONSOLE_ENABLED === "true",
    stockEntryOperationsEnabled:
      environment.VITE_RENAVE_STOCK_ENTRY_LOCAL_ENABLED === "true",
    stockExitOperationsEnabled:
      environment.VITE_RENAVE_STOCK_EXIT_LOCAL_ENABLED === "true",
  });
}
