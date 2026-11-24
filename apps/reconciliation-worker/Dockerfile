FROM node:26.13.1-bookworm-slim@sha256:18a166e2d50578afe933434857ed2d9059bd1aa398a223e9c89eb4302354f079 AS build

WORKDIR /workspace
RUN npm install --global --ignore-scripts pnpm@9.15.9 \
    && test "$(pnpm --version)" = "9.15.9"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/reconciliation-worker ./apps/reconciliation-worker
COPY packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @seu-renave/reconciliation-worker-app... build
RUN pnpm --filter @seu-renave/reconciliation-worker-app deploy --prod /opt/runtime \
    && node apps/reconciliation-worker/scripts/prepare-runtime.mjs /opt/runtime \
    && find /opt/runtime -type d -exec chmod 0555 {} + \
    && find /opt/runtime -type f -exec chmod 0444 {} +

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7 AS runtime

ENV NODE_ENV=production \
    RENAVE_RECONCILIATION_WORKER_ENABLED=false \
    RENAVE_RECONCILIATION_WORKER_DRY_RUN=true

WORKDIR /app
COPY --from=build --chown=0:0 /opt/runtime/ ./

USER 10001:10001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/health-probe.js", "ready"]
ENTRYPOINT ["/nodejs/bin/node", "dist/main.js"]
