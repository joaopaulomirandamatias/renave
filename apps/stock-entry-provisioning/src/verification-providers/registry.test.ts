import { describe, expect, it } from "vitest";

import { verificationProviders } from "./registry.js";

describe("registro de provedores de verificação", () => {
  it("nasce vazio e falha fechado", () => {
    expect(verificationProviders.list()).toEqual([]);
    expect(() => verificationProviders.get("any")).toThrowError(
      expect.objectContaining({ code: "PROFILE_VERIFICATION_UNAVAILABLE" }),
    );
  });
});
