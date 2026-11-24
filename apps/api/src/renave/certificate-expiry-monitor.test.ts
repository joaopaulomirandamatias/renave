import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CertificateExpiryTracker,
  createCertificateExpiryMonitor,
  type CertificateExpiryEvent,
} from "./certificate-expiry-monitor.js";

afterEach(() => vi.useRealTimers());

describe("CertificateExpiryTracker", () => {
  it("não alerta saudável e emite uma vez por aumento de urgência", () => {
    const tracker = new CertificateExpiryTracker();
    expect(tracker.observe("healthy")).toEqual([]);
    for (const expiryBand of [
      "expiring_90d",
      "expiring_60d",
      "expiring_30d",
      "expiring_15d",
      "expiring_7d",
      "expiring_1d",
    ] as const) {
      expect(tracker.observe(expiryBand)).toEqual([
        expect.objectContaining({ expiryBand }),
      ]);
      expect(tracker.observe(expiryBand)).toEqual([]);
    }
  });

  it("ignora regressão de relógio e reinicia após recuperação", () => {
    const tracker = new CertificateExpiryTracker();
    expect(tracker.observe("expiring_7d")).toHaveLength(1);
    expect(tracker.observe("expiring_15d")).toEqual([]);
    expect(tracker.observe("healthy")).toEqual([
      { event: "renave.mtls_certificate_recovered", level: "info" },
    ]);
    expect(tracker.observe("healthy")).toEqual([]);
    expect(tracker.observe("expiring_30d")).toHaveLength(1);
  });

  it("emite recuperação e alerta ao voltar de estado inválido", () => {
    const tracker = new CertificateExpiryTracker();
    expect(tracker.observe("expired")).toHaveLength(1);
    expect(tracker.observe("expiring_7d")).toEqual([
      { event: "renave.mtls_certificate_recovered", level: "info" },
      {
        event: "renave.mtls_certificate_expiring",
        expiryBand: "expiring_7d",
        level: "warn",
      },
    ]);
  });

  it("deduplica estados inválidos sem registrar detalhes", () => {
    const tracker = new CertificateExpiryTracker();
    const event = tracker.observe("expired");
    expect(event).toEqual([
      {
        certificateStatus: "expired",
        event: "renave.mtls_certificate_invalid",
        level: "error",
      },
    ]);
    expect(tracker.observe("expired")).toEqual([]);
    expect(JSON.stringify(event)).not.toMatch(
      /BEGIN CERTIFICATE|PRIVATE KEY|cnpj|fingerprint|serial|subject|path/iu,
    );
  });
});

describe("createCertificateExpiryMonitor", () => {
  it("não derruba o processo quando o leitor falha e para o timer uma vez", () => {
    vi.useFakeTimers();
    const events: CertificateExpiryEvent[] = [];
    const monitor = createCertificateExpiryMonitor({
      emit: (event) => events.push(event),
      intervalMs: 1_000,
      readStatus: () => {
        throw new Error("material sensível");
      },
    });

    const stop = monitor.start();
    expect(events).toEqual([
      {
        certificateStatus: "status_unavailable",
        event: "renave.mtls_certificate_invalid",
        level: "error",
      },
    ]);
    vi.advanceTimersByTime(3_000);
    expect(events).toHaveLength(1);
    stop();
    stop();
    vi.advanceTimersByTime(3_000);
    expect(events).toHaveLength(1);
  });

  it("contém falha do emissor e tenta novamente somente o evento pendente", () => {
    vi.useFakeTimers();
    const emit = vi
      .fn<(event: CertificateExpiryEvent) => void>()
      .mockImplementationOnce(() => {
        throw new Error("destino indisponível");
      });
    const monitor = createCertificateExpiryMonitor({
      emit,
      intervalMs: 1_000,
      readStatus: () => "expiring_60d",
    });

    const stop = monitor.start();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    stop();
  });

  it("preserva FIFO quando a recuperação falha antes do alerta vigente", () => {
    const emitted: CertificateExpiryEvent[] = [];
    let status: "expired" | "expiring_7d" = "expired";
    let failRecoveryOnce = true;
    const monitor = createCertificateExpiryMonitor({
      emit: (event) => {
        if (
          event.event === "renave.mtls_certificate_recovered" &&
          failRecoveryOnce
        ) {
          failRecoveryOnce = false;
          throw new Error("destino indisponível");
        }
        emitted.push(event);
      },
      readStatus: () => status,
    });

    monitor.check();
    status = "expiring_7d";
    monitor.check();
    expect(emitted.map(({ event }) => event)).toEqual([
      "renave.mtls_certificate_invalid",
    ]);

    monitor.check();
    expect(emitted.map(({ event }) => event)).toEqual([
      "renave.mtls_certificate_invalid",
      "renave.mtls_certificate_recovered",
      "renave.mtls_certificate_expiring",
    ]);
    monitor.check();
    expect(emitted).toHaveLength(3);
  });
});
