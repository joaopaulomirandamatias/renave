import { bootstrapRoles } from "./bootstrap.js";
import {
  APP_ROLE,
  ConfigError,
  CREDENTIAL_SCOPE_PROVISIONER_ROLE,
  IDENTITY_APP_ROLE,
  MAINTENANCE_APP_ROLE,
  MIGRATOR_ROLE,
  OPERATION_WORKER_ROLE,
  OPERATION_PROMOTER_ROLE,
  PLATFORM_PROVISIONER_ROLE,
  PLATFORM_READER_ROLE,
  PROFILE_PROVISIONER_ROLE,
  PROFILE_READER_ROLE,
  isLoopbackUrl,
  requireEnv,
  withCredentials,
} from "./config.js";
import { LOCAL_DEFAULTS } from "./local-defaults.js";
import {
  evidenceMonitorNeedsAttention,
  getEvidenceMonitorStatus,
  scanStaleProtectedEvidence,
} from "./evidence-maintenance.js";
import { purgeExpiredIdentityBacklog } from "./identity-maintenance.js";
import { purgeStaleLoginRateBuckets } from "./login-rate-limiter.js";
import { runMigrations } from "./migrate.js";
import {
  grantPlatformOperator,
  revokePlatformOperator,
  type PlatformOperatorIdentity,
} from "./platform-operator-provisioning.js";
import { decodePlatformOperatorHmacKeyBase64 } from "./platform-digests.js";
import { assertRuntimeDatabase } from "./runtime-guard.js";
import { PostgresIdentitySessionStore } from "./session-store.js";
import { createPool } from "./tenant-context.js";

const USAGE = `Uso: pnpm --filter @seu-renave/db cli <comando>

  bootstrap    Cria/atualiza ${MIGRATOR_ROLE}, ${APP_ROLE}, ${CREDENTIAL_SCOPE_PROVISIONER_ROLE}, ${IDENTITY_APP_ROLE}, ${MAINTENANCE_APP_ROLE}, ${OPERATION_WORKER_ROLE}, ${OPERATION_PROMOTER_ROLE}, ${PROFILE_PROVISIONER_ROLE}, ${PROFILE_READER_ROLE}, ${PLATFORM_PROVISIONER_ROLE} e ${PLATFORM_READER_ROLE} (idempotente; rotaciona senhas).
               Requer: DATABASE_ADMIN_URL, RENAVE_DB_MIGRATOR_PASSWORD,
               RENAVE_DB_APP_PASSWORD, RENAVE_DB_IDENTITY_APP_PASSWORD,
               RENAVE_DB_CREDENTIAL_SCOPE_PROVISIONER_PASSWORD,
               RENAVE_DB_MAINTENANCE_APP_PASSWORD,
               RENAVE_DB_OPERATION_WORKER_PASSWORD,
               RENAVE_DB_OPERATION_PROMOTER_PASSWORD,
               RENAVE_DB_PROFILE_PROVISIONER_PASSWORD,
               RENAVE_DB_PROFILE_READER_PASSWORD,
               RENAVE_DB_PLATFORM_PROVISIONER_PASSWORD,
               RENAVE_DB_PLATFORM_READER_PASSWORD
  migrate      Aplica as migrations pendentes como ${MIGRATOR_ROLE}.
               Requer: DATABASE_MIGRATOR_URL
  purge-identity
               Remove sessões/tentativas OIDC expiradas em lotes limitados.
               Requer: IDENTITY_DATABASE_URL
  scan-evidence
               Detecta evidências pendentes acima do SLA e emite JSON.
               Exit 0=saudável, 2=atenção operacional, 1=falha técnica.
               Requer: MAINTENANCE_DATABASE_URL
  status-evidence
               Verifica heartbeat/backlog sem executar uma varredura.
               Exit 0=saudável, 2=atenção operacional, 1=falha técnica.
               Requer: MAINTENANCE_DATABASE_URL
  platform-grant
               Concede acesso global a um operador. Lê uma decisão JSON do
               stdin; não aceita identidades nem tickets na linha de comando.
               Requer: DATABASE_PLATFORM_PROVISIONER_URL,
               PLATFORM_OPERATOR_HMAC_KEY_BASE64
  platform-revoke
               Revoga acesso global. Usa o mesmo formato seguro via stdin.
               Requer: DATABASE_PLATFORM_PROVISIONER_URL,
               PLATFORM_OPERATOR_HMAC_KEY_BASE64
  setup-local  bootstrap + migrate no Postgres local do compose, com valores
               de desenvolvimento NÃO secretos (recusa host fora de loopback).
`;

const EVIDENCE_JOB = "protected-evidence-monitor";
const MAX_PLATFORM_DECISION_BYTES = 16_384;

interface PlatformDecisionDocument {
  actorIp: string;
  changedBy: PlatformOperatorIdentity;
  decisionTicket: string;
  expiresAt?: string;
  target: PlatformOperatorIdentity;
  traceId: string;
  validFrom?: string;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_PLATFORM_DECISION_BYTES) {
      for (const item of chunks) item.fill(0);
      bytes.fill(0);
      throw new ConfigError("A decisão do console global excede o limite.");
    }
    chunks.push(bytes);
  }
  const document = Buffer.concat(chunks).toString("utf8");
  for (const item of chunks) item.fill(0);
  return document;
}

function platformDecisionDocument(value: unknown): PlatformDecisionDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("A decisão do console global é inválida.");
  }
  const item = value as Record<string, unknown>;
  const identity = (candidate: unknown): PlatformOperatorIdentity => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new ConfigError("A decisão do console global é inválida.");
    }
    const fields = candidate as Record<string, unknown>;
    if (
      Object.keys(fields).some(
        (key) => key !== "issuer" && key !== "subject",
      ) ||
      typeof fields.issuer !== "string" ||
      typeof fields.subject !== "string"
    ) {
      throw new ConfigError("A decisão do console global é inválida.");
    }
    return { issuer: fields.issuer, subject: fields.subject };
  };
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "actorIp",
          "changedBy",
          "decisionTicket",
          "expiresAt",
          "target",
          "traceId",
          "validFrom",
        ].includes(key),
    ) ||
    typeof item.actorIp !== "string" ||
    typeof item.decisionTicket !== "string" ||
    typeof item.traceId !== "string" ||
    (item.expiresAt !== undefined && typeof item.expiresAt !== "string") ||
    (item.validFrom !== undefined && typeof item.validFrom !== "string")
  ) {
    throw new ConfigError("A decisão do console global é inválida.");
  }
  return {
    actorIp: item.actorIp,
    changedBy: identity(item.changedBy),
    decisionTicket: item.decisionTicket,
    target: identity(item.target),
    traceId: item.traceId,
    ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    ...(item.validFrom === undefined ? {} : { validFrom: item.validFrom }),
  };
}

function exactIsoDate(value: string | undefined, name: string): Date {
  if (value === undefined) {
    throw new ConfigError(`${name} é obrigatório para concessão.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ConfigError(`${name} deve estar em ISO 8601 UTC canônico.`);
  }
  return parsed;
}

async function runPlatformDecision(command: "grant" | "revoke"): Promise<void> {
  const raw = await readStandardInput();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("A decisão do console global é inválida.");
  }
  const input = platformDecisionDocument(parsed);
  const key = decodePlatformOperatorHmacKeyBase64(
    requireEnv("PLATFORM_OPERATOR_HMAC_KEY_BASE64"),
  );
  const pool = createPool(requireEnv("DATABASE_PLATFORM_PROVISIONER_URL"), {
    max: 1,
  });
  try {
    if (command === "grant") {
      await grantPlatformOperator(pool, key, {
        ...input,
        expiresAt: exactIsoDate(input.expiresAt, "expiresAt"),
        validFrom: exactIsoDate(input.validFrom, "validFrom"),
      });
      console.log("Decisão de concessão registrada.");
    } else {
      const changed = await revokePlatformOperator(pool, key, input);
      console.log(
        changed
          ? "Decisão de revogação registrada."
          : "Revogação registrada; não havia concessão ativa.",
      );
    }
  } finally {
    key.fill(0);
    await pool.end();
  }
}

function positiveIntegerFromEnv(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ConfigError(`${name} deve ser um inteiro entre 1 e ${maximum}.`);
  }
  return value;
}

function writeEvidenceJobResult(
  operation: "scan" | "status",
  startedAt: number,
  payload: Record<string, unknown>,
  needsAttention: boolean,
): void {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      job: EVIDENCE_JOB,
      operation,
      outcome: needsAttention ? "attention" : "healthy",
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ...payload,
    }),
  );
  process.exitCode = needsAttention ? 2 : 0;
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case "bootstrap": {
      await bootstrapRoles({
        adminUrl: requireEnv("DATABASE_ADMIN_URL"),
        migratorPassword: requireEnv("RENAVE_DB_MIGRATOR_PASSWORD"),
        appPassword: requireEnv("RENAVE_DB_APP_PASSWORD"),
        credentialScopeProvisionerPassword: requireEnv(
          "RENAVE_DB_CREDENTIAL_SCOPE_PROVISIONER_PASSWORD",
        ),
        identityAppPassword: requireEnv("RENAVE_DB_IDENTITY_APP_PASSWORD"),
        maintenanceAppPassword: requireEnv(
          "RENAVE_DB_MAINTENANCE_APP_PASSWORD",
        ),
        operationWorkerPassword: requireEnv(
          "RENAVE_DB_OPERATION_WORKER_PASSWORD",
        ),
        operationPromoterPassword: requireEnv(
          "RENAVE_DB_OPERATION_PROMOTER_PASSWORD",
        ),
        profileProvisionerPassword: requireEnv(
          "RENAVE_DB_PROFILE_PROVISIONER_PASSWORD",
        ),
        profileReaderPassword: requireEnv("RENAVE_DB_PROFILE_READER_PASSWORD"),
        platformProvisionerPassword: requireEnv(
          "RENAVE_DB_PLATFORM_PROVISIONER_PASSWORD",
        ),
        platformReaderPassword: requireEnv(
          "RENAVE_DB_PLATFORM_READER_PASSWORD",
        ),
      });
      console.log(
        `Papéis ${MIGRATOR_ROLE}, ${APP_ROLE}, ${CREDENTIAL_SCOPE_PROVISIONER_ROLE}, ${IDENTITY_APP_ROLE}, ${MAINTENANCE_APP_ROLE}, ${OPERATION_WORKER_ROLE}, ${OPERATION_PROMOTER_ROLE}, ${PROFILE_PROVISIONER_ROLE}, ${PROFILE_READER_ROLE}, ${PLATFORM_PROVISIONER_ROLE} e ${PLATFORM_READER_ROLE} prontos.`,
      );
      return;
    }
    case "migrate": {
      const result = await runMigrations(requireEnv("DATABASE_MIGRATOR_URL"));
      console.log(
        result.applied.length > 0
          ? `Aplicadas: ${result.applied.join(", ")}`
          : "Nenhuma migration pendente.",
      );
      return;
    }
    case "purge-identity": {
      const pool = createPool(requireEnv("IDENTITY_DATABASE_URL"), { max: 1 });
      try {
        await assertRuntimeDatabase(pool, { expectedRole: IDENTITY_APP_ROLE });
        const store = new PostgresIdentitySessionStore(pool);
        const result = await purgeExpiredIdentityBacklog(store);
        let rateBucketsDeleted = 0;
        let rateBucketBacklogMayRemain = false;
        for (let batch = 0; batch < 100; batch += 1) {
          const deleted = await purgeStaleLoginRateBuckets(pool);
          rateBucketsDeleted += deleted;
          rateBucketBacklogMayRemain = deleted === 1_000;
          if (!rateBucketBacklogMayRemain) break;
        }
        console.log(
          `Registros OIDC expirados removidos: tentativas=${result.loginAttemptsDeleted}, sessoes=${result.sessionsDeleted}, buckets_rate_limit=${rateBucketsDeleted}, lotes=${result.batches}, backlog_pode_permanecer=${result.backlogMayRemain || rateBucketBacklogMayRemain}.`,
        );
      } finally {
        await pool.end();
      }
      return;
    }
    case "scan-evidence": {
      const startedAt = Date.now();
      const pool = createPool(requireEnv("MAINTENANCE_DATABASE_URL"), {
        max: 1,
      });
      try {
        await assertRuntimeDatabase(pool, {
          expectedRole: MAINTENANCE_APP_ROLE,
        });
        const batchSize = positiveIntegerFromEnv(
          "EVIDENCE_MONITOR_BATCH_SIZE",
          100,
          1000,
        );
        const maxSilenceSeconds = positiveIntegerFromEnv(
          "EVIDENCE_MONITOR_MAX_SILENCE_SECONDS",
          900,
          86_400,
        );
        const scan = await scanStaleProtectedEvidence(pool, batchSize);
        const status = await getEvidenceMonitorStatus(pool, maxSilenceSeconds);
        writeEvidenceJobResult(
          "scan",
          startedAt,
          { batchSize, maxSilenceSeconds, scan, status },
          scan.incidentsCreated > 0 || evidenceMonitorNeedsAttention(status),
        );
      } finally {
        await pool.end();
      }
      return;
    }
    case "status-evidence": {
      const startedAt = Date.now();
      const pool = createPool(requireEnv("MAINTENANCE_DATABASE_URL"), {
        max: 1,
      });
      try {
        await assertRuntimeDatabase(pool, {
          expectedRole: MAINTENANCE_APP_ROLE,
        });
        const maxSilenceSeconds = positiveIntegerFromEnv(
          "EVIDENCE_MONITOR_MAX_SILENCE_SECONDS",
          900,
          86_400,
        );
        const status = await getEvidenceMonitorStatus(pool, maxSilenceSeconds);
        writeEvidenceJobResult(
          "status",
          startedAt,
          { maxSilenceSeconds, status },
          evidenceMonitorNeedsAttention(status),
        );
      } finally {
        await pool.end();
      }
      return;
    }
    case "platform-grant": {
      await runPlatformDecision("grant");
      return;
    }
    case "platform-revoke": {
      await runPlatformDecision("revoke");
      return;
    }
    case "setup-local": {
      const adminUrl =
        process.env["DATABASE_ADMIN_URL"] ?? LOCAL_DEFAULTS.adminUrl;
      if (!isLoopbackUrl(adminUrl)) {
        throw new ConfigError(
          "setup-local só roda contra host loopback; use bootstrap/migrate.",
        );
      }
      await bootstrapRoles({
        adminUrl,
        migratorPassword: LOCAL_DEFAULTS.migratorPassword,
        appPassword: LOCAL_DEFAULTS.appPassword,
        credentialScopeProvisionerPassword:
          LOCAL_DEFAULTS.credentialScopeProvisionerPassword,
        identityAppPassword: LOCAL_DEFAULTS.identityAppPassword,
        maintenanceAppPassword: LOCAL_DEFAULTS.maintenanceAppPassword,
        operationWorkerPassword: LOCAL_DEFAULTS.operationWorkerPassword,
        operationPromoterPassword: LOCAL_DEFAULTS.operationPromoterPassword,
        profileProvisionerPassword: LOCAL_DEFAULTS.profileProvisionerPassword,
        profileReaderPassword: LOCAL_DEFAULTS.profileReaderPassword,
        platformProvisionerPassword: LOCAL_DEFAULTS.platformProvisionerPassword,
        platformReaderPassword: LOCAL_DEFAULTS.platformReaderPassword,
      });
      const migratorUrl = withCredentials(
        adminUrl,
        MIGRATOR_ROLE,
        LOCAL_DEFAULTS.migratorPassword,
      );
      const result = await runMigrations(migratorUrl);
      console.log(
        result.applied.length > 0
          ? `Aplicadas: ${result.applied.join(", ")}`
          : "Nenhuma migration pendente.",
      );
      console.log(
        `DATABASE_URL=${withCredentials(adminUrl, APP_ROLE, LOCAL_DEFAULTS.appPassword)}`,
      );
      console.log(
        `DATABASE_CREDENTIAL_SCOPE_PROVISIONER_URL=${withCredentials(adminUrl, CREDENTIAL_SCOPE_PROVISIONER_ROLE, LOCAL_DEFAULTS.credentialScopeProvisionerPassword)}`,
      );
      console.log(
        `IDENTITY_DATABASE_URL=${withCredentials(adminUrl, IDENTITY_APP_ROLE, LOCAL_DEFAULTS.identityAppPassword)}`,
      );
      console.log(
        `MAINTENANCE_DATABASE_URL=${withCredentials(adminUrl, MAINTENANCE_APP_ROLE, LOCAL_DEFAULTS.maintenanceAppPassword)}`,
      );
      console.log(
        `OPERATION_WORKER_DATABASE_URL=${withCredentials(adminUrl, OPERATION_WORKER_ROLE, LOCAL_DEFAULTS.operationWorkerPassword)}`,
      );
      console.log(
        `DATABASE_OPERATION_PROMOTER_URL=${withCredentials(adminUrl, OPERATION_PROMOTER_ROLE, LOCAL_DEFAULTS.operationPromoterPassword)}`,
      );
      console.log(
        `DATABASE_PROFILE_PROVISIONER_URL=${withCredentials(adminUrl, PROFILE_PROVISIONER_ROLE, LOCAL_DEFAULTS.profileProvisionerPassword)}`,
      );
      console.log(
        `DATABASE_PROFILE_READER_URL=${withCredentials(adminUrl, PROFILE_READER_ROLE, LOCAL_DEFAULTS.profileReaderPassword)}`,
      );
      console.log(
        `DATABASE_PLATFORM_PROVISIONER_URL=${withCredentials(adminUrl, PLATFORM_PROVISIONER_ROLE, LOCAL_DEFAULTS.platformProvisionerPassword)}`,
      );
      console.log(
        `DATABASE_PLATFORM_READER_URL=${withCredentials(adminUrl, PLATFORM_READER_ROLE, LOCAL_DEFAULTS.platformReaderPassword)}`,
      );
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main(process.argv[2]).catch((error: unknown) => {
  if (
    process.argv[2] === "scan-evidence" ||
    process.argv[2] === "status-evidence"
  ) {
    console.error(
      JSON.stringify({
        schemaVersion: 1,
        job: EVIDENCE_JOB,
        operation: process.argv[2] === "scan-evidence" ? "scan" : "status",
        outcome: "failed",
        errorCode: "EVIDENCE_MONITOR_JOB_FAILED",
      }),
    );
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
