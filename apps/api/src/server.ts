import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
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
  ...(runtime.tenantDirectory
    ? { tenantDirectory: runtime.tenantDirectory }
    : {}),
  ready: runtime.ready,
});
app.addHook("onClose", async () => runtime.close());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
