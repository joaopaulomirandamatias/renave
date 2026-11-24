import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIGEST = "@sha256:[0-9a-f]{64}";
const SYFT_DIGEST =
  "00a4400827744854ef77b10679e38f991bf74fd20e3f03ffada8d6ee492520c3";
const secretNames = [
  "DATABASE_OPERATION_PROMOTER_URL",
  "DATABASE_URL",
  "OPERATION_PROMOTER_DATABASE_CA",
  "OPERATION_PROMOTER_DECISION",
  "OPERATION_PROMOTER_DECISION_KEYRING",
  "OPERATION_PROMOTER_TARGET",
];

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

function dockerInstructions(source) {
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

function copySources(value) {
  const withoutOptions = value.replace(/^(?:--\S+(?:=\S+)?\s+)*/u, "");
  if (withoutOptions.startsWith("[")) {
    const values = jsonArray(withoutOptions);
    return values ? values.slice(0, -1) : [];
  }
  return withoutOptions.split(/\s+/u).slice(0, -1);
}

export function checkDockerfile(
  source,
  file = "apps/operation-promoter/Dockerfile",
) {
  const issues = [];
  const instructions = dockerInstructions(source);
  const froms = instructions.filter(
    ({ instruction }) => instruction === "FROM",
  );
  if (froms.length < 2) {
    issues.push(violation(file, source, "PROMOTER_DOCKER_MULTISTAGE_REQUIRED"));
  }
  for (const from of froms) {
    const image = from.value.split(/\s+/u)[0];
    if (!new RegExp(`^[^@\\s]+${DIGEST}$`, "u").test(image)) {
      issues.push(
        violation(
          file,
          source,
          "PROMOTER_DOCKER_BASE_DIGEST_REQUIRED",
          from.line,
        ),
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
  const runtime = staged.filter((item) => item.stage === finalStage);
  const runtimeImage = froms.at(-1)?.value.split(/\s+/u)[0] ?? "";
  if (!/distroless[^@]*nodejs26[^@]*:nonroot@sha256:/iu.test(runtimeImage)) {
    issues.push(
      violation(file, source, "PROMOTER_DOCKER_DISTROLESS_NONROOT_REQUIRED"),
    );
  }
  if (
    !builder.some(
      ({ instruction, value }) =>
        instruction === "RUN" &&
        /pnpm\s+install\b[^&]*--ignore-scripts\b/u.test(value),
    )
  ) {
    issues.push(
      violation(file, source, "PROMOTER_DOCKER_IGNORE_SCRIPTS_REQUIRED"),
    );
  }
  const user = runtime
    .filter(({ instruction }) => instruction === "USER")
    .at(-1);
  if (!user || !/^[1-9][0-9]*(?::[1-9][0-9]*)?$/u.test(user.value)) {
    issues.push(
      violation(
        file,
        source,
        "PROMOTER_DOCKER_NUMERIC_NONROOT_REQUIRED",
        user?.line ?? 1,
      ),
    );
  }
  const entrypoint = runtime
    .filter(({ instruction }) => instruction === "ENTRYPOINT")
    .at(-1);
  const argv = entrypoint ? jsonArray(entrypoint.value) : null;
  if (
    !argv ||
    argv.length !== 2 ||
    argv[0] !== "/nodejs/bin/node" ||
    argv[1] !== "dist/main.js"
  ) {
    issues.push(
      violation(
        file,
        source,
        "PROMOTER_DOCKER_DIRECT_ENTRYPOINT_REQUIRED",
        entrypoint?.line ?? 1,
      ),
    );
  }
  const stop = runtime
    .filter(({ instruction }) => instruction === "STOPSIGNAL")
    .at(-1);
  if (stop?.value !== "SIGTERM") {
    issues.push(
      violation(
        file,
        source,
        "PROMOTER_DOCKER_SIGTERM_REQUIRED",
        stop?.line ?? 1,
      ),
    );
  }
  if (runtime.some(({ instruction }) => instruction === "CMD")) {
    issues.push(violation(file, source, "PROMOTER_DOCKER_CMD_FORBIDDEN"));
  }
  if (runtime.some(({ instruction }) => instruction === "HEALTHCHECK")) {
    issues.push(
      violation(file, source, "PROMOTER_DOCKER_HEALTHCHECK_FORBIDDEN"),
    );
  }
  for (const env of runtime.filter(
    ({ instruction }) => instruction === "ENV",
  )) {
    for (const name of secretNames) {
      if (new RegExp(`(?:^|\\s)${name}=`, "u").test(env.value)) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_DOCKER_SECRET_ENV_FORBIDDEN",
            env.line,
          ),
        );
      }
    }
  }
  for (const item of staged.filter(({ instruction }) =>
    ["ADD", "COPY"].includes(instruction),
  )) {
    if (item.instruction === "ADD") {
      issues.push(
        violation(file, source, "PROMOTER_DOCKER_ADD_FORBIDDEN", item.line),
      );
      continue;
    }
    for (const candidate of copySources(item.value)) {
      const normalized = candidate.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (normalized === "" || normalized === ".") {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_DOCKER_BROAD_COPY_FORBIDDEN",
            item.line,
          ),
        );
      }
      if (
        /(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|private)[^/]*|[^/]+\.(?:key|pem|p12|pfx))(?:\/|$)/iu.test(
          normalized,
        )
      ) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_DOCKER_SECRET_COPY_FORBIDDEN",
            item.line,
          ),
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
            "PROMOTER_DOCKER_RUNTIME_SOURCE_FORBIDDEN",
            item.line,
          ),
        );
      }
      if (
        item.stage < finalStage &&
        !/^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|apps\/operation-promoter(?:\/.*)?|packages(?:\/.*)?)$/u.test(
          normalized,
        )
      ) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_DOCKER_BUILDER_COPY_NOT_ALLOWLISTED",
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
            "PROMOTER_DOCKER_RUNTIME_COPY_NOT_ALLOWLISTED",
            item.line,
          ),
        );
      }
    }
  }
  return issues;
}

const requiredIgnorePatterns = [
  ".git",
  ".env",
  "**/.env",
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/node_modules",
  "**/*.test.*",
  "**/*.spec.*",
  "**/database-url",
  "**/database-ca.pem",
  "**/promotion-decision.json",
  "**/decision-keyring.json",
  "**/target.json",
  "**/secrets/**",
];
const finalIgnorePatterns = new Set(requiredIgnorePatterns.slice(3));

export function checkDockerignore(
  source,
  file = "apps/operation-promoter/Dockerfile.dockerignore",
) {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const lastNegation = lines.reduce(
    (last, line, index) => (line.startsWith("!") ? index : last),
    -1,
  );
  return requiredIgnorePatterns.flatMap((pattern) => {
    const lastRule = lines.lastIndexOf(pattern);
    if (lastRule === -1) {
      return [
        violation(
          file,
          source,
          `PROMOTER_DOCKERIGNORE_MISSING_${pattern.replaceAll(/[^A-Za-z0-9]+/gu, "_")}`,
        ),
      ];
    }
    if (finalIgnorePatterns.has(pattern) && lastRule < lastNegation) {
      return [
        violation(file, source, "PROMOTER_DOCKERIGNORE_SECRET_RULE_NOT_FINAL"),
      ];
    }
    return [];
  });
}

function manifestImages(source) {
  return [...source.matchAll(/^\s*image:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  );
}

function checkManifestDocument(
  source,
  file = "deploy/operation-promoter.yaml",
) {
  const issues = [];
  const kind = /^kind:\s*(\S+)\s*$/mu.exec(source)?.[1];
  if (["Deployment", "CronJob"].includes(kind ?? "")) {
    issues.push(
      violation(file, source, "PROMOTER_MANIFEST_ONE_SHOT_JOB_REQUIRED"),
    );
  }
  if (kind === "Job") {
    for (const [id, pattern] of [
      ["PROMOTER_JOB_BACKOFF_ZERO_REQUIRED", /backoffLimit:\s*0\b/u],
      ["PROMOTER_JOB_COMPLETIONS_ONE_REQUIRED", /completions:\s*1\b/u],
      ["PROMOTER_JOB_PARALLELISM_ONE_REQUIRED", /parallelism:\s*1\b/u],
      ["PROMOTER_JOB_RESTART_NEVER_REQUIRED", /restartPolicy:\s*Never\b/u],
      ["PROMOTER_JOB_RUN_AS_NONROOT_REQUIRED", /runAsNonRoot:\s*true\b/u],
      [
        "PROMOTER_JOB_READ_ONLY_ROOT_REQUIRED",
        /readOnlyRootFilesystem:\s*true\b/u,
      ],
      [
        "PROMOTER_JOB_NO_PRIVILEGE_ESCALATION_REQUIRED",
        /allowPrivilegeEscalation:\s*false\b/u,
      ],
      [
        "PROMOTER_JOB_DROP_ALL_REQUIRED",
        /drop:\s*(?:\n\s*-\s*ALL\b|\[\s*ALL\s*\])/u,
      ],
      [
        "PROMOTER_JOB_SECCOMP_REQUIRED",
        /seccompProfile:\s*\n\s*type:\s*RuntimeDefault\b/u,
      ],
      [
        "PROMOTER_JOB_SERVICE_TOKEN_DISABLED_REQUIRED",
        /automountServiceAccountToken:\s*false\b/u,
      ],
      [
        "PROMOTER_JOB_SECRET_MOUNT_REQUIRED",
        /mountPath:\s*\/run\/secrets\/seu-renave\/operation-promoter\s*\n\s*readOnly:\s*true\b/u,
      ],
      [
        "PROMOTER_JOB_SECRET_SOURCE_REQUIRED",
        /(?:secretName:\s*\S+|secret:\s*\n\s*name:\s*\S+)/u,
      ],
    ]) {
      if (!pattern.test(source)) issues.push(violation(file, source, id));
    }
    const images = manifestImages(source);
    if (
      images.length !== 1 ||
      !/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(images[0] ?? "")
    ) {
      issues.push(
        violation(file, source, "PROMOTER_JOB_IMAGE_DIGEST_REQUIRED"),
      );
    }
    if (/\b(?:startup|liveness|readiness)Probe:\s*/u.test(source)) {
      issues.push(violation(file, source, "PROMOTER_JOB_PROBE_FORBIDDEN"));
    }
  }
  if (kind === "NetworkPolicy") {
    if (!/policyTypes:\s*\n(?:\s*-\s*\S+\s*\n)*\s*-\s*Egress\b/u.test(source)) {
      issues.push(
        violation(file, source, "PROMOTER_NETWORK_POLICY_EGRESS_REQUIRED"),
      );
    }
    if (/^\s*-\s*\{\s*\}\s*$/mu.test(source)) {
      issues.push(
        violation(file, source, "PROMOTER_NETWORK_POLICY_OPEN_RULE_FORBIDDEN"),
      );
    }
    const hasEgress = /^\s*egress:\s*$/mu.test(source);
    const portMatches = [
      ...source.matchAll(/^\s*(?:-\s*)?port:\s*(\d+)\s*$/gmu),
    ];
    const protocolMatches = [
      ...source.matchAll(/^\s*(?:-\s*)?protocol:\s*(\S+)\s*$/gmu),
    ];
    const isDns = portMatches.some((match) => match[1] === "53");

    if (isDns) {
      if (
        !/namespaceSelector:\s*\n\s*matchLabels:\s*\n\s*kubernetes\.io\/metadata\.name:\s*kube-system\b/u.test(
          source,
        ) ||
        !/podSelector:\s*\n\s*matchLabels:\s*\n\s*k8s-app:\s*kube-dns\b/u.test(
          source,
        )
      ) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_NETWORK_POLICY_DNS_SELECTOR_REQUIRED",
          ),
        );
      }
      const ports = portMatches.map((match) => match[1]);
      const protocols = protocolMatches.map((match) => match[1]).sort();
      if (
        ports.length !== 2 ||
        ports.some((port) => port !== "53") ||
        protocols.length !== 2 ||
        protocols[0] !== "TCP" ||
        protocols[1] !== "UDP" ||
        /\bipBlock:\s*|\bcidr:\s*|\bexcept:\s*/u.test(source)
      ) {
        issues.push(
          violation(file, source, "PROMOTER_NETWORK_POLICY_DNS_ONLY_REQUIRED"),
        );
      }
    } else if (hasEgress) {
      const hasEgressSelector =
        /to:\s*\n\s*-\s*(?:namespaceSelector|podSelector):/u.test(source);
      const cidrs = [...source.matchAll(/^\s*cidr:\s*(\S+)\s*$/gmu)].map(
        (match) => match[1],
      );
      const exactIpv4Pattern =
        "(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\/32";
      const exactIpv4 =
        cidrs.length === 1 &&
        new RegExp(`^${exactIpv4Pattern}$`, "u").test(cidrs[0]) &&
        cidrs[0] !== "0.0.0.0/32";
      const exactIpBlock = new RegExp(
        `to:\\s*\\n(?:\\s*#.*\\n)*\\s*-\\s*ipBlock:\\s*\\n\\s*cidr:\\s*${exactIpv4Pattern}\\s*(?:\\n|$)`,
        "u",
      ).test(source);
      if (hasEgressSelector || !exactIpv4 || !exactIpBlock) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_NETWORK_POLICY_EXACT_DB_TARGET_REQUIRED",
          ),
        );
      }
      if (/\bexcept:\s*|0\.0\.0\.0\/0|::\/0/u.test(source)) {
        issues.push(
          violation(
            file,
            source,
            "PROMOTER_NETWORK_POLICY_OPEN_CIDR_FORBIDDEN",
          ),
        );
      }
      if (
        portMatches.length !== 1 ||
        portMatches[0]?.[1] !== "5432" ||
        protocolMatches.length !== 1 ||
        protocolMatches[0]?.[1] !== "TCP"
      ) {
        issues.push(
          violation(file, source, "PROMOTER_NETWORK_POLICY_DB_ONLY_REQUIRED"),
        );
      }
    }
  }
  for (const [pattern, id] of [
    [/privileged:\s*true\b/u, "PROMOTER_MANIFEST_PRIVILEGED_FORBIDDEN"],
    [/hostNetwork:\s*true\b/u, "PROMOTER_MANIFEST_HOST_NETWORK_FORBIDDEN"],
    [/^kind:\s*Service\s*$/mu, "PROMOTER_MANIFEST_SERVICE_FORBIDDEN"],
  ]) {
    if (pattern.test(source)) {
      issues.push(violation(file, source, id, pattern));
    }
  }
  for (const name of secretNames) {
    const pattern = new RegExp(`name:\\s*${name}\\b`, "u");
    if (pattern.test(source)) {
      issues.push(
        violation(
          file,
          source,
          "PROMOTER_MANIFEST_SECRET_ENV_FORBIDDEN",
          pattern,
        ),
      );
    }
  }
  return issues;
}

export function checkManifest(source, file = "deploy/operation-promoter.yaml") {
  return source
    .split(/^---\s*$/mu)
    .filter((document) => document.trim() !== "")
    .flatMap((document) => checkManifestDocument(document, file));
}

function jobBlock(source, name) {
  return new RegExp(
    `^  ${name}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?![\\s\\S]))`,
    "mu",
  ).exec(source)?.[1];
}

function namedStep(source, name) {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^([ \\t]*)- name:\\s*${escaped}\\s*$([\\s\\S]*?)(?=^\\1-\\s|(?![\\s\\S]))`,
    "mu",
  ).exec(source)?.[2];
}

function executableWorkflow(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
}

export function checkWorkflow(source, file = ".github/workflows/ci.yml") {
  const issues = [];
  const executable = executableWorkflow(source);
  const block = jobBlock(executable, "operation-promoter-image-smoke");
  if (!block) {
    return [violation(file, source, "PROMOTER_WORKFLOW_IMAGE_JOB_REQUIRED")];
  }
  for (const [pattern, id] of [
    [/\bid-token:\s*write\b/u, "PROMOTER_WORKFLOW_OIDC_WRITE_FORBIDDEN"],
    [/\bpackages:\s*write\b/u, "PROMOTER_WORKFLOW_PACKAGES_WRITE_FORBIDDEN"],
    [/\bdocker\s+(?:image\s+)?push\b/u, "PROMOTER_WORKFLOW_PUSH_FORBIDDEN"],
    [
      /\bdocker\s+buildx\s+build[^\n]*--push\b/u,
      "PROMOTER_WORKFLOW_PUSH_FORBIDDEN",
    ],
    [
      /(?:docker\/login-action|google-github-actions\/auth|aws-actions\/configure-aws-credentials)@/u,
      "PROMOTER_WORKFLOW_LOGIN_FORBIDDEN",
    ],
    [/\b(?:kubectl|helm|railway|ssh)\b/u, "PROMOTER_WORKFLOW_DEPLOY_FORBIDDEN"],
  ]) {
    if (pattern.test(block)) issues.push(violation(file, source, id, pattern));
  }
  for (const [id, pattern] of [
    [
      "PROMOTER_WORKFLOW_CHECKOUT_PIN_REQUIRED",
      /actions\/checkout@[0-9a-f]{40}[\s\S]*?persist-credentials:\s*false\b/u,
    ],
    [
      "PROMOTER_WORKFLOW_RELEASE_GUARD_REQUIRED",
      /check-operation-promoter-release\.mjs/u,
    ],
    [
      "PROMOTER_WORKFLOW_LOCAL_BUILD_REQUIRED",
      /docker\s+build\b[\s\S]*?--tag\s+seu-renave\/operation-promoter:ci[\s\S]*?--file\s+apps\/operation-promoter\/Dockerfile/u,
    ],
    ["PROMOTER_WORKFLOW_INSPECT_REQUIRED", /docker\s+image\s+inspect/u],
    ["PROMOTER_WORKFLOW_HISTORY_REQUIRED", /docker\s+history\s+--no-trunc/u],
    ["PROMOTER_WORKFLOW_ROOTFS_REQUIRED", /docker\s+export/u],
    [
      "PROMOTER_WORKFLOW_CLOSURE_CHECK_REQUIRED",
      /(?:renave-connector|api-runtime\.js)[\s\S]*?(?:operation-worker\.js|migrate\.js|bootstrap\.js)/u,
    ],
    ["PROMOTER_WORKFLOW_ALWAYS_CLEANUP_REQUIRED", /if:\s*always\(\)/u],
  ]) {
    if (!pattern.test(block)) issues.push(violation(file, source, id));
  }

  const smoke = namedStep(block, "Run fail-closed image without mounts");
  if (!smoke) {
    issues.push(violation(file, source, "PROMOTER_WORKFLOW_SMOKE_REQUIRED"));
  } else {
    for (const [id, pattern] of [
      ["PROMOTER_WORKFLOW_NETWORK_NONE_REQUIRED", /--network\s+none\b/u],
      ["PROMOTER_WORKFLOW_READ_ONLY_REQUIRED", /--read-only\b/u],
      ["PROMOTER_WORKFLOW_CAP_DROP_REQUIRED", /--cap-drop\s+ALL\b/u],
      [
        "PROMOTER_WORKFLOW_NO_NEW_PRIVILEGES_REQUIRED",
        /--security-opt\s+no-new-privileges\b/u,
      ],
      [
        "PROMOTER_WORKFLOW_EXIT_ONE_REQUIRED",
        /test\s+"?\$status"?\s+-eq\s+1\b/u,
      ],
      [
        "PROMOTER_WORKFLOW_SANITIZED_LOG_REQUIRED",
        /"errorCode":"OPERATION_PROMOTER_CONFIG_INVALID"/u,
      ],
      [
        "PROMOTER_WORKFLOW_EMPTY_STDOUT_REQUIRED",
        /test\s+!\s+-s\s+\/tmp\/operation-promoter-stdout/u,
      ],
    ]) {
      if (!pattern.test(smoke)) issues.push(violation(file, source, id));
    }
    if (
      /docker\s+run[^\n]*(?:--(?:mount|volume)\b|\s-v(?:\s|=))/u.test(smoke)
    ) {
      issues.push(
        violation(file, source, "PROMOTER_WORKFLOW_SMOKE_MOUNT_FORBIDDEN"),
      );
    }
    if (/docker\s+run[^\n]*(?:--env(?:-file)?\b|\s-e(?:\s|=))/u.test(smoke)) {
      issues.push(
        violation(file, source, "PROMOTER_WORKFLOW_SMOKE_ENV_FORBIDDEN"),
      );
    }
  }

  const sbom = namedStep(block, "Generate and validate promoter SBOM");
  if (!sbom) {
    issues.push(violation(file, source, "PROMOTER_WORKFLOW_SBOM_REQUIRED"));
  } else {
    for (const [id, pattern] of [
      [
        "PROMOTER_WORKFLOW_SYFT_PIN_REQUIRED",
        new RegExp(
          `ghcr\\.io/anchore/syft:v1\\.57\\.2-nonroot@sha256:${SYFT_DIGEST}`,
          "u",
        ),
      ],
      ["PROMOTER_WORKFLOW_SBOM_NETWORK_NONE_REQUIRED", /--network\s+none\b/u],
      ["PROMOTER_WORKFLOW_SBOM_READ_ONLY_REQUIRED", /--read-only\b/u],
      ["PROMOTER_WORKFLOW_SBOM_CAP_DROP_REQUIRED", /--cap-drop\s+ALL\b/u],
      [
        "PROMOTER_WORKFLOW_SBOM_NO_NEW_PRIVILEGES_REQUIRED",
        /--security-opt\s+no-new-privileges\b/u,
      ],
      [
        "PROMOTER_WORKFLOW_SBOM_UPDATE_DISABLED_REQUIRED",
        /SYFT_CHECK_FOR_APP_UPDATE=false\b/u,
      ],
      [
        "PROMOTER_WORKFLOW_SBOM_ARCHIVE_REQUIRED",
        /docker-archive:\/scan\/image\.tar\s+--output\s+cyclonedx-json/u,
      ],
      [
        "PROMOTER_WORKFLOW_SBOM_VALIDATION_REQUIRED",
        /node\s+scripts\/check-image-sbom\.mjs\s*(?:\\\s*)?\/tmp\/operation-promoter-sbom\.cdx\.json/u,
      ],
    ]) {
      if (!pattern.test(sbom)) issues.push(violation(file, source, id));
    }
    if (
      /docker\.sock|\|\|\s*true|continue-on-error:\s*true|\b(?:curl|wget)\b/u.test(
        sbom,
      )
    ) {
      issues.push(
        violation(file, source, "PROMOTER_WORKFLOW_SBOM_BYPASS_FORBIDDEN"),
      );
    }
  }
  return issues;
}

export function checkRuntimePreparation(
  source,
  file = "apps/operation-promoter/scripts/prepare-runtime.mjs",
) {
  const issues = [];
  for (const required of [
    "config.js",
    "operation-promoter.js",
    "operations.js",
    "runtime-guard.js",
    "tenant-context.js",
  ]) {
    if (!source.includes(`"${required}"`)) {
      issues.push(
        violation(file, source, "PROMOTER_RUNTIME_DB_ALLOWLIST_INCOMPLETE"),
      );
      break;
    }
  }
  for (const required of [
    "@seu-renave/db",
    "@seu-renave/operation-promoter-app",
    "@seu-renave/operation-promotion-decision",
  ]) {
    if (!source.includes(`"${required}"`)) {
      issues.push(
        violation(
          file,
          source,
          "PROMOTER_RUNTIME_PACKAGE_ALLOWLIST_INCOMPLETE",
        ),
      );
      break;
    }
  }
  if (!/assertRuntimeEsmImports\s*\(\s*root\s*\)/u.test(source)) {
    issues.push(
      violation(file, source, "PROMOTER_RUNTIME_IMPORT_GRAPH_REQUIRED"),
    );
  }
  if (!/\["access-control",\s*"identity"\]/u.test(source)) {
    issues.push(
      violation(file, source, "PROMOTER_RUNTIME_IDENTITY_PRUNING_REQUIRED"),
    );
  }
  for (const forbidden of [
    "api-runtime.js",
    "bootstrap.js",
    "cli.js",
    "local-defaults.js",
    "migrate.js",
    "operation-worker.js",
    "operation-reconciliation.js",
    "renave-connector",
  ]) {
    if (source.includes(`"${forbidden}"`)) {
      issues.push(
        violation(file, source, "PROMOTER_RUNTIME_FORBIDDEN_CLOSURE_MEMBER"),
      );
    }
  }
  return issues;
}

async function manifests(root) {
  const directory = join(root, "deploy");
  if ((await stat(directory).catch(() => null))?.isDirectory() !== true) {
    return [];
  }
  const result = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && [".yaml", ".yml"].includes(extname(path))) {
        const source = await readFile(path, "utf8");
        if (/operation-promoter/iu.test(`${basename(path)}\n${source}`)) {
          result.push({ file: relative(root, path), source });
        }
      }
    }
  }
  await walk(directory);
  return result;
}

export async function checkRepositoryRelease(root = repositoryRoot) {
  const inputs = [
    ["apps/operation-promoter/Dockerfile", checkDockerfile],
    ["apps/operation-promoter/Dockerfile.dockerignore", checkDockerignore],
    [
      "apps/operation-promoter/scripts/prepare-runtime.mjs",
      checkRuntimePreparation,
    ],
    [".github/workflows/ci.yml", checkWorkflow],
  ];
  const issues = [];
  for (const [name, check] of inputs) {
    const source = await readFile(join(root, name), "utf8").catch(() => null);
    if (source === null) {
      issues.push({ file: name, id: "PROMOTER_RELEASE_FILE_MISSING", line: 1 });
    } else {
      issues.push(...check(source, name));
    }
  }
  const releaseManifests = await manifests(root);
  if (
    !releaseManifests.some(({ source }) => /^kind:\s*Job\s*$/mu.test(source))
  ) {
    issues.push({
      file: "deploy",
      id: "PROMOTER_JOB_MANIFEST_REQUIRED",
      line: 1,
    });
  }
  if (
    !releaseManifests.some(({ source }) =>
      /^kind:\s*NetworkPolicy\s*$/mu.test(source),
    )
  ) {
    issues.push({
      file: "deploy",
      id: "PROMOTER_NETWORK_POLICY_REQUIRED",
      line: 1,
    });
  }
  for (const manifest of releaseManifests) {
    issues.push(...checkManifest(manifest.source, manifest.file));
  }
  return issues;
}

async function main() {
  const issues = await checkRepositoryRelease();
  if (issues.length > 0) {
    console.error("Guard de release do operation promoter falhou:");
    for (const issue of issues) {
      console.error(`  ${issue.file}:${issue.line} ${issue.id}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Guard de release do operation promoter: OK");
}

const invoked = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) await main();
