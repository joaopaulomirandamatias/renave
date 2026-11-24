import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkDockerfile,
  checkDockerignore,
  checkManifest,
  checkRuntimePreparation,
  checkWorkflow,
} from "./check-operation-promoter-release.mjs";

const digest = "a".repeat(64);
const syftDigest =
  "00a4400827744854ef77b10679e38f991bf74fd20e3f03ffada8d6ee492520c3";

const safeDockerfile = `
FROM node:26.13.1-bookworm-slim@sha256:${digest} AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/operation-promoter ./apps/operation-promoter
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @seu-renave/operation-promoter-app build
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:${digest} AS runtime
ENV NODE_ENV=production
COPY --from=build /opt/runtime/ ./
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/nodejs/bin/node","dist/main.js"]
`;

const safeDockerignore = [
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
].join("\n");

const safeJob = `
apiVersion: batch/v1
kind: Job
metadata:
  name: operation-promoter
spec:
  backoffLimit: 0
  completions: 1
  parallelism: 1
  template:
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: operation-promoter
          image: registry.example/operation-promoter@sha256:${digest}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: inputs
              mountPath: /run/secrets/seu-renave/operation-promoter
              readOnly: true
      volumes:
        - name: inputs
          secret:
            secretName: operation-promoter-inputs
`;

const safeNetworkPolicy = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: operation-promoter-db-only
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: operation-promoter
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 192.0.2.10/32
      ports:
        - protocol: TCP
          port: 5432
`;

const safeWorkflow = `
permissions:
  contents: read
jobs:
  operation-promoter-image-smoke:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@${"b".repeat(40)}
        with:
          persist-credentials: false
      - name: Validate release policy
        run: node scripts/check-operation-promoter-release.mjs
      - name: Build local promoter image
        run: docker build --tag seu-renave/operation-promoter:ci --file apps/operation-promoter/Dockerfile .
      - name: Inspect immutable runtime
        run: |
          docker image inspect seu-renave/operation-promoter:ci
          docker history --no-trunc seu-renave/operation-promoter:ci
          docker create --name operation-promoter-rootfs seu-renave/operation-promoter:ci
          docker export operation-promoter-rootfs --output /tmp/operation-promoter-rootfs.tar
          rg 'renave-connector|api-runtime.js|operation-worker.js|migrate.js|bootstrap.js' /tmp/operation-promoter-files.txt
      - name: Generate and validate promoter SBOM
        run: |
          syft_image='ghcr.io/anchore/syft:v1.57.2-nonroot@sha256:${syftDigest}'
          docker save seu-renave/operation-promoter:ci --output /tmp/operation-promoter-image.tar
          docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --env SYFT_CHECK_FOR_APP_UPDATE=false --volume /tmp/operation-promoter-image.tar:/scan/image.tar:ro "$syft_image" scan docker-archive:/scan/image.tar --output cyclonedx-json > /tmp/operation-promoter-sbom.cdx.json
          node scripts/check-image-sbom.mjs /tmp/operation-promoter-sbom.cdx.json
      - name: Run fail-closed image without mounts
        run: |
          set +e
          docker run --name operation-promoter-smoke --network none --read-only --cap-drop ALL --security-opt no-new-privileges seu-renave/operation-promoter:ci > /tmp/operation-promoter-stdout 2> /tmp/operation-promoter-stderr
          status="$?"
          set -e
          test "$status" -eq 1
          test ! -s /tmp/operation-promoter-stdout
          test "$(cat /tmp/operation-promoter-stderr)" = '{"schemaVersion":1,"job":"operation-promoter","errorCode":"OPERATION_PROMOTER_CONFIG_INVALID","outcome":"failed"}'
      - name: Cleanup
        if: always()
        run: docker rm --force operation-promoter-smoke operation-promoter-rootfs
`;

function ids(issues) {
  return issues.map(({ id }) => id);
}

describe("guard do Dockerfile do operation promoter", () => {
  it("aceita builder pinado e runtime distroless one-shot", () => {
    assert.deepEqual(checkDockerfile(safeDockerfile), []);
  });

  it("recusa base mutável, root, shell, CMD e ausência de SIGTERM", () => {
    const unsafe = `FROM node:26 AS build\nFROM node:26\nUSER root\nCMD ["--help"]\nENTRYPOINT ["sh","-c","node dist/main.js"]`;
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("PROMOTER_DOCKER_BASE_DIGEST_REQUIRED"));
    assert.ok(found.includes("PROMOTER_DOCKER_DISTROLESS_NONROOT_REQUIRED"));
    assert.ok(found.includes("PROMOTER_DOCKER_NUMERIC_NONROOT_REQUIRED"));
    assert.ok(found.includes("PROMOTER_DOCKER_DIRECT_ENTRYPOINT_REQUIRED"));
    assert.ok(found.includes("PROMOTER_DOCKER_CMD_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_DOCKER_SIGTERM_REQUIRED"));
  });

  it("recusa segredo, ADD, COPY amplo e fonte no runtime", () => {
    const unsafe = safeDockerfile.replace(
      "COPY --from=build /opt/runtime/ ./",
      "ENV DATABASE_URL=postgres://secret\nADD private.key ./\nCOPY private.pem ./\nCOPY . .\nCOPY src ./src",
    );
    const found = ids(checkDockerfile(unsafe));
    assert.ok(found.includes("PROMOTER_DOCKER_SECRET_ENV_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_DOCKER_ADD_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_DOCKER_SECRET_COPY_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_DOCKER_BROAD_COPY_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_DOCKER_RUNTIME_SOURCE_FORBIDDEN"));
  });
});

describe("guard do contexto e closure runtime", () => {
  it("aceita exclusões completas e recusa re-inclusão posterior", () => {
    assert.deepEqual(checkDockerignore(safeDockerignore), []);
    assert.ok(
      ids(
        checkDockerignore(`${safeDockerignore}\n!secrets/target.json`),
      ).includes("PROMOTER_DOCKERIGNORE_SECRET_RULE_NOT_FINAL"),
    );
  });

  it("exige closure mínima e validação do grafo ESM", () => {
    const safe = `
const dbFiles = new Set(["config.js", "operation-promoter.js", "operations.js", "runtime-guard.js", "tenant-context.js"]);
const packages = new Set(["@seu-renave/db", "@seu-renave/operation-promoter-app", "@seu-renave/operation-promotion-decision"]);
await Promise.all(["access-control", "identity"].map(remove));
await assertRuntimeEsmImports(root);
`;
    assert.deepEqual(checkRuntimePreparation(safe), []);
    const found = ids(
      checkRuntimePreparation(safe.replace('"operation-promoter.js", ', "")),
    );
    assert.ok(found.includes("PROMOTER_RUNTIME_DB_ALLOWLIST_INCOMPLETE"));
    assert.ok(
      ids(checkRuntimePreparation(`${safe}\n"api-runtime.js"`)).includes(
        "PROMOTER_RUNTIME_FORBIDDEN_CLOSURE_MEMBER",
      ),
    );
  });
});

describe("guard dos manifests", () => {
  it("aceita Job one-shot endurecido e NetworkPolicy PostgreSQL-only", () => {
    assert.deepEqual(checkManifest(safeJob), []);
    assert.deepEqual(checkManifest(safeNetworkPolicy), []);
  });

  it("aceita deny-all, DNS kube-system fechado e PostgreSQL IPv4 /32", () => {
    const policies = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dns
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 192.0.2.10/32
      ports:
        - port: 5432
          protocol: TCP
`;
    assert.deepEqual(checkManifest(policies), []);
  });

  it("recusa workload recorrente, retry, probe e segredo em env", () => {
    const unsafe = safeJob
      .replace("kind: Job", "kind: CronJob")
      .replace("backoffLimit: 0", "backoffLimit: 3")
      .replace("restartPolicy: Never", "restartPolicy: OnFailure")
      .replace(
        "      containers:",
        "      readinessProbe: {}\n      containers:",
      )
      .replace(
        "          volumeMounts:",
        "          env:\n            - name: DATABASE_URL\n              value: postgres://secret\n          volumeMounts:",
      );
    const found = ids(checkManifest(unsafe));
    assert.ok(found.includes("PROMOTER_MANIFEST_ONE_SHOT_JOB_REQUIRED"));
    assert.ok(found.includes("PROMOTER_MANIFEST_SECRET_ENV_FORBIDDEN"));
  });

  it("recusa egress por IP, porta web, UDP e regra aberta", () => {
    const unsafe = safeNetworkPolicy
      .replace("cidr: 192.0.2.10/32", "cidr: 0.0.0.0/0")
      .replace("protocol: TCP", "protocol: UDP")
      .replace("port: 5432", "port: 443")
      .replace("  egress:", "  egress:\n    - {}\n");
    const found = ids(checkManifest(unsafe));
    assert.ok(
      found.includes("PROMOTER_NETWORK_POLICY_EXACT_DB_TARGET_REQUIRED"),
    );
    assert.ok(found.includes("PROMOTER_NETWORK_POLICY_OPEN_CIDR_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_NETWORK_POLICY_OPEN_RULE_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_NETWORK_POLICY_DB_ONLY_REQUIRED"));
  });

  it("recusa DNS fora dos selectors fechados e CIDR de banco mais amplo", () => {
    const unsafeDns = `
kind: NetworkPolicy
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
        - port: 443
          protocol: TCP
`;
    const unsafeDb = `
kind: NetworkPolicy
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.0.0.0/24
      ports:
        - port: 5432
          protocol: TCP
`;
    assert.ok(
      ids(checkManifest(unsafeDns)).includes(
        "PROMOTER_NETWORK_POLICY_DNS_SELECTOR_REQUIRED",
      ),
    );
    assert.ok(
      ids(checkManifest(unsafeDb)).includes(
        "PROMOTER_NETWORK_POLICY_EXACT_DB_TARGET_REQUIRED",
      ),
    );
  });

  it("recusa selector de namespace ou pod como destino do banco", () => {
    for (const target of [
      `namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: database`,
      `podSelector:
            matchLabels:
              app.kubernetes.io/name: postgres`,
    ]) {
      const unsafe = `
kind: NetworkPolicy
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - ${target}
      ports:
        - port: 5432
          protocol: TCP
`;
      assert.ok(
        ids(checkManifest(unsafe)).includes(
          "PROMOTER_NETWORK_POLICY_EXACT_DB_TARGET_REQUIRED",
        ),
      );
    }
  });
});

describe("guard do job de imagem no CI", () => {
  it("aceita build local, inspeção, SBOM pinado e smoke sem mounts", () => {
    assert.deepEqual(checkWorkflow(safeWorkflow), []);
  });

  it("recusa mount/env no smoke e scanner mutável com rede", () => {
    const unsafe = safeWorkflow
      .replace(
        "docker run --name operation-promoter-smoke --network none --read-only",
        "docker run --name operation-promoter-smoke --network bridge --volume /tmp/secrets:/run/secrets --env DATABASE_URL=x --read-only",
      )
      .replace(`syft:v1.57.2-nonroot@sha256:${syftDigest}`, "syft:latest");
    const found = ids(checkWorkflow(unsafe));
    assert.ok(found.includes("PROMOTER_WORKFLOW_SMOKE_MOUNT_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_WORKFLOW_SMOKE_ENV_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_WORKFLOW_SYFT_PIN_REQUIRED"));
  });

  it("recusa publicação e login em registry", () => {
    const unsafe = safeWorkflow.replace(
      "docker image inspect",
      "docker push registry.example/image\n          docker/login-action@v3\n          docker image inspect",
    );
    const found = ids(checkWorkflow(unsafe));
    assert.ok(found.includes("PROMOTER_WORKFLOW_PUSH_FORBIDDEN"));
    assert.ok(found.includes("PROMOTER_WORKFLOW_LOGIN_FORBIDDEN"));
  });
});
