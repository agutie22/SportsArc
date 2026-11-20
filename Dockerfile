# syntax=docker/dockerfile:1.7
#
# SportsArc API image. The API also serves the frontend (frontend/ is static,
# no build step), and TypeScript runs through tsx exactly as `pnpm dev` does.
#
# The same image runs the one-off migration job:
#   node --import=tsx node_modules/@mikro-orm/cli/cli.js migration:up --config ./mikro-orm.config.ts
# which is `pnpm migration:up` without the `--env-file=.env` flag (the
# container gets its environment from compose, not from a file).
#
# Build: docker build -t sportsarc:dev .

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.0

# ── deps: install from the lockfile, nothing else ──────────────────────
# Only the manifest and lockfile are copied, so this layer is reused until
# the dependencies change. Dev dependencies are kept on purpose: the
# migration job needs @mikro-orm/cli, which is a devDependency.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ARG PNPM_VERSION
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem .
# Nothing from it is kept in the image.
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=sportsarc-pnpm-store,target=/pnpm-store \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && pnpm install --frozen-lockfile --store-dir /pnpm-store --package-import-method copy \
 && rm -rf /root/.cache /root/.local/share/pnpm

# ── runtime ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json mikro-orm.config.ts ./
COPY api ./api
COPY frontend ./frontend

# data/uploads is where api/social/uploads.ts writes; compose mounts a shared volume
# there. Creating it owned by `node` means a fresh named volume inherits that
# owner. api/migrations stays root-owned: MikroORM's snapshot rewrite after
# `migration:up` is skipped silently on a read-only path.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/4444Studios/SportsArc" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.description="SportsArc API and frontend"

USER node
EXPOSE 3000

# /health answers without touching the database; it proves the process is
# listening, which only happens after Postgres connected at boot.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--import=tsx", "api/server.ts"]
