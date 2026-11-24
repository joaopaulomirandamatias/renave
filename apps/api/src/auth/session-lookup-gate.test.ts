import { describe, expect, it } from "vitest";

import {
  LocalSessionLookupGate,
  SessionLookupGateInputError,
} from "./session-lookup-gate.js";

describe("LocalSessionLookupGate", () => {
  it("recusa acima do limite e devolve capacidade ao liberar", () => {
    const gate = new LocalSessionLookupGate(1);
    const release = gate.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(gate.tryAcquire()).toBeUndefined();
    release?.();
    release?.();
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });

  it.each([0, 1.5, 65])("recusa limite inválido %s", (value) => {
    expect(() => new LocalSessionLookupGate(value)).toThrow(
      SessionLookupGateInputError,
    );
  });
});
