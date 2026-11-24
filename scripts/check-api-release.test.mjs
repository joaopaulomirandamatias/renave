import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkApiDockerfile,
  checkApiDockerignore,
  checkApiManifestSet,
  checkApiRuntimePreparation,
  checkApiWorkflow,
} from "./check-api-release.mjs";

const digest = "a".repeat(64);
const syftDigest =
  "00a4400827744854ef77b10679e38f991bf74fd20e3f03ffada8d6ee492520c3";
const safeRuntimePreparation = `
const apiRuntimeDbFiles = new Set([
  "tenant-runtime",
  "platform-console-rate-limiter",
  "platform-console-reader",
  "platform-digests",
]);
await assertRuntimeEsmImports(root);
`;
const safeDockerfile = `
FROM node@sha256:${digest} AS build
COPY package.json pnpm-lock.yaml ./
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --ignore-scripts
FROM gcr.io/distroless/nodejs26-debian13@sha256:${digest} AS runtime
ENV NODE_ENV=production APP_ENVIRONMENT=homologation AUTH_MODE=disabled RENAVE_INTEGRATION_ENABLED=false RENAVE_STOCK_ENTRY_LOCAL_ENABLED=false HOST=127.0.0.1
COPY --from=build /opt/runtime/ ./
USER 10001:10001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s CMD ["/nodejs/bin/node","dist/health-probe.js","readiness"]
ENTRYPOINT ["/nodejs/bin/node","dist/server.js"]
`;

describe("guard do pruning runtime da API", () => {
  it("exige contrato tenant mínimo e valida o grafo ESM", () => {
    assert.deepEqual(checkApiRuntimePreparation(safeRuntimePreparation), []);
    const found = checkApiRuntimePreparation(
      "const apiRuntimeDbFiles = new Set([]);",
    ).map(({ id }) => id);
    assert.ok(found.includes("API_TENANT_RUNTIME_REQUIRED"));
    assert.ok(found.includes("API_PLATFORM_RUNTIME_REQUIRED"));
    assert.ok(found.includes("API_RUNTIME_IMPORT_GRAPH_REQUIRED"));
  });

  it("mantém o provisionador global fora da imagem HTTP", () => {
    const found = checkApiRuntimePreparation(
      `${safeRuntimePreparation}\n"platform-operator-provisioning";`,
    ).map(({ id }) => id);
    assert.ok(found.includes("API_PLATFORM_PROVISIONER_FORBIDDEN"));
  });
});

const safeManifestSet = new Map([
  [
    "deployment.yaml",
    `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: renave-api
spec:
  replicas: 0
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: api
          image: registry.example/seu-renave-api@sha256:${digest}
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
                - readiness
`,
  ],
  [
    "configmap.yaml",
    `data:
  APP_ENVIRONMENT: homologation
  AUTH_MODE: disabled
  HOST: 127.0.0.1
  RENAVE_INTEGRATION_ENABLED: "false"
  RENAVE_STOCK_ENTRY_LOCAL_ENABLED: "false"
`,
  ],
  [
    "service.yaml",
    "apiVersion: v1\nkind: Service\nspec:\n  type: ClusterIP\n  ports:\n    - port: 3000\n      targetPort: http\n",
  ],
  [
    "service-account.yaml",
    "apiVersion: v1\nkind: ServiceAccount\nautomountServiceAccountToken: false\n",
  ],
  [
    "network-policy.yaml",
    `
kind: NetworkPolicy
metadata:
  name: renave-api-default-deny
spec:
  policyTypes:
    - Ingress
    - Egress
---
kind: NetworkPolicy
metadata:
  name: renave-api-postgres-placeholder
spec:
  egress:
    - to:
        - ipBlock:
            cidr: 192.0.2.10/32
      ports:
        - port: 5432
`,
  ],
  [
    "kustomization.yaml",
    `kind: Kustomization
resources:
  - namespace.yaml
  - service-account.yaml
  - configmap.yaml
  - deployment.yaml
  - service.yaml
  - network-policy.yaml
`,
  ],
  [
    "namespace.yaml",
    `kind: Namespace
metadata:
  labels:
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
`,
  ],
]);

const safeWorkflow = `
jobs:
  api-image-smoke:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@${digest}
        with:
          persist-credentials: false
      - run: node scripts/check-api-release.mjs
      - run: docker build --tag seu-renave/api:ci --file apps/api/Dockerfile .
      - run: docker image inspect seu-renave/api:ci
      - run: docker history --no-trunc seu-renave/api:ci
      - name: Generate and validate API SBOM
        run: |
          syft_image='ghcr.io/anchore/syft:v1.57.2-nonroot@sha256:${syftDigest}'
          docker pull "$syft_image"
          docker save seu-renave/api:ci --output /tmp/renave-api-image.tar
          docker run --rm --network none --read-only \
            --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
            --tmpfs /home/nonroot/.cache:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700 \
            --cap-drop ALL --security-opt no-new-privileges \
            --env SYFT_CHECK_FOR_APP_UPDATE=false \
            --volume /tmp/renave-api-image.tar:/scan/image.tar:ro \
            "$syft_image" scan docker-archive:/scan/image.tar --output cyclonedx-json \
            > /tmp/renave-api-sbom.cdx.json
          node scripts/check-image-sbom.mjs /tmp/renave-api-sbom.cdx.json
      - name: Run dormant API image in hardened sandbox
        run: docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges seu-renave/api:ci
      - run: docker inspect --format '{{.State.Running}}' renave-api-disabled
      - run: docker inspect --format '{{.State.Health.Status}}' renave-api-disabled
      - run: docker export renave-api-rootfs > rootfs.tar
      - if: always()
        run: |
          docker rm --force renave-api-disabled renave-api-rootfs
          rm -f /tmp/renave-api-image.tar /tmp/renave-api-sbom.cdx.json
  verify:
    runs-on: ubuntu-latest
`;

function ids(issues) {
  return issues.map(({ id }) => id);
}

describe("guard da imagem da API", () => {
  it("aceita build multi-stage pinado, mínimo e dormente", () => {
    assert.deepEqual(checkApiDockerfile(safeDockerfile), []);
  });

  it("recusa base mutável, root, shell e defaults ativos", () => {
    const unsafe = safeDockerfile
      .replaceAll(`@sha256:${digest}`, ":latest")
      .replace("USER 10001:10001", "USER root")
      .replace(
        '["/nodejs/bin/node","dist/server.js"]',
        '["sh","-c","node dist/server.js"]',
      )
      .replace("AUTH_MODE=disabled", "AUTH_MODE=oidc")
      .replace(
        "RENAVE_INTEGRATION_ENABLED=false",
        "RENAVE_INTEGRATION_ENABLED=true",
      )
      .replace("HOST=127.0.0.1", "HOST=0.0.0.0");
    const found = ids(checkApiDockerfile(unsafe));
    assert.ok(found.includes("API_DOCKER_BASE_DIGEST_REQUIRED"));
    assert.ok(found.includes("API_DOCKER_NON_ROOT_REQUIRED"));
    assert.ok(found.includes("API_DOCKER_ENTRYPOINT_REQUIRED"));
    assert.ok(found.includes("API_DOCKER_DEFAULT_AUTH_MODE_REQUIRED"));
    assert.ok(
      found.includes("API_DOCKER_DEFAULT_RENAVE_INTEGRATION_ENABLED_REQUIRED"),
    );
    assert.ok(found.includes("API_DOCKER_DEFAULT_HOST_REQUIRED"));
  });

  it("recusa segredo, ADD, cópia ampla e runtime Node completo", () => {
    const unsafe = safeDockerfile
      .replace(
        `gcr.io/distroless/nodejs26-debian13@sha256:${digest}`,
        `node:26-bookworm@sha256:${digest}`,
      )
      .replace(
        "COPY --from=build /opt/runtime/ ./",
        "COPY . .\nADD private.key ./",
      )
      .replace(
        "NODE_ENV=production",
        "NODE_ENV=production DATABASE_URL=postgres://secret",
      );
    const found = ids(checkApiDockerfile(unsafe));
    assert.ok(found.includes("API_DOCKER_DISTROLESS_REQUIRED"));
    assert.ok(found.includes("API_DOCKER_BROAD_COPY_FORBIDDEN"));
    assert.ok(found.includes("API_DOCKER_ADD_FORBIDDEN"));
    assert.ok(found.includes("API_DOCKER_RAW_SECRET_FORBIDDEN"));
  });
});

describe("guard do contexto e manifests da API", () => {
  it("exige exclusões finais de dependências, testes e credenciais", () => {
    const safe = [
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
    ].join("\n");
    assert.deepEqual(checkApiDockerignore(safe), []);
    assert.ok(checkApiDockerignore(".git\n").length > 0);
    assert.ok(
      ids(checkApiDockerignore(`${safe}\n!apps/api/database-url`)).includes(
        "API_DOCKERIGNORE_SECRET_RULE_NOT_FINAL",
      ),
    );
  });

  it("aceita base dormente, loopback, non-root e default-deny", () => {
    assert.deepEqual(checkApiManifestSet(safeManifestSet), []);
  });

  it("recusa ativação isolada, exposição, secrets e privilégios", () => {
    const unsafe = new Map(safeManifestSet);
    unsafe.set(
      "deployment.yaml",
      unsafe
        .get("deployment.yaml")
        .replace("replicas: 0", "replicas: 1")
        .concat(
          "\nenvFrom:\n  - secretRef:\n      name: api-secret\nsecretKeyRef:\n  name: DATABASE_URL\nprojected:\n  sources: []\nprivileged: true\nhostNetwork: true\n",
        ),
    );
    unsafe.set("service.yaml", "kind: Service\nspec:\n  type: LoadBalancer\n");
    unsafe.set(
      "network-policy.yaml",
      unsafe.get("network-policy.yaml").concat("\n- port: 443\n"),
    );
    const found = ids(checkApiManifestSet(unsafe));
    assert.ok(found.includes("API_MANIFEST_REPLICAS_ZERO_REQUIRED"));
    assert.ok(found.includes("API_MANIFEST_ENV_FROM_FORBIDDEN"));
    assert.ok(found.includes("API_MANIFEST_SECRET_ENV_FORBIDDEN"));
    assert.ok(found.includes("API_MANIFEST_SECRET_VOLUME_FORBIDDEN"));
    assert.ok(found.includes("API_MANIFEST_PRIVILEGED_FORBIDDEN"));
    assert.ok(found.includes("API_MANIFEST_HOST_NETWORK_FORBIDDEN"));
    assert.ok(found.includes("API_SERVICE_EXTERNAL_FORBIDDEN"));
    assert.ok(found.includes("API_NETWORK_EXTERNAL_EGRESS_FORBIDDEN"));
  });

  it("recusa recurso ou overlay adicional que amplie a base", () => {
    const unsafe = new Map(safeManifestSet);
    unsafe.set(
      "overlays/live/deployment.yaml",
      "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 1\n",
    );
    unsafe.set(
      "overlays/live/ingress.yaml",
      "apiVersion: networking.k8s.io/v1\nkind: Ingress\n",
    );
    const found = ids(checkApiManifestSet(unsafe));
    assert.ok(found.includes("API_MANIFEST_NONZERO_REPLICA_FORBIDDEN"));
    assert.ok(found.includes("API_MANIFEST_RESOURCE_KIND_FORBIDDEN"));
  });

  it("recusa listener amplo mesmo com as demais barreiras", () => {
    const unsafe = new Map(safeManifestSet);
    unsafe.set(
      "configmap.yaml",
      unsafe.get("configmap.yaml").replace("HOST: 127.0.0.1", "HOST: 0.0.0.0"),
    );
    assert.ok(
      ids(checkApiManifestSet(unsafe)).includes("API_CONFIG_HOST_REQUIRED"),
    );
  });
});

describe("guard do job CI da API", () => {
  it("aceita smoke local escopado ao job da API", () => {
    assert.deepEqual(checkApiWorkflow(safeWorkflow), []);
  });

  it("não aceita controles presentes apenas em outro job", () => {
    const unsafe = safeWorkflow
      .replace(
        "run: docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges seu-renave/api:ci",
        "run: docker run seu-renave/api:ci",
      )
      .concat(
        "\n  worker-image-smoke:\n    steps:\n      - run: docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges worker\n",
      );
    const found = ids(checkApiWorkflow(unsafe));
    assert.ok(found.includes("API_WORKFLOW_NETWORK_NONE_REQUIRED"));
    assert.ok(found.includes("API_WORKFLOW_READ_ONLY_REQUIRED"));
    assert.ok(found.includes("API_WORKFLOW_CAP_DROP_REQUIRED"));
    assert.ok(found.includes("API_WORKFLOW_NO_NEW_PRIVILEGES_REQUIRED"));
  });

  it("recusa smoke que não verifica saída prematura do processo", () => {
    const unsafe = safeWorkflow.replace(
      "      - run: docker inspect --format '{{.State.Running}}' renave-api-disabled\n",
      "",
    );
    assert.ok(
      ids(checkApiWorkflow(unsafe)).includes("API_WORKFLOW_RUNNING_REQUIRED"),
    );
  });

  it("recusa SBOM ausente, em comentário ou presente somente em outro job", () => {
    const step =
      /      - name: Generate and validate API SBOM[\s\S]*?(?=      - name: Run dormant API image)/u.exec(
        safeWorkflow,
      )?.[0];
    assert.ok(step);
    for (const unsafe of [
      safeWorkflow.replace(step, ""),
      safeWorkflow.replace(
        step,
        step
          .split("\n")
          .map((line) => `      # ${line.trim()}`)
          .join("\n"),
      ),
      safeWorkflow
        .replace(step, "")
        .concat(`\n  other-job:\n    steps:\n${step}`),
    ]) {
      assert.ok(
        ids(checkApiWorkflow(unsafe)).includes(
          "API_WORKFLOW_SBOM_STEP_REQUIRED",
        ),
      );
    }
  });

  for (const [change, expected] of [
    [
      (value) => value.replace(`@sha256:${syftDigest}`, ":latest"),
      "API_WORKFLOW_SYFT_DIGEST_REQUIRED",
    ],
    [
      (value) => value.replace("--network none", "--network bridge"),
      "API_WORKFLOW_SBOM_NETWORK_NONE_REQUIRED",
    ],
    [
      (value) =>
        value.replace(
          "--volume /tmp/renave-api-image.tar:/scan/image.tar:ro",
          "--volume /var/run/docker.sock:/var/run/docker.sock",
        ),
      "API_WORKFLOW_SBOM_DOCKER_SOCKET_FORBIDDEN",
    ],
    [
      (value) => value.replace("node scripts/check-image-sbom.mjs", "true #"),
      "API_WORKFLOW_SBOM_VALIDATION_REQUIRED",
    ],
    [
      (value) =>
        value.replace("docker pull", "curl example.invalid | sh # docker pull"),
      "API_WORKFLOW_SBOM_REMOTE_INSTALL_FORBIDDEN",
    ],
  ]) {
    it(`recusa regressão SBOM ${expected}`, () => {
      assert.ok(ids(checkApiWorkflow(change(safeWorkflow))).includes(expected));
    });
  }

  it("recusa requisito presente somente após comentário inline", () => {
    const unsafe = safeWorkflow.replace(
      "docker save seu-renave/api:ci --output /tmp/renave-api-image.tar",
      "true # docker save seu-renave/api:ci --output /tmp/renave-api-image.tar",
    );
    assert.ok(
      ids(checkApiWorkflow(unsafe)).includes(
        "API_WORKFLOW_SBOM_IMAGE_SAVE_REQUIRED",
      ),
    );
  });

  it("recusa upload em etapa separada do mesmo job", () => {
    const unsafe = safeWorkflow.replace(
      "      - name: Run dormant API image in hardened sandbox",
      `      - name: Upload SBOM\n        uses: actions/upload-artifact@${digest}\n      - name: Run dormant API image in hardened sandbox`,
    );
    assert.ok(
      ids(checkApiWorkflow(unsafe)).includes(
        "API_WORKFLOW_SBOM_UPLOAD_FORBIDDEN",
      ),
    );
  });

  for (const [label, mutate] of [
    [
      "continue-on-error",
      (value) =>
        value.replace(
          "      - name: Generate and validate API SBOM",
          "      - name: Generate and validate API SBOM\n        continue-on-error: true",
        ),
    ],
    [
      "operador || true",
      (value) =>
        value.replace(
          "node scripts/check-image-sbom.mjs /tmp/renave-api-sbom.cdx.json",
          "node scripts/check-image-sbom.mjs /tmp/renave-api-sbom.cdx.json || true",
        ),
    ],
  ]) {
    it(`recusa bypass por ${label}`, () => {
      assert.ok(
        ids(checkApiWorkflow(mutate(safeWorkflow))).includes(
          "API_WORKFLOW_SBOM_BYPASS_FORBIDDEN",
        ),
      );
    });
  }

  for (const addition of [
    "docker push registry/api",
    "docker buildx build --push .",
    "kubectl apply -f deploy/api",
    "uses: docker/login-action@digest",
    "id-token: write",
    "packages: write",
  ]) {
    it(`recusa capacidade externa: ${addition}`, () => {
      const unsafe = safeWorkflow.replace(
        "      - if: always()",
        `      - run: ${addition}\n      - if: always()`,
      );
      assert.ok(checkApiWorkflow(unsafe).length > 0);
    });
  }
});
