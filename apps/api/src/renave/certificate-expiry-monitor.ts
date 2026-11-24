import type { MtlsCertificateTemporalStatus } from "@seu-renave/renave-connector";

type MonitorStatus = MtlsCertificateTemporalStatus | "status_unavailable";
type WarningStatus = Extract<
  MtlsCertificateTemporalStatus,
  `expiring_${string}`
>;

export type CertificateExpiryEvent =
  | {
      event: "renave.mtls_certificate_expiring";
      expiryBand: WarningStatus;
      level: "warn";
    }
  | {
      certificateStatus:
        "expired" | "not_yet_valid" | "invalid_clock" | "status_unavailable";
      event: "renave.mtls_certificate_invalid";
      level: "error";
    }
  | {
      event: "renave.mtls_certificate_recovered";
      level: "info";
    };

const WARNING_RANK = {
  expiring_90d: 1,
  expiring_60d: 2,
  expiring_30d: 3,
  expiring_15d: 4,
  expiring_7d: 5,
  expiring_1d: 6,
} as const satisfies Record<WarningStatus, number>;

function isWarningStatus(status: MonitorStatus): status is WarningStatus {
  return Object.hasOwn(WARNING_RANK, status);
}

export class CertificateExpiryTracker {
  private highestWarningRank = 0;
  private lastStatus: MonitorStatus | undefined;

  observe(status: MonitorStatus): readonly CertificateExpiryEvent[] {
    if (status === "healthy") {
      const recovered =
        this.lastStatus !== undefined && this.lastStatus !== "healthy";
      this.highestWarningRank = 0;
      this.lastStatus = status;
      return recovered
        ? [{ event: "renave.mtls_certificate_recovered", level: "info" }]
        : [];
    }

    if (isWarningStatus(status)) {
      const recoveredFromInvalid =
        this.lastStatus !== undefined &&
        this.lastStatus !== "healthy" &&
        !isWarningStatus(this.lastStatus);
      if (recoveredFromInvalid) this.highestWarningRank = 0;
      const rank = WARNING_RANK[status];
      this.lastStatus = status;
      const events: CertificateExpiryEvent[] = recoveredFromInvalid
        ? [{ event: "renave.mtls_certificate_recovered", level: "info" }]
        : [];
      if (rank <= this.highestWarningRank) return events;
      this.highestWarningRank = rank;
      events.push({
        event: "renave.mtls_certificate_expiring",
        expiryBand: status,
        level: "warn",
      });
      return events;
    }

    if (status === this.lastStatus) return [];
    this.lastStatus = status;
    return [
      {
        certificateStatus: status,
        event: "renave.mtls_certificate_invalid",
        level: "error",
      },
    ];
  }
}

export interface CertificateExpiryMonitor {
  check(): void;
  start(): () => void;
}

export function createCertificateExpiryMonitor(options: {
  emit(event: CertificateExpiryEvent): void;
  intervalMs?: number;
  readStatus(): MtlsCertificateTemporalStatus;
}): CertificateExpiryMonitor {
  const tracker = new CertificateExpiryTracker();
  const intervalMs = options.intervalMs ?? 60 * 60 * 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("Intervalo do monitor mTLS inválido");
  }
  let pendingEvents: CertificateExpiryEvent[] = [];

  const check = () => {
    let status: MonitorStatus;
    try {
      status = options.readStatus();
    } catch {
      status = "status_unavailable";
    }
    pendingEvents.push(...tracker.observe(status));
    let firstPendingIndex = pendingEvents.length;
    for (const [index, event] of pendingEvents.entries()) {
      try {
        options.emit(event);
      } catch {
        firstPendingIndex = index;
        break;
      }
    }
    pendingEvents = pendingEvents.slice(firstPendingIndex);
  };

  return {
    check,
    start() {
      check();
      const timer = setInterval(check, intervalMs);
      timer.unref();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
