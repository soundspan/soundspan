# =============================================================================
# soundspan Backend Dockerfile
# =============================================================================
# Targets:
# - api-runtime (default): full backend API runtime (tsx + migrations entrypoint)
# - worker-runtime: slim worker runtime (compiled JS + production dependencies)
# =============================================================================

# Stage 1: Full dependencies for build + API runtime
FROM node:20-slim AS deps

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./
COPY prisma ./prisma/

# Install all deps (includes dev deps needed for tsx/prisma CLI)
RUN npm ci && \
    npm cache clean --force

# Generate Prisma client once against repo schema
RUN npx prisma generate

# Stage 2: Build TypeScript output for worker-runtime
FROM deps AS build

# Copy source and build
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# Stage 3: Prune to production dependencies for slim worker image
FROM build AS worker-deps
RUN npm prune --omit=dev && npm cache clean --force

# Stage 4: Slim worker runtime (compiled JS + prod deps)
FROM node:20-slim AS worker-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy minimal runtime artifacts
COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=worker-deps /app/package*.json ./
COPY --from=worker-deps /app/prisma ./prisma
COPY --from=worker-deps /app/dist ./dist

# Create writable runtime dirs and harden image
RUN mkdir -p /app/cache /app/logs && \
    chown -R node:node /app && \
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/worker.js"]

# Stage 5: API runtime (default target for backend image)
FROM node:20-slim AS api-runtime

WORKDIR /app

# ffmpeg is required by API runtime (transcoding/audio paths)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tini \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# API runtime keeps full deps because entrypoint uses npx prisma + tsx runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY --from=deps /app/prisma ./prisma
COPY src ./src

# Healthcheck + entrypoint
COPY healthcheck.js ./
COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /app/cache/covers /app/cache/transcodes /app/logs && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R node:node /app && \
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true

USER node

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
