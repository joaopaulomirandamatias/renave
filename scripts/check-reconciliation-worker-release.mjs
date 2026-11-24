import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIGEST = "@sha256:[0-9a-f]{64}";
const rawSecretNames = new Set([
  "RENAVE_MTLS_KEY_PASSPHRASE",
  "RENAVE_RECONCILIATION_DATABASE_URL",
  "RENAVE_RECONCILIATION_PROJECTION_KEYS_JSON",
  "SERPRO_QUERY_LIMIT_HMAC_KEY_BASE64",
]);

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function violation(file, source, id, patternOrLine = 1) {
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

function parseJsonArray(value) {
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

function nodeBinary(value) {
  return /^\/(?:[^/]+\/)+node$/u.test(value);
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

function copySources(value) {
  const optionsRemoved = value.replace(/^(?:--\S+(?:=\S+)?\s+)*/u, "");
  if (optionsRemoved.startsWith("[")) {
    const values = parseJsonArray(optionsRemoved);
    return values ? values.slice(0, -1) : [];
  }
  const values = optionsRemoved.split(/\s+/u);
  return values.slice(0, -1);
}

export function checkDockerfile(
  source,
  file = "apps/reconciliation-worker/Dockerfile",
) {
  const issues = [];
  const instructions = logicalDockerInstructions(source);
  const froms = instructions.filter(
    ({ instruction }) => instruction === "FROM",
  );
  if (froms.length < 2) {
    issues.push(violation(file, source, "DOCKER_MULTISTAGE_REQUIRED"));
  }
  for (const from of froms) {
    const image = from.value.split(/\s+/u)[0];
    if (!new RegExp(`^[^@\\s]+${DIGEST}$`, "u").test(image)) {
      issues.push(
        violation(file, source, "DOCKER_BASE_DIGEST_REQUIRED", from.line),
      );
    }
  }

  let stage = -1;
  const staged = instructions.map((item) => {
    if (item.instruction === "FROM") stage += 1;
    return { ...item, stage };
  });
  const finalStage = Math.max(stage, 0);
  const builder = staged.filter((item) => item.stage === 0);
  const final = staged.filter((item) => item.stage === finalStage);
  const runtimeImage = froms.at(-1)?.value.split(/\s+/u)[0] ?? "";
  if (!/distroless[^@]*nodejs26[^@]*@sha256:/iu.test(runtimeImage)) {
    issues.push(
      violation(file, source, "DOCKER_DISTROLESS_NODE26_RUNTIME_REQUIRED"),
    );
  }
  if (
    !builder.some(
      ({ instruction, value }) =>
        instruction === "RUN" &&
        /pnpm\s+install\b[^&]*--ignore-scripts\b/u.test(value),
    )
  ) {
    issues.push(violation(file, source, "DOCKER_PNPM_IGNORE_SCRIPTS_REQUIRED"));
  }
  const user = final.filter(({ instruction }) => instruction === "USER").at(-1);
  if (!user || !/^[1-9][0-9]*(?::[1-9][0-9]*)?$/u.test(user.value)) {
    issues.push(
      violation(
        file,
        source,
        "DOCKER_NUMERIC_NON_ROOT_REQUIRED",
        user?.line ?? 1,
      ),
    );
  }

  const entrypoint = final
    .filter(({ instruction }) => instruction === "ENTRYPOINT")
    .at(-1);
  const entrypointArgv = entrypoint ? parseJsonArray(entrypoint.value) : null;
  if (
    !entrypointArgv ||
    entrypointArgv.length !== 2 ||
    !nodeBinary(entrypointArgv[0]) ||
    !/(?:^|\/)dist\/main\.js$/u.test(entrypointArgv[1])
  ) {
    issues.push(
      violation(
        file,
        source,
        "DOCKER_DIRECT_NODE_ENTRYPOINT_REQUIRED",
        entrypoint?.line ?? 1,
      ),
    );
  }

  const stop = final
    .filter(({ instruction }) => instruction === "STOPSIGNAL")
    .at(-1);
  if (!stop || stop.value !== "SIGTERM") {
    issues.push(
      violation(file, source, "DOCKER_SIGTERM_REQUIRED", stop?.line ?? 1),
    );
  }

  const health = final
    .filter(({ instruction }) => instruction === "HEALTHCHECK")
    .at(-1);
  const healthCommand = health
    ? /^.*?\bCMD\s+(\[[\s\S]+\])$/u.exec(health.value)?.[1]
    : undefined;
  const healthArgv = healthCommand ? parseJsonArray(healthCommand) : null;
  if (
    !healthArgv ||
    healthArgv.length !== 3 ||
    !nodeBinary(healthArgv[0]) ||
    !/(?:^|\/)dist\/health-probe\.js$/u.test(healthArgv[1]) ||
    healthArgv[2] !== "ready"
  ) {
    issues.push(
      violation(
        file,
        source,
        "DOCKER_INTERNAL_HEALTHCHECK_REQUIRED",
        health?.line ?? 1,
      ),
    );
  }

  const defaults = new Map();
  for (const env of final.filter(({ instruction }) => instruction === "ENV")) {
    for (const [name, value] of environmentAssignments(env.value)) {
      defaults.set(name, { line: env.line, value });
      if (rawSecretNames.has(name)) {
        issues.push(
          violation(file, source, "DOCKER_RAW_SECRET_ENV_FORBIDDEN", env.line),
        );
      }
    }
  }
  if (defaults.get("RENAVE_RECONCILIATION_WORKER_ENABLED")?.value !== "false") {
    issues.push(violation(file, source, "DOCKER_DISABLED_DEFAULT_REQUIRED"));
  }
  if (defaults.get("RENAVE_RECONCILIATION_WORKER_DRY_RUN")?.value !== "true") {
    issues.push(violation(file, source, "DOCKER_DRY_RUN_DEFAULT_REQUIRED"));
  }

  for (const item of staged.filter(({ instruction }) =>
    ["ADD", "COPY"].includes(instruction),
  )) {
    if (item.instruction === "ADD") {
      issues.push(violation(file, source, "DOCKER_ADD_FORBIDDEN", item.line));
      continue;
    }
    for (const candidate of copySources(item.value)) {
      const normalized = candidate.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (normalized === "" || normalized === ".") {
        issues.push(
          violation(file, source, "DOCKER_BROAD_COPY_FORBIDDEN", item.line),
        );
      }
      if (
        /(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|private)[^/]*|[^/]+\.(?:key|pem|p12|pfx))(?:\/|$)/iu.test(
          normalized,
        )
      ) {
        issues.push(
          violation(file, source, "DOCKER_SECRET_COPY_FORBIDDEN", item.line),
        );
      }
      if (
        item.stage === finalStage &&
        /(?:^|\/)(?:src|test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/iu.test(
          normalized,
        )
      ) {
        issues.push(
          violation(
            file,
            source,
            "DOCKER_RUNTIME_SOURCE_COPY_FORBIDDEN",
            item.line,
          ),
        );
      }
      if (
        item.stage < finalStage &&
        !/^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|apps\/reconciliation-worker(?:\/.*)?|packages(?:\/.*)?)$/u.test(
          normalized,
        )
      ) {
        issues.push(
          violation(
            file,
            source,
            "DOCKER_BUILDER_COPY_NOT_ALLOWLISTED",
            item.line,
          ),
        );
      }
      if (
        item.stage === finalStage &&
        (!/^--from=build(?:\s|$)/u.test(item.value) ||
          !/^\/opt\/runtime(?:\/|$)/u.test(candidate))
      ) {
        issues.push(
          violation(
            file,
            source,
            "DOCKER_RUNTIME_COPY_NOT_ALLOWLISTED",
            item.line,
          ),
        );
      }
    }
  }
  return issues;
}

const requiredDockerignorePatterns = [
  ".git",
  ".env",
  "**/*.key",
  "**/*.pem",
  "**/node_modules",
  "**/*.test.*",
  "**/*.spec.*",
  "**/database-url",
  "**/limiter-hmac-key",
  "**/projection-keys.json",
  "**/mtls-passphrase",
  "**/secrets/**",
];
const finalDockerignorePatterns = new Set([
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/database-url",
  "**/limiter-hmac-key",
  "**/projection-keys.json",
  "**/mtls-passphrase",
  "**/secrets/**",
]);

export function checkDockerignore(source, file = ".dockerignore") {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const lastNegation = lines.reduce(
    (last, line, index) => (line.startsWith("!") ? index : last),
    -1,
  );
  return requiredDockerignorePatterns.flatMap((pattern) => {
    const lastRule = lines.lastIndexOf(pattern);
    if (lastRule === -1) {
      return [
        violation(
          file,
          source,
          `DOCKERIGNORE_MISSING_${pattern.replaceAll(/[^A-Za-z0-9]+/gu, "_")}`,
        ),
      ];
    }
    if (finalDockerignorePatterns.has(pattern) && lastRule < lastNegation) {
      return [violation(file, source, "DOCKERIGNORE_SECRET_RULE_NOT_FINAL")];
    }
    return [];
  });
}

function manifestContainerImages(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const images = [];
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^([ \t]*)(?:initContainers|containers):\s*$/u.exec(
      lines[index],
    );
    if (!section) continue;
    const sectionIndent = section[1].length;
    let itemIndent = null;
    let current = -1;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") continue;
      const indentation = /^[ \t]*/u.exec(line)?.[0].length ?? 0;
      if (indentation <= sectionIndent) {
        index -= 1;
        break;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        if (itemIndent === null) itemIndent = indentation;
        if (indentation === itemIndent) {
          images.push(null);
          current = images.length - 1;
          const inline = /^-\s+image:\s*(\S+)\s*$/u.exec(trimmed)?.[1];
          if (inline) images[current] = inline;
          continue;
        }
      }
      const image = /^image:\s*(\S+)\s*$/u.exec(trimmed)?.[1];
      if (current >= 0 && image) images[current] = image;
    }
  }
  return images;
}

export function checkManifest(
  source,
  file = "deploy/reconciliation-worker.yaml",
) {
  const issues = [];
  const workload = /^kind:\s*(Deployment|Job)\s*$/mu.exec(source)?.[1];
  const completeWorkload =
    workload !== undefined && !/-patch\.ya?ml$/u.test(file);
  const rules = [
    ["MANIFEST_RUN_AS_NON_ROOT_REQUIRED", /runAsNonRoot:\s*true\b/u],
    ["MANIFEST_READ_ONLY_ROOT_REQUIRED", /readOnlyRootFilesystem:\s*true\b/u],
    [
      "MANIFEST_NO_PRIVILEGE_ESCALATION_REQUIRED",
      /allowPrivilegeEscalation:\s*false\b/u,
    ],
    ["MANIFEST_DROP_ALL_REQUIRED", /drop:\s*(?:\n\s*-\s*ALL\b|\[\s*ALL\s*\])/u],
    [
      "MANIFEST_SECCOMP_REQUIRED",
      /seccompProfile:\s*\n\s*type:\s*RuntimeDefault\b/u,
    ],
    [
      "MANIFEST_SERVICE_TOKEN_DISABLED",
      /automountServiceAccountToken:\s*false\b/u,
    ],
  ];
  if (completeWorkload) {
    for (const [id, pattern] of rules) {
      if (!pattern.test(source)) issues.push(violation(file, source, id));
    }
    const images = manifestContainerImages(source);
    if (
      images.length === 0 ||
      images.some(
        (image) => !/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(image ?? ""),
      )
    ) {
      issues.push(violation(file, source, "MANIFEST_IMAGE_DIGEST_REQUIRED"));
    }
  }
  for (const [pattern, id] of [
    [/privileged:\s*true\b/u, "MANIFEST_PRIVILEGED_FORBIDDEN"],
    [/hostNetwork:\s*true\b/u, "MANIFEST_HOST_NETWORK_FORBIDDEN"],
    [
      /type:\s*(?:LoadBalancer|NodePort)\b/u,
      "MANIFEST_EXTERNAL_SERVICE_FORBIDDEN",
    ],
  ]) {
    if (pattern.test(source)) {
      issues.push(violation(file, source, id, pattern));
    }
  }
  for (const name of rawSecretNames) {
    const pattern = new RegExp(`name:\\s*${name}\\b`, "u");
    if (pattern.test(source)) {
      issues.push(
        violation(file, source, "MANIFEST_RAW_SECRET_ENV_FORBIDDEN", pattern),
      );
    }
  }
  if (completeWorkload && workload === "Deployment") {
    for (const [probe, target, id] of [
      ["startupProbe", "health", "MANIFEST_ABSOLUTE_STARTUP_REQUIRED"],
      ["livenessProbe", "health", "MANIFEST_ABSOLUTE_LIVENESS_REQUIRED"],
      ["readinessProbe", "ready", "MANIFEST_ABSOLUTE_READINESS_REQUIRED"],
    ]) {
      const block = new RegExp(
        `^([ \\t]*)${probe}:\\s*$([\\s\\S]*?)(?=^\\1\\S|(?![\\s\\S]))`,
        "mu",
      ).exec(source)?.[2];
      const expected = new RegExp(
        `exec:\\s*\\n\\s*command:\\s*\\n\\s*-\\s*/nodejs/bin/node\\s*\\n\\s*-\\s*dist/health-probe\\.js\\s*\\n\\s*-\\s*${target}\\b`,
        "u",
      );
      if (block === undefined || !expected.test(block)) {
        issues.push(violation(file, source, id));
      }
    }
  }
  return issues;
}

export function checkWorkflow(source, file = ".github/workflows/ci.yml") {
  const issues = [];
  const forbidden = [
    [/\bid-token:\s*write\b/u, "WORKFLOW_OIDC_WRITE_FORBIDDEN"],
    [/\bpackages:\s*write\b/u, "WORKFLOW_PACKAGES_WRITE_FORBIDDEN"],
    [/^\s*environment:\s*\S+/mu, "WORKFLOW_DEPLOY_ENVIRONMENT_FORBIDDEN"],
    [/\bdocker\s+(?:image\s+)?push\b/u, "WORKFLOW_IMAGE_PUSH_FORBIDDEN"],
    [
      /\bdocker\s+buildx\s+build[^\n]*--push\b/u,
      "WORKFLOW_IMAGE_PUSH_FORBIDDEN",
    ],
    [
      /\b(?:kubectl|helm|railway)\b[^\n]*/u,
      "WORKFLOW_DEPLOY_COMMAND_FORBIDDEN",
    ],
    [/\bssh\s+[^\n]*/u, "WORKFLOW_REMOTE_COMMAND_FORBIDDEN"],
    [
      /(?:docker\/login-action|google-github-actions\/auth|aws-actions\/configure-aws-credentials)@/u,
      "WORKFLOW_REGISTRY_OR_CLOUD_LOGIN_FORBIDDEN",
    ],
  ];
  for (const [pattern, id] of forbidden) {
    if (pattern.test(source)) {
      issues.push(violation(file, source, id, pattern));
    }
  }
  const required = [
    [
      "WORKFLOW_IMAGE_JOB_REQUIRED",
      /^\s{2}reconciliation-worker-image-smoke:\s*$/mu,
    ],
    [
      "WORKFLOW_RELEASE_GUARD_REQUIRED",
      /check-reconciliation-worker-release\.mjs/u,
    ],
    [
      "WORKFLOW_LOCAL_BUILD_REQUIRED",
      /docker\s+build\b[\s\S]*?--tag\s+[^\n]*reconciliation-worker/u,
    ],
    ["WORKFLOW_NETWORK_NONE_REQUIRED", /docker\s+run[\s\S]*?--network\s+none/u],
    ["WORKFLOW_READ_ONLY_REQUIRED", /docker\s+run[\s\S]*?--read-only/u],
    ["WORKFLOW_CAP_DROP_REQUIRED", /docker\s+run[\s\S]*?--cap-drop\s+ALL/u],
    [
      "WORKFLOW_NO_NEW_PRIVILEGES_REQUIRED",
      /--security-opt\s+no-new-privileges/u,
    ],
    ["WORKFLOW_IMAGE_INSPECT_REQUIRED", /docker\s+image\s+inspect/u],
    ["WORKFLOW_HISTORY_INSPECT_REQUIRED", /docker\s+history\s+--no-trunc/u],
    ["WORKFLOW_ROOTFS_INSPECT_REQUIRED", /docker\s+export/u],
    [
      "WORKFLOW_RUNTIME_TOOLING_ABSENT_REQUIRED",
      /bin\/\(\?:sh\|bash\)[\s\S]*?corepack/u,
    ],
    ["WORKFLOW_DISABLED_LOG_REQUIRED", /"event":"disabled"/u],
    ["WORKFLOW_ALWAYS_CLEANUP_REQUIRED", /if:\s*always\(\)/u],
  ];
  for (const [id, pattern] of required) {
    if (!pattern.test(source)) issues.push(violation(file, source, id));
  }
  return issues;
}

async function manifestFiles(root) {
  const directory = join(root, "deploy");
  if ((await stat(directory).catch(() => null))?.isDirectory() !== true) {
    return [];
  }
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && [".yaml", ".yml"].includes(extname(path))) {
        const source = await readFile(path, "utf8");
        if (/reconciliation-worker/iu.test(`${basename(path)}\n${source}`)) {
          files.push({ file: relative(root, path), source });
        }
      }
    }
  }
  await walk(directory);
  return files;
}

export async function checkRepositoryRelease(root = repositoryRoot) {
  const inputs = [
    ["apps/reconciliation-worker/Dockerfile", checkDockerfile],
    ["apps/reconciliation-worker/Dockerfile.dockerignore", checkDockerignore],
    [".dockerignore", checkDockerignore],
    [".github/workflows/ci.yml", checkWorkflow],
  ];
  const issues = [];
  for (const [name, check] of inputs) {
    const path = join(root, name);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) {
      issues.push({
        file: name,
        id: "REQUIRED_RELEASE_FILE_MISSING",
        line: 1,
      });
    } else {
      issues.push(...check(source, name));
    }
  }
  const manifests = await manifestFiles(root);
  if (manifests.length === 0) {
    issues.push({
      file: "deploy",
      id: "RECONCILIATION_WORKER_MANIFEST_REQUIRED",
      line: 1,
    });
  }
  for (const manifest of manifests) {
    issues.push(...checkManifest(manifest.source, manifest.file));
  }
  return issues;
}

function format(issue) {
  return `${issue.file}:${issue.line} ${issue.id}`;
}

async function main() {
  const issues = await checkRepositoryRelease();
  if (issues.length > 0) {
    console.error("Guard de release do reconciliation worker falhou:");
    for (const issue of issues) console.error(`  ${format(issue)}`);
    process.exitCode = 1;
    return;
  }
  console.log("Guard de release do reconciliation worker: OK");
}

const invoked = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) await main();
