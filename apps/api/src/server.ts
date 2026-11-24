import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  createCertificateExpiryMonitor,
  type CertificateExpiryEvent,
} from "./renave/certificate-expiry-monitor.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = buildApp({
  config,
  ...(runtime.identity ? { identity: runtime.identity } : {}),
  ...(runtime.loginRateLimiter
    ? { loginRateLimiter: runtime.loginRateLimiter }
    : {}),
  ...(runtime.sessionLookupGate
    ? { sessionLookupGate: runtime.sessionLookupGate }
    : {}),
  ...(runtime.serproQueryLimiter
    ? { serproQueryLimiter: runtime.serproQueryLimiter }
    : {}),
  ...(runtime.eligibility ? { eligibility: runtime.eligibility } : {}),
  ...(runtime.linkStatus ? { linkStatus: runtime.linkStatus } : {}),
  ...(runtime.preflight ? { preflight: runtime.preflight } : {}),
  ...(runtime.renaveReadiness
    ? { renaveReadiness: runtime.renaveReadiness }
    : {}),
  ...(runtime.stockQuery ? { stockQuery: runtime.stockQuery } : {}),
  ...(runtime.stockEntryMutationRateLimiter
    ? {
        stockEntryMutationRateLimiter: runtime.stockEntryMutationRateLimiter,
      }
    : {}),
  ...(runtime.stockEntryOperation
    ? { stockEntryOperation: runtime.stockEntryOperation }
    : {}),
  ...(runtime.tenantDirectory
    ? { tenantDirectory: runtime.tenantDirectory }
    : {}),
  ...(runtime.tenantActionRunner
    ? { tenantActionRunner: runtime.tenantActionRunner }
    : {}),
  ...(runtime.tenantEstablishmentAdministration
    ? {
        tenantEstablishmentAdministration:
          runtime.tenantEstablishmentAdministration,
      }
    : {}),
  ...(runtime.tenantMutationRateLimiter
    ? { tenantMutationRateLimiter: runtime.tenantMutationRateLimiter }
    : {}),
  ready: runtime.ready,
});

function logCertificateEvent(event: CertificateExpiryEvent): void {
  const { level, ...payload } = event;
  app.log[level](payload);
}

const certificateMonitor = runtime.certificateTemporalStatus
  ? createCertificateExpiryMonitor({
      emit: logCertificateEvent,
      readStatus: runtime.certificateTemporalStatus,
    })
  : undefined;
let stopCertificateMonitor: (() => void) | undefined;
app.addHook("onClose", async () => {
  stopCertificateMonitor?.();
  await runtime.close();
});

try {
  await app.listen({ host: config.host, port: config.port });
  stopCertificateMonitor = certificateMonitor?.start();
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
