import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkDockerfile,
  checkDockerignore,
  checkManifest,
  checkRuntimePreparation,
  checkWorkflow,
} from "./check-reconciliation-worker-release.mjs";

const digest = "a".repeat(64);
const safeDockerfile = `
FROM node@sha256:${digest} AS build
COPY package.json pnpm-lock.yaml ./
COPY apps/reconciliation-worker/src apps/reconciliation-worker/src
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN node --version
FROM gcr.io/distroless/nodejs26-debian13@sha256:${digest} AS runtime
ENV RENAVE_RECONCILIATION_WORKER_ENABLED=false
ENV RENAVE_RECONCILIATION_WORKER_DRY_RUN=true
COPY --from=build /opt/runtime/ ./
USER 10001:10001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s CMD ["/nodejs/bin/node","dist/health-probe.js","ready"]
ENTRYPOINT ["/nodejs/bin/node","dist/main.js"]
`;

const safeManifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reconciliation-worker
spec:
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: reconciliation-worker
          image: registry.example/seu-renave/reconciliation-worker@sha256:${digest}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          startupProbe:
            exec:
              command:
                - /nodejs/bin/node
                - dist/health-probe.js
                - health
          livenessProbe:
            exec:
              command:
                - /nodejs/bin/node
                - dist/health-probe.js
                - health
          readinessProbe:
            exec:
              command:
                - /nodejs/bin/node
                - dist/health-probe.js
                - ready
`;

const safeWorkflow = `
permissions:
  contents: read
jobs:
  reconciliation-worker-image-smoke:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/check-reconciliation-worker-release.mjs
      - run: docker build --tag seu-renave/reconciliation-worker:ci --file apps/reconciliation-worker/Dockerfile .
      - run: docker image inspect seu-renave/reconciliation-worker:ci
      - run: docker history --no-trunc seu-renave/reconciliation-worker:ci
      - run: docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges seu-renave/reconciliation-worker:ci
      - run: docker export worker > rootfs.tar
      - run: rg 'bin/(?:sh|bash).*corepack' rootfs-files.txt
      - run: 'test "$(docker logs worker)" = ''{"component":"renave-reconciliation-worker","event":"disabled"}'''
      - if: always()
        run: docker rm --force worker
`;

function ids(issues) {
  return issues.map(({ id }) => id);
}

describe("guard do pruning runtime", () => {
  const safe = `
const operationWorkerDbFiles = new Set(["tenant-runtime.js"]);
await assertRuntimeEsmImports(root);
`;

  it("exige contrato tenant mínimo e valida o grafo ESM", () => {
    assert.deepEqual(checkRuntimePreparation(safe), []);
    const found = ids(
      checkRuntimePreparation("const operationWorkerDbFiles = new Set([]);"),
    );
    assert.ok(found.includes("WORKER_TENANT_RUNTIME_REQUIRED"));
    assert.ok(found.includes("WORKER_RUNTIME_IMPORT_GRAPH_REQUIRED"));
  });

  it("recusa carregar a superfície ampla da API", () => {
    assert.ok(
      ids(checkRuntimePreparation(`${safe}\n"api-runtime.js"`)).includes(
        "WORKER_API_RUNTIME_FORBIDDEN",
      ),
    );
  });
});

describe("guard do Dockerfile", () => {
  it("aceita imagem multi-stage pinada e runtime mínimo", () => {
    assert.deepEqual(checkDockerfile(safeDockerfile), []);
  });

  it("recusa bases mutáveis, root, shell e ausência de sinais/probe", () => {
    const unsafe = `FROM node:26 AS build\nFROM node:26\nUSER root\nENTRYPOINT ["sh","-c","node dist/main.js"]`;
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("DOCKER_BASE_DIGEST_REQUIRED"));
    assert.ok(found.includes("DOCKER_NUMERIC_NON_ROOT_REQUIRED"));
    assert.ok(found.includes("DOCKER_DIRECT_NODE_ENTRYPOINT_REQUIRED"));
    assert.ok(found.includes("DOCKER_SIGTERM_REQUIRED"));
    assert.ok(found.includes("DOCKER_INTERNAL_HEALTHCHECK_REQUIRED"));
    assert.ok(found.includes("DOCKER_DISTROLESS_NODE26_RUNTIME_REQUIRED"));
  });

  it("recusa runtime Node completo mesmo quando pinado", () => {
    const unsafe = safeDockerfile.replace(
      `gcr.io/distroless/nodejs26-debian13@sha256:${digest}`,
      `node:26-bookworm-slim@sha256:${digest}`,
    );
    assert.ok(
      ids(checkDockerfile(unsafe)).includes(
        "DOCKER_DISTROLESS_NODE26_RUNTIME_REQUIRED",
      ),
    );
  });

  it("exige node por caminho absoluto no entrypoint e healthcheck", () => {
    const unsafe = safeDockerfile.replaceAll('"/nodejs/bin/node"', '"node"');
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("DOCKER_DIRECT_NODE_ENTRYPOINT_REQUIRED"));
    assert.ok(found.includes("DOCKER_INTERNAL_HEALTHCHECK_REQUIRED"));
  });

  it("exige instalação transitiva sem lifecycle scripts", () => {
    const unsafe = safeDockerfile.replace(" --ignore-scripts", "");
    assert.ok(
      ids(checkDockerfile(unsafe)).includes(
        "DOCKER_PNPM_IGNORE_SCRIPTS_REQUIRED",
      ),
    );
  });

  it("recusa COPY amplo/segredo/ADD e source/test no runtime", () => {
    const unsafe = safeDockerfile.replace(
      "COPY --from=build /opt/runtime/ ./",
      "COPY . .\nCOPY .env ./\nADD private.key ./\nCOPY apps/reconciliation-worker/src ./src\nCOPY worker.test.js ./",
    );
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("DOCKER_BROAD_COPY_FORBIDDEN"));
    assert.ok(found.includes("DOCKER_SECRET_COPY_FORBIDDEN"));
    assert.ok(found.includes("DOCKER_ADD_FORBIDDEN"));
    assert.ok(found.includes("DOCKER_RUNTIME_SOURCE_COPY_FORBIDDEN"));
  });

  it("permite fontes explícitas apenas no builder", () => {
    assert.equal(
      ids(checkDockerfile(safeDockerfile)).includes(
        "DOCKER_RUNTIME_SOURCE_COPY_FORBIDDEN",
      ),
      false,
    );
  });

  it("recusa COPY fora das allowlists do builder e runtime", () => {
    const unsafe = safeDockerfile
      .replace(
        "COPY package.json pnpm-lock.yaml ./",
        "COPY package.json unexpected.conf ./",
      )
      .replace(
        "COPY --from=build /opt/runtime/ ./",
        "COPY --from=build /workspace/dist ./",
      );
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("DOCKER_BUILDER_COPY_NOT_ALLOWLISTED"));
    assert.ok(found.includes("DOCKER_RUNTIME_COPY_NOT_ALLOWLISTED"));
  });

  it("recusa secret raw e defaults operacionais inseguros", () => {
    const unsafe = safeDockerfile
      .replace("WORKER_ENABLED=false", "WORKER_ENABLED=true")
      .replace("WORKER_DRY_RUN=true", "WORKER_DRY_RUN=false")
      .replace(
        "ENV RENAVE_RECONCILIATION_WORKER_DRY_RUN=false",
        "ENV RENAVE_RECONCILIATION_WORKER_DRY_RUN=false RENAVE_RECONCILIATION_DATABASE_URL=postgres://secret",
      );
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("DOCKER_DISABLED_DEFAULT_REQUIRED"));
    assert.ok(found.includes("DOCKER_DRY_RUN_DEFAULT_REQUIRED"));
    assert.ok(found.includes("DOCKER_RAW_SECRET_ENV_FORBIDDEN"));
  });
});

describe("guard de contexto e manifesto", () => {
  it("exige exclusões de credenciais, dependências e testes", () => {
    const safe = [
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
    ].join("\n");
    assert.deepEqual(checkDockerignore(safe), []);
    assert.ok(checkDockerignore(".git\n").length > 0);
    assert.ok(
      ids(
        checkDockerignore(`${safe}\n!packages/example/database-url`),
      ).includes("DOCKERIGNORE_SECRET_RULE_NOT_FINAL"),
    );
  });

  it("aceita manifesto non-root/read-only com probe interno", () => {
    assert.deepEqual(checkManifest(safeManifest), []);
  });

  it("recusa node relativo nos probes de startup, liveness e readiness", () => {
    const found = ids(
      checkManifest(safeManifest.replaceAll("/nodejs/bin/node", "node")),
    );
    assert.ok(found.includes("MANIFEST_ABSOLUTE_STARTUP_REQUIRED"));
    assert.ok(found.includes("MANIFEST_ABSOLUTE_LIVENESS_REQUIRED"));
    assert.ok(found.includes("MANIFEST_ABSOLUTE_READINESS_REQUIRED"));
  });

  it("exige imagem imutável por digest em Deployment e Job", () => {
    const tagged = safeManifest.replace(`@sha256:${digest}`, ":latest");
    const missing = safeManifest.replace(/^\s*image:.*$/mu, "");
    const secondWithoutImage = safeManifest.replace(
      "          securityContext:",
      "        - name: sidecar\n          securityContext:",
    );
    for (const unsafe of [tagged, missing, secondWithoutImage]) {
      assert.ok(
        ids(checkManifest(unsafe)).includes("MANIFEST_IMAGE_DIGEST_REQUIRED"),
      );
      assert.ok(
        ids(
          checkManifest(unsafe.replace("kind: Deployment", "kind: Job")),
        ).includes("MANIFEST_IMAGE_DIGEST_REQUIRED"),
      );
    }
  });

  it("recusa privilégio, exposição e secret raw", () => {
    const unsafe = `${safeManifest}\nprivileged: true\nhostNetwork: true\ntype: LoadBalancer\n- name: RENAVE_RECONCILIATION_DATABASE_URL`;
    const found = ids(checkManifest(unsafe));
    assert.ok(found.includes("MANIFEST_PRIVILEGED_FORBIDDEN"));
    assert.ok(found.includes("MANIFEST_HOST_NETWORK_FORBIDDEN"));
    assert.ok(found.includes("MANIFEST_EXTERNAL_SERVICE_FORBIDDEN"));
    assert.ok(found.includes("MANIFEST_RAW_SECRET_ENV_FORBIDDEN"));
  });

  it("não exige PodSpec em recursos auxiliares, patch ou Job dry-run", () => {
    assert.deepEqual(
      checkManifest(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: reconciliation-worker\n",
        "deploy/reconciliation-worker/base/configmap.yaml",
      ),
      [],
    );
    assert.deepEqual(
      checkManifest(
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: reconciliation-worker\n",
        "deploy/reconciliation-worker/overlays/canary/deployment-live-patch.yaml",
      ),
      [],
    );
    const dryRunJob = safeManifest
      .replace("kind: Deployment", "kind: Job")
      .replace(/\s+readinessProbe:[\s\S]*$/u, "\n");
    assert.deepEqual(
      checkManifest(
        dryRunJob,
        "deploy/reconciliation-worker/overlays/dry-run/job.yaml",
      ),
      [],
    );
  });
});

describe("guard do workflow", () => {
  it("aceita build/smoke locais com cleanup", () => {
    assert.deepEqual(checkWorkflow(safeWorkflow), []);
  });

  for (const [addition, expected] of [
    ["id-token: write", "WORKFLOW_OIDC_WRITE_FORBIDDEN"],
    ["packages: write", "WORKFLOW_PACKAGES_WRITE_FORBIDDEN"],
    ["run: docker push registry/image", "WORKFLOW_IMAGE_PUSH_FORBIDDEN"],
    ["run: docker buildx build --push .", "WORKFLOW_IMAGE_PUSH_FORBIDDEN"],
    ["run: kubectl apply -f manifest", "WORKFLOW_DEPLOY_COMMAND_FORBIDDEN"],
    ["run: railway up", "WORKFLOW_DEPLOY_COMMAND_FORBIDDEN"],
    ["run: ssh host command", "WORKFLOW_REMOTE_COMMAND_FORBIDDEN"],
    [
      "uses: docker/login-action@digest",
      "WORKFLOW_REGISTRY_OR_CLOUD_LOGIN_FORBIDDEN",
    ],
  ]) {
    it(`recusa capacidade externa ${addition}`, () => {
      assert.ok(
        ids(checkWorkflow(`${safeWorkflow}\n${addition}`)).includes(expected),
      );
    });
  }
});
