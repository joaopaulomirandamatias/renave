import { describe, expect, it } from "vitest";

import { loadWebFeatures } from "./config.js";

describe("web feature configuration", () => {
  it("mantém a entrada local desligada quando a flag está ausente", () => {
    expect(loadWebFeatures({}).stockEntryOperationsEnabled).toBe(false);
  });

  it("habilita a entrada local somente com true canônico", () => {
    expect(
      loadWebFeatures({ VITE_RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "true" })
        .stockEntryOperationsEnabled,
    ).toBe(true);
  });

  it.each(["false", "TRUE", " true ", "1", "", true, null])(
    "falha fechado para o valor inválido %j",
    (value) => {
      expect(
        loadWebFeatures({
          VITE_RENAVE_STOCK_ENTRY_LOCAL_ENABLED: value,
        }).stockEntryOperationsEnabled,
      ).toBe(false);
    },
  );
});
