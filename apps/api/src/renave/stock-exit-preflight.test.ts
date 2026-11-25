import { describe, expect, it, vi } from "vitest";

import {
  RateLimitedStockExitPreflight,
  StockExitPreflightLimitedError,
  StockExitPreflightUnavailableError,
  type StockExitPreflightQueryLimiter,
  type StockExitPreflightQueryUseCase,
} from "./stock-exit-preflight.js";

const input = {
  actorIp: "198.51.100.10",
  establishmentId: "7e7577ea-131b-48cb-8437-ce779f609417",
  stockId: 71,
  subject: "oidc|operador-1",
  tenantId: "5b13742c-4c89-4658-83f7-c247540f178c",
  traceId: "trace-exit-preflight",
  vehicle: {
    codigoSegurancaCrv: "01234567890",
    numeroCrv: "001234567890",
    placa: "ABC1D23",
    renavam: "00987654321",
  },
};

function harness(options?: {
  acquireError?: Error;
  authorizeError?: Error;
  decision?: Awaited<ReturnType<StockExitPreflightQueryLimiter["acquire"]>>;
  executeError?: Error;
  releaseError?: Error;
}) {
  const order: string[] = [];
  const authorize = vi.fn(async () => {
    order.push("authorize");
    if (options?.authorizeError) throw options.authorizeError;
  });
  const release = vi.fn(async () => {
    order.push("release");
    if (options?.releaseError) throw options.releaseError;
  });
  const acquire = vi.fn(async () => {
    order.push("acquire");
    if (options?.acquireError) throw options.acquireError;
    return options?.decision ?? { allowed: true as const, permit: { release } };
  });
  const executeStockExitPreflight = vi.fn(async () => {
    order.push("execute");
    if (options?.executeError) throw options.executeError;
    return { remoteStockId: input.stockId };
  });
  const onPermitReleaseFailure = vi.fn(async () => undefined);
  const preflight = new RateLimitedStockExitPreflight({
    onPermitReleaseFailure,
    queryLimiter: { acquire },
    stockQuery: {
      authorize,
      executeStockExitPreflight,
    } as StockExitPreflightQueryUseCase,
  });
  return {
    acquire,
    authorize,
    executeStockExitPreflight,
    onPermitReleaseFailure,
    order,
    preflight,
    release,
  };
}

describe("RateLimitedStockExitPreflight", () => {
  it("autoriza, limita, reautoriza na consulta e libera o permit", async () => {
    const test = harness();

    await expect(test.preflight.verify(input)).resolves.toEqual({
      remoteStockId: 71,
    });
    expect(test.order).toEqual(["authorize", "acquire", "execute", "release"]);
    expect(test.acquire).toHaveBeenCalledWith({
      establishmentId: input.establishmentId,
      subject: input.subject,
      tenantId: input.tenantId,
    });
    expect(test.executeStockExitPreflight).toHaveBeenCalledWith(input);
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("libera o permit preservando rejeição ou falha da consulta", async () => {
    for (const error of [
      Object.assign(new Error("rejeitado"), {
        code: "STOCK_EXIT_PREFLIGHT_REJECTED",
      }),
      Object.assign(new Error("timeout"), { code: "RENAVE_HTTP_ERROR" }),
    ]) {
      const test = harness({ executeError: error });

      await expect(test.preflight.verify(input)).rejects.toBe(error);
      expect(test.release).toHaveBeenCalledOnce();
    }
  });

  it("nega limite sem chamar a consulta ou liberar permit inexistente", async () => {
    const test = harness({
      decision: {
        allowed: false,
        retryAfterSeconds: 9,
        scope: "operator-establishment",
      },
    });

    await expect(test.preflight.verify(input)).rejects.toEqual(
      new StockExitPreflightLimitedError(9),
    );
    expect(test.executeStockExitPreflight).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
  });

  it("falha fechado quando o limitador falha ou devolve retry inválido", async () => {
    const failed = harness({ acquireError: new Error("detalhe interno") });
    await expect(failed.preflight.verify(input)).rejects.toBeInstanceOf(
      StockExitPreflightUnavailableError,
    );

    const invalid = harness({
      decision: { allowed: false, retryAfterSeconds: 0, scope: "global" },
    });
    await expect(invalid.preflight.verify(input)).rejects.toBeInstanceOf(
      StockExitPreflightUnavailableError,
    );

    const unsafe = harness({
      decision: {
        allowed: false,
        retryAfterSeconds: Number.MAX_SAFE_INTEGER + 1,
        scope: "global",
      },
    });
    await expect(unsafe.preflight.verify(input)).rejects.toBeInstanceOf(
      StockExitPreflightUnavailableError,
    );
  });

  it("nega autorização antes do limite e não mascara falha de release", async () => {
    const authorization = new Error("negado");
    const denied = harness({ authorizeError: authorization });
    await expect(denied.preflight.verify(input)).rejects.toBe(authorization);
    expect(denied.acquire).not.toHaveBeenCalled();

    const releaseFailure = harness({
      releaseError: new Error("detalhe do lease"),
    });
    await expect(releaseFailure.preflight.verify(input)).resolves.toEqual({
      remoteStockId: 71,
    });
    expect(releaseFailure.onPermitReleaseFailure).toHaveBeenCalledWith({
      traceId: input.traceId,
    });
  });
});
