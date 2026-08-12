# =============================================================================
# soundspan Backend Dockerfile
# =============================================================================
# Targets:
# - api-runtime (default): compiled backend API runtime (JS + migrations entrypoint)
# - worker-runtime: slim worker runtime (compiled JS + production dependencies)
# =============================================================================

# Stage 1: Full dependencies for build
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS deps

WORKDIR /app

# Inject monorepo contract package into /packages so file:../packages/* links resolve.
COPY --from=media-metadata-contract . /packages/media-metadata-contract

# Copy dependency manifests first for better layer caching
COPY package*.json ./
COPY prisma ./prisma/
# Prisma 7 CLI reads schema/migrations/datasource config from prisma.config.ts
COPY prisma.config.ts ./
COPY databaseUrl.js ./

# Install all deps (includes dev deps needed for tsx/prisma CLI)
RUN npm ci && \
    npm cache clean --force

# Build local contract package expected by backend imports.
RUN npx tsc -p /packages/media-metadata-contract/tsconfig.json

# Generate Prisma client once against repo schema
RUN npx prisma generate

# Stage 2: Build TypeScript output for runtime stages
FROM deps AS build

# Copy source and build
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# Stage 3: Prune to production dependencies for slim worker image
FROM build AS worker-deps
RUN npm prune --omit=dev && npm cache clean --force

# Stage 4: Slim worker runtime (compiled JS + prod deps)
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS worker-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy minimal runtime artifacts
COPY --from=worker-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=worker-deps --chown=node:node /app/package*.json ./
COPY --from=worker-deps --chown=node:node /app/prisma ./prisma
COPY --from=worker-deps --chown=node:node /app/dist ./dist
COPY --from=worker-deps --chown=node:node /app/databaseUrl.js ./databaseUrl.js
COPY --from=worker-deps --chown=node:node /packages/media-metadata-contract /packages/media-metadata-contract

# Create writable runtime dirs and harden image
RUN mkdir -p /app/cache /app/logs && \
    chown -R node:node /app/cache /app/logs && \
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/worker.js"]

# Stage: prune to prod deps but keep a working Prisma CLI for the entrypoint's
# `npx prisma migrate deploy`. Prisma 7's prisma.config.ts imports
# "prisma/config", which must resolve from the app's own node_modules, so the
# CLI is reinstalled locally after prune (a global CLI cannot satisfy it).
FROM build AS api-deps
RUN PRISMA_VERSION=$(node -p "require('./node_modules/prisma/package.json').version") && \
    npm prune --omit=dev && \
    npm install --no-save prisma@"$PRISMA_VERSION" && \
    npm cache clean --force

# Stage 5: API runtime (compiled JS + migrations entrypoint; default backend target)
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS api-runtime

WORKDIR /app

# ffmpeg is required by API runtime (transcoding/audio paths).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    openssl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=api-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=api-deps --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/databaseUrl.js ./databaseUrl.js
COPY --from=build --chown=node:node /packages/media-metadata-contract /packages/media-metadata-contract

# Healthcheck + entrypoint
COPY --chown=node:node healthcheck.js ./
COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /app/cache/covers /app/cache/transcodes /app/logs && \
    chown -R node:node /app/cache /app/logs && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true

USER node

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
