import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIGEST = "@sha256:[0-9a-f]{64}";
const rawSecrets = [
  "DATABASE_URL",
  "IDENTITY_DATABASE_URL",
  "LOGIN_RATE_LIMIT_HMAC_KEY_BASE64",
  "OIDC_CLIENT_SECRET",
  "RENAVE_EVIDENCE_KEY_BASE64",
  "RENAVE_MTLS_KEY_PASSPHRASE",
  "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
  "TENANT_ADMIN_HMAC_KEY_BASE64",
];

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function issue(file, source, id, patternOrLine = 1) {
  const line =
    typeof patternOrLine === "number"
      ? patternOrLine
      : (() => {
          const match = patternOrLine.exec(source);
          return match?.index === undefined ? 1 : lineOf(source, match.index);
        })();
  return { file, id, line };
}

function logicalDockerInstructions(source) {
  const result = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let current = "";
  let start = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (current === "" && /^\s*(?:#|$)/u.test(raw)) continue;
    if (current === "") start = index + 1;
    current += `${current === "" ? "" : " "}${raw.trim()}`;
    if (/\\\s*$/u.test(raw)) {
      current = current.replace(/\\\s*$/u, "");
      continue;
    }
    const match = /^([A-Za-z]+)\s+([\s\S]+)$/u.exec(current);
    if (match) {
      result.push({
        instruction: match[1].toUpperCase(),
        line: start,
        value: match[2].trim(),
      });
    }
    current = "";
  }
  return result;
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function environmentAssignments(value) {
  const assignments = new Map();
  for (const match of value.matchAll(
    /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gu,
  )) {
    assignments.set(match[1], match[2].replace(/^(?:"|')|(?:"|')$/gu, ""));
  }
  return assignments;
}

function nodeBinary(value) {
  return /^\/(?:[^/]+\/)+node$/u.test(value);
}

function copySources(value) {
  const optionsRemoved = value.replace(/^(?:--\S+(?:=\S+)?\s+)*/u, "");
  if (optionsRemoved.startsWith("[")) {
    const values = jsonArray(optionsRemoved);
    return values ? values.slice(0, -1) : [];
  }
  return optionsRemoved.split(/\s+/u).slice(0, -1);
}

export function checkApiDockerfile(source, file = "apps/api/Dockerfile") {
  const issues = [];
  const instructions = logicalDockerInstructions(source);
  const froms = instructions.filter(
    ({ instruction }) => instruction === "FROM",
  );
  if (froms.length < 2) {
    issues.push(issue(file, source, "API_DOCKER_MULTISTAGE_REQUIRED"));
  }
  for (const from of froms) {
    const image = from.value.split(/\s+/u)[0];
    if (!new RegExp(`^[^@\\s]+${DIGEST}$`, "u").test(image)) {
      issues.push(
        issue(file, source, "API_DOCKER_BASE_DIGEST_REQUIRED", from.line),
      );
    }
  }
  let stage = -1;
  const staged = instructions.map((instruction) => {
    if (instruction.instruction === "FROM") stage += 1;
    return { ...instruction, stage };
  });
  const finalStage = Math.max(stage, 0);
  const final = staged.filter((entry) => entry.stage === finalStage);
  const runtimeImage = froms.at(-1)?.value.split(/\s+/u)[0] ?? "";
  if (!/distroless[^@]*nodejs26[^@]*@sha256:/iu.test(runtimeImage)) {
    issues.push(issue(file, source, "API_DOCKER_DISTROLESS_REQUIRED"));
  }
  if (
    !staged.some(
      ({ instruction, value, stage: instructionStage }) =>
        instructionStage === 0 &&
        instruction === "RUN" &&
        /pnpm\s+install\b[^&]*--ignore-scripts\b/u.test(value),
    )
  ) {
    issues.push(issue(file, source, "API_DOCKER_IGNORE_SCRIPTS_REQUIRED"));
  }
  const user = final.filter(({ instruction }) => instruction === "USER").at(-1);
  if (!user || !/^[1-9][0-9]*(?::[1-9][0-9]*)?$/u.test(user.value)) {
    issues.push(
      issue(file, source, "API_DOCKER_NON_ROOT_REQUIRED", user?.line ?? 1),
    );
  }
  const stop = final
    .filter(({ instruction }) => instruction === "STOPSIGNAL")
    .at(-1);
  if (!stop || stop.value !== "SIGTERM") {
    issues.push(
      issue(file, source, "API_DOCKER_SIGTERM_REQUIRED", stop?.line ?? 1),
    );
  }
  const entrypoint = final
    .filter(({ instruction }) => instruction === "ENTRYPOINT")
    .at(-1);
  const entrypointArgs = entrypoint ? jsonArray(entrypoint.value) : null;
  if (
    !entrypointArgs ||
    entrypointArgs.length !== 2 ||
    !nodeBinary(entrypointArgs[0]) ||
    entrypointArgs[1] !== "dist/server.js"
  ) {
    issues.push(
      issue(
        file,
        source,
        "API_DOCKER_ENTRYPOINT_REQUIRED",
        entrypoint?.line ?? 1,
      ),
    );
  }
  const health = final
    .filter(({ instruction }) => instruction === "HEALTHCHECK")
    .at(-1);
  const healthCommand = health
    ? /^.*?\bCMD\s+(\[[\s\S]+\])$/u.exec(health.value)?.[1]
    : undefined;
  const healthArgs = healthCommand ? jsonArray(healthCommand) : null;
  if (
    !healthArgs ||
    healthArgs.length !== 3 ||
    !nodeBinary(healthArgs[0]) ||
    healthArgs[1] !== "dist/health-probe.js" ||
    healthArgs[2] !== "readiness"
  ) {
    issues.push(
      issue(file, source, "API_DOCKER_HEALTHCHECK_REQUIRED", health?.line ?? 1),
    );
  }
  const defaults = new Map();
  for (const env of final.filter(({ instruction }) => instruction === "ENV")) {
    for (const [name, value] of environmentAssignments(env.value)) {
      defaults.set(name, value);
      if (rawSecrets.includes(name)) {
        issues.push(
          issue(file, source, "API_DOCKER_RAW_SECRET_FORBIDDEN", env.line),
        );
      }
    }
  }
  for (const [name, expected] of [
    ["NODE_ENV", "production"],
    ["APP_ENVIRONMENT", "homologation"],
    ["AUTH_MODE", "disabled"],
    ["RENAVE_INTEGRATION_ENABLED", "false"],
    ["RENAVE_STOCK_ENTRY_LOCAL_ENABLED", "false"],
    ["HOST", "127.0.0.1"],
  ]) {
    if (defaults.get(name) !== expected) {
      issues.push(issue(file, source, `API_DOCKER_DEFAULT_${name}_REQUIRED`));
    }
  }
  for (const entry of staged.filter(({ instruction }) =>
    ["ADD", "COPY"].includes(instruction),
  )) {
    if (entry.instruction === "ADD") {
      issues.push(issue(file, source, "API_DOCKER_ADD_FORBIDDEN", entry.line));
      continue;
    }
    for (const candidate of copySources(entry.value)) {
      const normalized = candidate.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (normalized === "" || normalized === ".") {
        issues.push(
          issue(file, source, "API_DOCKER_BROAD_COPY_FORBIDDEN", entry.line),
        );
      }
      if (
        /(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:key|pem|p12|pfx))(?:\/|$)/iu.test(
          normalized,
        )
      ) {
        issues.push(
          issue(file, source, "API_DOCKER_SECRET_COPY_FORBIDDEN", entry.line),
        );
      }
      if (
        entry.stage < finalStage &&
        !/^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|apps\/api(?:\/.*)?|packages(?:\/.*)?)$/u.test(
          normalized,
        )
      ) {
        issues.push(
          issue(file, source, "API_DOCKER_BUILDER_COPY_FORBIDDEN", entry.line),
        );
      }
      if (
        entry.stage === finalStage &&
        (!/^--from=build(?:\s|$)/u.test(entry.value) ||
          !/^\/opt\/runtime(?:\/|$)/u.test(candidate))
      ) {
        issues.push(
          issue(file, source, "API_DOCKER_RUNTIME_COPY_FORBIDDEN", entry.line),
        );
      }
    }
  }
  return issues;
}

const requiredIgnore = [
  ".git",
  ".env",
  "**/*.key",
  "**/*.pem",
  "**/node_modules",
  "**/*.test.*",
  "**/*.spec.*",
  "**/database-url",
  "**/identity-database-url",
  "**/limiter-hmac-key",
  "**/tenant-admin-hmac-key",
  "**/stock-entry-secret-bundle.json",
  "**/secrets/**",
  "**/.npmrc",
];

export function checkApiDockerignore(
  source,
  file = "apps/api/Dockerfile.dockerignore",
) {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const lastNegation = lines.reduce(
    (last, line, index) => (line.startsWith("!") ? index : last),
    -1,
  );
  return requiredIgnore.flatMap((pattern) => {
    const index = lines.lastIndexOf(pattern);
    if (index === -1) {
      return [
        issue(
          file,
          source,
          `API_DOCKERIGNORE_MISSING_${pattern.replaceAll(/[^A-Za-z0-9]+/gu, "_")}`,
        ),
      ];
    }
    if (
      index < lastNegation &&
      /(?:key|pem|secret|database|hmac|bundle)/iu.test(pattern)
    ) {
      return [issue(file, source, "API_DOCKERIGNORE_SECRET_RULE_NOT_FINAL")];
    }
    return [];
  });
}

function required(source, file, id, pattern, issues) {
  if (!pattern.test(source)) issues.push(issue(file, source, id));
}

export function checkApiManifestSet(manifests) {
  const issues = [];
  const allowedManifestNames = new Set([
    "configmap.yaml",
    "deployment.yaml",
    "kustomization.yaml",
    "namespace.yaml",
    "network-policy.yaml",
    "service-account.yaml",
    "service.yaml",
  ]);
  const deployment = manifests.get("deployment.yaml") ?? "";
  const config = manifests.get("configmap.yaml") ?? "";
  const service = manifests.get("service.yaml") ?? "";
  const account = manifests.get("service-account.yaml") ?? "";
  const network = manifests.get("network-policy.yaml") ?? "";
  const kustomization = manifests.get("kustomization.yaml") ?? "";
  const namespace = manifests.get("namespace.yaml") ?? "";
  const deploymentFile = "deploy/api/base/deployment.yaml";
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_REPLICAS_ZERO_REQUIRED",
    /replicas:\s*0\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_IMAGE_DIGEST_REQUIRED",
    /image:\s*[^\s@]+@sha256:[0-9a-f]{64}\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_NON_ROOT_REQUIRED",
    /runAsNonRoot:\s*true\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_READ_ONLY_REQUIRED",
    /readOnlyRootFilesystem:\s*true\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_NO_ESCALATION_REQUIRED",
    /allowPrivilegeEscalation:\s*false\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_DROP_ALL_REQUIRED",
    /drop:\s*\n\s*-\s*ALL\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_SECCOMP_REQUIRED",
    /seccompProfile:\s*\n\s*type:\s*RuntimeDefault\b/u,
    issues,
  );
  required(
    deployment,
    deploymentFile,
    "API_MANIFEST_TOKEN_DISABLED",
    /automountServiceAccountToken:\s*false\b/u,
    issues,
  );
  for (const [probe, target, id] of [
    ["startupProbe", "health", "API_MANIFEST_STARTUP_PROBE_REQUIRED"],
    ["livenessProbe", "health", "API_MANIFEST_LIVENESS_PROBE_REQUIRED"],
    ["readinessProbe", "readiness", "API_MANIFEST_READINESS_PROBE_REQUIRED"],
  ]) {
    required(
      deployment,
      deploymentFile,
      id,
      new RegExp(
        `${probe}:[\\s\\S]*?command:[\\s\\S]*?-\\s*/nodejs/bin/node[\\s\\S]*?-\\s*dist/health-probe\\.js[\\s\\S]*?-\\s*${target}\\b`,
        "u",
      ),
      issues,
    );
  }
  for (const [pattern, id] of [
    [/\benvFrom:\s*/u, "API_MANIFEST_ENV_FROM_FORBIDDEN"],
    [/\bsecretKeyRef:\s*/u, "API_MANIFEST_SECRET_ENV_FORBIDDEN"],
    [/\bprojected:\s*/u, "API_MANIFEST_SECRET_VOLUME_FORBIDDEN"],
    [/\bsecret:\s*/u, "API_MANIFEST_SECRET_VOLUME_FORBIDDEN"],
    [/\bhostPath:\s*/u, "API_MANIFEST_HOST_PATH_FORBIDDEN"],
    [/\bprivileged:\s*true\b/u, "API_MANIFEST_PRIVILEGED_FORBIDDEN"],
    [/\bhostNetwork:\s*true\b/u, "API_MANIFEST_HOST_NETWORK_FORBIDDEN"],
  ]) {
    if (pattern.test(deployment)) {
      issues.push(issue(deploymentFile, deployment, id, pattern));
    }
  }
  for (const secret of rawSecrets) {
    const pattern = new RegExp(`name:\\s*${secret}\\b`, "u");
    if (pattern.test(deployment)) {
      issues.push(
        issue(
          deploymentFile,
          deployment,
          "API_MANIFEST_RAW_SECRET_ENV_FORBIDDEN",
          pattern,
        ),
      );
    }
  }
  for (const [name, value] of [
    ["APP_ENVIRONMENT", "homologation"],
    ["AUTH_MODE", "disabled"],
    ["HOST", "127.0.0.1"],
    ["RENAVE_INTEGRATION_ENABLED", '"false"'],
    ["RENAVE_STOCK_ENTRY_LOCAL_ENABLED", '"false"'],
  ]) {
    required(
      config,
      "deploy/api/base/configmap.yaml",
      `API_CONFIG_${name}_REQUIRED`,
      new RegExp(`^\\s*${name}:\\s*${value}\\s*$`, "mu"),
      issues,
    );
  }
  required(
    service,
    "deploy/api/base/service.yaml",
    "API_SERVICE_CLUSTER_IP_REQUIRED",
    /type:\s*ClusterIP\b/u,
    issues,
  );
  if (/type:\s*(?:LoadBalancer|NodePort)\b/u.test(service)) {
    issues.push(
      issue(
        "deploy/api/base/service.yaml",
        service,
        "API_SERVICE_EXTERNAL_FORBIDDEN",
      ),
    );
  }
  for (const pattern of [
    /\bexternalIPs:\s*/u,
    /\bexternalName:\s*/u,
    /\bnodePort:\s*/u,
  ]) {
    if (pattern.test(service)) {
      issues.push(
        issue(
          "deploy/api/base/service.yaml",
          service,
          "API_SERVICE_EXTERNAL_FIELD_FORBIDDEN",
          pattern,
        ),
      );
    }
  }
  required(
    service,
    "deploy/api/base/service.yaml",
    "API_SERVICE_PORT_REQUIRED",
    /port:\s*3000\b/u,
    issues,
  );
  required(
    service,
    "deploy/api/base/service.yaml",
    "API_SERVICE_TARGET_REQUIRED",
    /targetPort:\s*http\b/u,
    issues,
  );
  required(
    account,
    "deploy/api/base/service-account.yaml",
    "API_SERVICE_ACCOUNT_TOKEN_DISABLED",
    /automountServiceAccountToken:\s*false\b/u,
    issues,
  );
  required(
    network,
    "deploy/api/base/network-policy.yaml",
    "API_NETWORK_DEFAULT_DENY_REQUIRED",
    /name:\s*renave-api-default-deny[\s\S]*?policyTypes:\s*\n\s*-\s*Ingress\s*\n\s*-\s*Egress/u,
    issues,
  );
  required(
    network,
    "deploy/api/base/network-policy.yaml",
    "API_NETWORK_DB_PLACEHOLDER_REQUIRED",
    /cidr:\s*192\.0\.2\.10\/32\b/u,
    issues,
  );
  const uncommentedNetwork = network
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
  const cidrs = Array.from(
    uncommentedNetwork.matchAll(/\bcidr:\s*(\S+)/gu),
    (match) => match[1],
  );
  const ports = Array.from(
    uncommentedNetwork.matchAll(/\bport:\s*(\d+)/gu),
    (match) => Number(match[1]),
  );
  if (
    cidrs.length !== 1 ||
    cidrs[0] !== "192.0.2.10/32" ||
    ports.length !== 1 ||
    ports[0] !== 5432
  ) {
    issues.push(
      issue(
        "deploy/api/base/network-policy.yaml",
        network,
        "API_NETWORK_EXTERNAL_EGRESS_FORBIDDEN",
      ),
    );
  }
  for (const resource of [
    "namespace.yaml",
    "service-account.yaml",
    "configmap.yaml",
    "deployment.yaml",
    "service.yaml",
    "network-policy.yaml",
  ]) {
    required(
      kustomization,
      "deploy/api/base/kustomization.yaml",
      `API_KUSTOMIZATION_MISSING_${resource.replaceAll(/[^A-Za-z0-9]+/gu, "_")}`,
      new RegExp(`-\\s*${resource.replace(".", "\\.")}\\s*$`, "mu"),
      issues,
    );
  }
  for (const label of ["audit", "enforce", "warn"]) {
    required(
      namespace,
      "deploy/api/base/namespace.yaml",
      `API_NAMESPACE_POD_SECURITY_${label.toUpperCase()}_REQUIRED`,
      new RegExp(
        `pod-security\\.kubernetes\\.io/${label}:\\s*restricted\\b`,
        "u",
      ),
      issues,
    );
  }
  for (const [name, source] of manifests) {
    const manifestFile = name.includes("/")
      ? `deploy/api/${name}`
      : `deploy/api/base/${name}`;
    if (!allowedManifestNames.has(name)) {
      issues.push(
        issue(manifestFile, source, "API_MANIFEST_ADDITIONAL_FILE_FORBIDDEN"),
      );
    }
    const forbiddenKind =
      /^kind:\s*(Ingress|Job|CronJob|Role|RoleBinding|ClusterRole|ClusterRoleBinding)\s*$/mu.exec(
        source,
      );
    if (forbiddenKind) {
      issues.push(
        issue(
          manifestFile,
          source,
          "API_MANIFEST_RESOURCE_KIND_FORBIDDEN",
          /^kind:\s*(?:Ingress|Job|CronJob|Role|RoleBinding|ClusterRole|ClusterRoleBinding)\s*$/mu,
        ),
      );
    }
    if (/\breplicas:\s*[1-9][0-9]*\b/u.test(source)) {
      issues.push(
        issue(
          manifestFile,
          source,
          "API_MANIFEST_NONZERO_REPLICA_FORBIDDEN",
          /\breplicas:\s*[1-9][0-9]*\b/u,
        ),
      );
    }
    if (
      /\b(?:csi|projected|secret|secretKeyRef|secretRef):\s*|secretProviderClass/u.test(
        source,
      )
    ) {
      issues.push(
        issue(manifestFile, source, "API_MANIFEST_SECRET_REFERENCE_FORBIDDEN"),
      );
    }
    for (const secret of rawSecrets) {
      const pattern = new RegExp(`\\b${secret}\\b`, "u");
      if (pattern.test(source)) {
        issues.push(
          issue(
            manifestFile,
            source,
            "API_MANIFEST_RAW_SECRET_FORBIDDEN",
            pattern,
          ),
        );
      }
    }
  }
  return issues;
}

function jobBlock(source, name) {
  return new RegExp(
    `^  ${name}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?![\\s\\S]))`,
    "mu",
  ).exec(source)?.[1];
}

function namedStepBlock(source, name) {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^([ \\t]*)- name:\\s*${escaped}\\s*$([\\s\\S]*?)(?=^\\1-\\s|(?![\\s\\S]))`,
    "mu",
  ).exec(source)?.[2];
}

function stripInlineComment(line) {
  let quote;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && character === "\\") {
        index += 1;
        continue;
      }
      if (quote === "'" && character === "'" && line[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /\s/u.test(line[index - 1] ?? ""))
    ) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

function executableWorkflow(source) {
  return source.split(/\r?\n/u).map(stripInlineComment).join("\n");
}

export function checkApiWorkflow(source, file = ".github/workflows/ci.yml") {
  const issues = [];
  const block = jobBlock(source, "api-image-smoke");
  if (!block) return [issue(file, source, "API_WORKFLOW_JOB_REQUIRED")];
  const executable = executableWorkflow(block);
  for (const [id, pattern] of [
    [
      "API_WORKFLOW_CONTENTS_READ_REQUIRED",
      /permissions:\s*\n\s*contents:\s*read\b/u,
    ],
    ["API_WORKFLOW_GUARD_REQUIRED", /check-api-release\.mjs/u],
    [
      "API_WORKFLOW_BUILD_REQUIRED",
      /docker\s+build[\s\S]*?apps\/api\/Dockerfile/u,
    ],
    ["API_WORKFLOW_INSPECT_REQUIRED", /docker\s+image\s+inspect/u],
    ["API_WORKFLOW_HISTORY_REQUIRED", /docker\s+history\s+--no-trunc/u],
    ["API_WORKFLOW_ROOTFS_REQUIRED", /docker\s+export/u],
    ["API_WORKFLOW_HEALTH_REQUIRED", /\.State\.Health\.Status/u],
    ["API_WORKFLOW_RUNNING_REQUIRED", /\.State\.Running/u],
    ["API_WORKFLOW_CLEANUP_REQUIRED", /if:\s*always\(\)/u],
    [
      "API_WORKFLOW_CHECKOUT_CREDENTIALS_DISABLED_REQUIRED",
      /persist-credentials:\s*false\b/u,
    ],
    [
      "API_WORKFLOW_SBOM_CLEANUP_REQUIRED",
      /rm\s+-f[\s\S]*?\/tmp\/renave-api-image\.tar[\s\S]*?\/tmp\/renave-api-sbom\.cdx\.json/u,
    ],
  ]) {
    if (!pattern.test(executable)) issues.push(issue(file, source, id));
  }

  const runtime = namedStepBlock(
    executable,
    "Run dormant API image in hardened sandbox",
  );
  for (const [id, pattern] of [
    [
      "API_WORKFLOW_NETWORK_NONE_REQUIRED",
      /docker\s+run[\s\S]*?--network\s+none/u,
    ],
    ["API_WORKFLOW_READ_ONLY_REQUIRED", /docker\s+run[\s\S]*?--read-only/u],
    ["API_WORKFLOW_CAP_DROP_REQUIRED", /docker\s+run[\s\S]*?--cap-drop\s+ALL/u],
    [
      "API_WORKFLOW_NO_NEW_PRIVILEGES_REQUIRED",
      /--security-opt\s+no-new-privileges/u,
    ],
  ]) {
    if (!runtime || !pattern.test(runtime))
      issues.push(issue(file, source, id));
  }

  const sbom = namedStepBlock(executable, "Generate and validate API SBOM");
  if (!sbom) {
    issues.push(issue(file, source, "API_WORKFLOW_SBOM_STEP_REQUIRED"));
  } else {
    for (const [id, pattern] of [
      [
        "API_WORKFLOW_SBOM_IMAGE_SAVE_REQUIRED",
        /docker\s+save\s+seu-renave\/api:ci\s+--output\s+\/tmp\/renave-api-image\.tar/u,
      ],
      [
        "API_WORKFLOW_SYFT_DIGEST_REQUIRED",
        /ghcr\.io\/anchore\/syft:v1\.57\.2-nonroot@sha256:00a4400827744854ef77b10679e38f991bf74fd20e3f03ffada8d6ee492520c3/u,
      ],
      ["API_WORKFLOW_SBOM_NETWORK_NONE_REQUIRED", /--network\s+none\b/u],
      ["API_WORKFLOW_SBOM_READ_ONLY_REQUIRED", /--read-only\b/u],
      ["API_WORKFLOW_SBOM_CAP_DROP_REQUIRED", /--cap-drop\s+ALL\b/u],
      [
        "API_WORKFLOW_SBOM_NO_NEW_PRIVILEGES_REQUIRED",
        /--security-opt\s+no-new-privileges\b/u,
      ],
      [
        "API_WORKFLOW_SBOM_TMPFS_REQUIRED",
        /--tmpfs\s+\/tmp:rw,noexec,nosuid,nodev,size=1g\b/u,
      ],
      [
        "API_WORKFLOW_SBOM_CACHE_TMPFS_REQUIRED",
        /--tmpfs\s+\/home\/nonroot\/\.cache:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700\b/u,
      ],
      [
        "API_WORKFLOW_SBOM_UPDATE_CHECK_DISABLED_REQUIRED",
        /SYFT_CHECK_FOR_APP_UPDATE=false\b/u,
      ],
      [
        "API_WORKFLOW_SBOM_ARCHIVE_MOUNT_REQUIRED",
        /--volume\s+\/tmp\/renave-api-image\.tar:\/scan\/image\.tar:ro\b/u,
      ],
      [
        "API_WORKFLOW_SBOM_CYCLONEDX_REQUIRED",
        /scan\s+docker-archive:\/scan\/image\.tar\s+--output\s+cyclonedx-json\s*(?:\\\s*)?>\s*\/tmp\/renave-api-sbom\.cdx\.json/u,
      ],
      [
        "API_WORKFLOW_SBOM_VALIDATION_REQUIRED",
        /node\s+scripts\/check-image-sbom\.mjs\s+\/tmp\/renave-api-sbom\.cdx\.json/u,
      ],
    ]) {
      if (!pattern.test(sbom)) issues.push(issue(file, source, id));
    }
    for (const [id, pattern] of [
      ["API_WORKFLOW_SBOM_DOCKER_SOCKET_FORBIDDEN", /docker\.sock/u],
      [
        "API_WORKFLOW_SBOM_UPLOAD_FORBIDDEN",
        /(?:upload-artifact|upload-release|dependency-snapshot)/iu,
      ],
      [
        "API_WORKFLOW_SBOM_BYPASS_FORBIDDEN",
        /continue-on-error:\s*true|\|\|\s*true/u,
      ],
      ["API_WORKFLOW_SBOM_REMOTE_INSTALL_FORBIDDEN", /\b(?:curl|wget)\b/u],
    ]) {
      if (pattern.test(sbom)) issues.push(issue(file, source, id, pattern));
    }
  }
  for (const [pattern, id] of [
    [/\bid-token:\s*write\b/u, "API_WORKFLOW_OIDC_WRITE_FORBIDDEN"],
    [/\bpackages:\s*write\b/u, "API_WORKFLOW_PACKAGES_WRITE_FORBIDDEN"],
    [/\bdocker\s+(?:image\s+)?push\b/u, "API_WORKFLOW_PUSH_FORBIDDEN"],
    [/\bdocker\s+buildx\s+build[^\n]*--push\b/u, "API_WORKFLOW_PUSH_FORBIDDEN"],
    [/\b(?:kubectl|helm|railway)\b/u, "API_WORKFLOW_DEPLOY_FORBIDDEN"],
    [
      /(?:docker\/login-action|google-github-actions\/auth|aws-actions\/configure-aws-credentials)@/u,
      "API_WORKFLOW_CLOUD_LOGIN_FORBIDDEN",
    ],
    [
      /(?:upload-artifact|upload-release|dependency-snapshot)/iu,
      "API_WORKFLOW_SBOM_UPLOAD_FORBIDDEN",
    ],
  ]) {
    if (pattern.test(executable)) issues.push(issue(file, source, id, pattern));
  }
  return issues;
}

export function checkApiRuntimePreparation(
  source,
  file = "apps/api/scripts/prepare-runtime.mjs",
) {
  const issues = [];
  if (!/["']tenant-runtime["']/u.test(source)) {
    issues.push(issue(file, source, "API_TENANT_RUNTIME_REQUIRED"));
  }
  if (!/assertRuntimeEsmImports\s*\(\s*root\s*\)/u.test(source)) {
    issues.push(issue(file, source, "API_RUNTIME_IMPORT_GRAPH_REQUIRED"));
  }
  return issues;
}

export async function checkApiRepositoryRelease(root = repositoryRoot) {
  const issues = [];
  for (const [name, check] of [
    ["apps/api/Dockerfile", checkApiDockerfile],
    ["apps/api/Dockerfile.dockerignore", checkApiDockerignore],
    ["apps/api/scripts/prepare-runtime.mjs", checkApiRuntimePreparation],
    [".github/workflows/ci.yml", checkApiWorkflow],
  ]) {
    const source = await readFile(join(root, name), "utf8").catch(() => null);
    if (source === null) {
      issues.push({ file: name, id: "API_RELEASE_FILE_MISSING", line: 1 });
    } else {
      issues.push(...check(source, name));
    }
  }
  const manifests = new Map();
  for (const name of [
    "configmap.yaml",
    "deployment.yaml",
    "network-policy.yaml",
    "service-account.yaml",
    "service.yaml",
    "kustomization.yaml",
    "namespace.yaml",
  ]) {
    manifests.set(
      name,
      await readFile(join(root, "deploy/api/base", name), "utf8").catch(
        () => "",
      ),
    );
  }
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await collect(path);
      } else if (
        entry.isFile() &&
        [".yaml", ".yml"].includes(extname(entry.name))
      ) {
        const name = relative(join(root, "deploy/api"), path);
        if (!name.startsWith("base/") || !manifests.has(name.slice(5))) {
          manifests.set(name, await readFile(path, "utf8"));
        }
      }
    }
  }
  await collect(join(root, "deploy/api"));
  issues.push(...checkApiManifestSet(manifests));
  return issues;
}

function format(value) {
  return `${value.file}:${value.line} ${value.id}`;
}

const invoked = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  const issues = await checkApiRepositoryRelease();
  if (issues.length > 0) {
    console.error("Guard de release da API falhou:");
    for (const value of issues) console.error(`  ${format(value)}`);
    process.exitCode = 1;
  } else {
    console.log("Guard de release da API: OK");
  }
}
