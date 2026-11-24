export class SessionLookupGateInputError extends Error {
  override name = "SessionLookupGateInputError";
}

/**
 * Limita apenas consultas concorrentes ao store de sessão desta réplica.
 *
 * O gate é intencionalmente local: ele protege o pool pertencente à própria
 * réplica sem criar uma consulta adicional ao PostgreSQL para decidir se outra
 * consulta ao mesmo PostgreSQL pode começar.
 */
export class LocalSessionLookupGate {
  private active = 0;

  constructor(readonly maxConcurrency: number) {
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 64
    ) {
      throw new SessionLookupGateInputError(
        "A concorrência de consulta de sessão deve estar entre 1 e 64.",
      );
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maxConcurrency) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
