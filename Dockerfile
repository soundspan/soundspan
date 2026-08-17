# soundspan All-in-One Docker Image (Hardened)
# Contains: Backend, Frontend, PostgreSQL, Redis, Audio Analyzer, DCLAP Vibe Provider
# Usage: docker run -d -p 3030:3030 -v /path/to/music:/music ghcr.io/soundspan/soundspan-aio:latest

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# Add the PostgreSQL 16 repository and install runtime dependencies in one layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg lsb-release curl ca-certificates && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && \
    apt-get update && apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-contrib-16 \
    postgresql-16-pgvector \
    redis-server \
    supervisor \
    ffmpeg \
    libgomp1 \
    libsndfile1 \
    tini \
    openssl \
    bash \
    gosu \
    # Python for audio analyzer
    python3 \
    python3-pip \
    python3-numpy \
    # Build tools (needed for some Python packages)
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /app/backend /app/frontend /app/audio-analyzer /app/models \
    /data/postgres /data/redis /run/postgresql /var/log/supervisor \
    && chown -R postgres:postgres /data/postgres /run/postgresql

# The chart's fsGroup expects fixed uid/gid 1000. Base Node user presence varies,
# and on Debian userdel may also remove its same-named empty primary group.
RUN set -eux; \
    if getent passwd node > /dev/null; then userdel node; fi; \
    if getent group node > /dev/null; then groupdel node; fi; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ]; then \
        if [ "$existing_group" != soundspan ]; then groupmod -n soundspan "$existing_group"; fi; \
    else \
        groupadd -g 1000 soundspan; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ]; then \
        if [ "$existing_user" != soundspan ]; then \
            usermod -l soundspan -g 1000 -d /app -s /usr/sbin/nologin "$existing_user"; \
        else \
            usermod -g 1000 -d /app -s /usr/sbin/nologin soundspan; \
        fi; \
    else \
        useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin -d /app soundspan; \
    fi

# ============================================
# AUDIO ANALYZER SETUP (Essentia AI)
# ============================================
WORKDIR /app/audio-analyzer

# Install ALL Python dependencies (Essentia analyzer + DCLAP provider) from ONE
# hash-pinned lock (roadmap F50). requirements-aio.lock is the analyzer + DCLAP
# manifests resolved JOINTLY for Python 3.11 (this image's system interpreter),
# so both ML runtimes share one consistent transitive tree — subsuming the
# former inline TensorFlow/essentia install here. Regenerate: see the lock header.
COPY requirements-aio.lock /tmp/requirements-aio.lock
RUN pip3 install --no-cache-dir --break-system-packages \
    --require-hashes -r /tmp/requirements-aio.lock \
    && rm -f /tmp/requirements-aio.lock \
    && python3 -c "import numpy, onnxruntime, tensorflow; import importlib.util as i; assert i.find_spec('essentia')"

# Download Essentia ML models (~4MB total) - these enable Enhanced vibe matching
# IMPORTANT: Using MusiCNN models to match analyzer.py expectations
# Each download is verified against a pinned sha256 digest (roadmap F38); a
# mismatch fails the build immediately. Digests measured 2026-07-11 (see
# docs/modernization-roadmap.md F38).
RUN echo "Downloading Essentia ML models for Enhanced vibe matching..." && \
    # Base MusiCNN embedding model (required for all predictions)
    curl -L --progress-bar -o /app/models/msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.pb" && \
    echo "cdea0722bcee7f731286843f2233e3aa69887bb5c3e2dce011eff55f38d04f3e  /app/models/msd-musicnn-1.pb" | sha256sum -c - && \
    # Mood classification heads (using MusiCNN architecture)
    curl -L --progress-bar -o /app/models/mood_happy-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_happy/mood_happy-msd-musicnn-1.pb" && \
    echo "d7382bc60304ea4578c298222968cd8d600c31252c7bf3e90b1f728ebb3ec36d  /app/models/mood_happy-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_sad-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_sad/mood_sad-msd-musicnn-1.pb" && \
    echo "a5e908cf7f59e8c379ff7c7d138dd85416985fddaebb5de14ca4193200411f61  /app/models/mood_sad-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_relaxed-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb" && \
    echo "1252d28ca7d2204e34e0cdf84a00aa2bc9627a87bdcf923df3aad39cfa69d2d9  /app/models/mood_relaxed-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_aggressive-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_aggressive/mood_aggressive-msd-musicnn-1.pb" && \
    echo "3b6eb5645e4b47a2ceb28ef3f8612f224640c583048770791b9fc6e8e5627a67  /app/models/mood_aggressive-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_party-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb" && \
    echo "765b096300ee1d92103cb0a122fc12c33882166fb94d37875284e82ce06322a1  /app/models/mood_party-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_acoustic-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_acoustic/mood_acoustic-msd-musicnn-1.pb" && \
    echo "519ee3af8210fe32e021002a0094546aeb6fb5a59d22b7d53c48e4ee1ac9e6cc  /app/models/mood_acoustic-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/mood_electronic-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb" && \
    echo "86c109b504fc6cf666c7513d684381a594218a552c3c954f212dd3a9d0c6cdc5  /app/models/mood_electronic-msd-musicnn-1.pb" | sha256sum -c - && \
    # Other classification heads
    curl -L --progress-bar -o /app/models/danceability-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb" && \
    echo "874a4b86afc9e12de3f15a47baf9ff1ac676ace109c56203e26103f2259eb95e  /app/models/danceability-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L --progress-bar -o /app/models/voice_instrumental-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb" && \
    echo "eb762cc7ee6751b2ea32179d3716e2d60a1d1a9e615b7e3b8be8a6f79d71675e  /app/models/voice_instrumental-msd-musicnn-1.pb" | sha256sum -c - && \
    echo "ML models downloaded successfully" && \
    ls -lh /app/models/

# Copy audio analyzer script
COPY services/audio-analyzer/analyzer.py /app/audio-analyzer/
# Shared sidecar logging helpers (used by analyzer services)
COPY services/common /app/services/common

# ============================================
# DCLAP VIBE PROVIDER SETUP (ONNX)
# ============================================
WORKDIR /app/vibe-provider-dclap

RUN mkdir -p /app/vibe-provider-dclap/models \
    /app/vibe-provider-dclap/tokenizer /app/licenses/dclap

# Vendor the immutable upstream v1 release artifacts and fail on any byte drift.
RUN set -eu; \
    RELEASE_URL="https://github.com/NeptuneHub/AudioMuse-AI-DCLAP/releases/download/v1"; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/vibe-provider-dclap/models/model_epoch_36.onnx "${RELEASE_URL}/model_epoch_36.onnx"; \
    echo "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971  /app/vibe-provider-dclap/models/model_epoch_36.onnx" | sha256sum -c -; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/vibe-provider-dclap/models/model_epoch_36.onnx.data "${RELEASE_URL}/model_epoch_36.onnx.data"; \
    echo "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657  /app/vibe-provider-dclap/models/model_epoch_36.onnx.data" | sha256sum -c -; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/vibe-provider-dclap/models/clap_text_model.onnx "${RELEASE_URL}/clap_text_model.onnx"; \
    echo "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714  /app/vibe-provider-dclap/models/clap_text_model.onnx" | sha256sum -c -

# Vendor only tokenizer assets from an immutable Hugging Face snapshot. Runtime
# offline flags make any accidental network fallback fail closed.
RUN set -eu; \
    TOKENIZER_REVISION="8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"; \
    TOKENIZER_URL="https://huggingface.co/laion/clap-htsat-unfused/resolve/${TOKENIZER_REVISION}"; \
    for TOKENIZER_FILE in config.json merges.txt special_tokens_map.json tokenizer.json tokenizer_config.json vocab.json; do \
        curl --fail --location --retry 3 --connect-timeout 30 --max-time 600 \
            --output "/app/vibe-provider-dclap/tokenizer/${TOKENIZER_FILE}" "${TOKENIZER_URL}/${TOKENIZER_FILE}"; \
    done; \
    echo "9efb9557bc804f2ca6e394486af2e45dfed0b18554909735a99c6220b84e4288  /app/vibe-provider-dclap/tokenizer/config.json" | sha256sum -c -; \
    echo "fe36cab26d4f4421ed725e10a2e9ddb7f799449c603a96e7f29b5a3c82a95862  /app/vibe-provider-dclap/tokenizer/merges.txt" | sha256sum -c -; \
    echo "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f  /app/vibe-provider-dclap/tokenizer/special_tokens_map.json" | sha256sum -c -; \
    echo "77ef92283d67f0d97e1454909a964afcbfa2019f0fb9f18f8e88d5c25c3ba729  /app/vibe-provider-dclap/tokenizer/tokenizer.json" | sha256sum -c -; \
    echo "377f91458f7729a4574a84c77bdce67dbc3c58c1a345a29bbf8c4eb1307948a3  /app/vibe-provider-dclap/tokenizer/tokenizer_config.json" | sha256sum -c -; \
    echo "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e  /app/vibe-provider-dclap/tokenizer/vocab.json" | sha256sum -c -

COPY services/vibe-provider-dclap/__main__.py services/vibe-provider-dclap/http_server.py \
    services/vibe-provider-dclap/inference.py services/vibe-provider-dclap/model_provider.py \
    services/vibe-provider-dclap/music_path.py services/vibe-provider-dclap/preprocessing.py \
    services/vibe-provider-dclap/settings.py /app/vibe-provider-dclap/
COPY services/vibe-provider-dclap/LICENSE services/vibe-provider-dclap/NOTICE.md /app/licenses/dclap/

# Create database readiness check script
RUN cat > /app/wait-for-db.sh << 'EOF'
#!/bin/bash
TIMEOUT=${1:-120}
COUNTER=0

echo "[wait-for-db] Waiting for database schema (timeout: ${TIMEOUT}s)..."

# Quick check for schema ready flag
if [ -f /data/.schema_ready ]; then
    echo "[wait-for-db] Schema ready flag found, verifying connection..."
fi

while [ $COUNTER -lt $TIMEOUT ]; do
    if psql "$DATABASE_URL" -c "SELECT 1 FROM \"Track\" LIMIT 1" > /dev/null 2>&1; then
        echo "[wait-for-db] ✓ Database is ready and schema exists!"
        exit 0
    fi
    
    if [ $((COUNTER % 15)) -eq 0 ]; then
        echo "[wait-for-db] Still waiting... (${COUNTER}s elapsed)"
    fi
    
    sleep 1
    COUNTER=$((COUNTER + 1))
done

echo "[wait-for-db] ERROR: Database schema not ready after ${TIMEOUT}s"
echo "[wait-for-db] Listing available tables:"
psql "$DATABASE_URL" -c "\dt" 2>&1 || echo "Could not list tables"
exit 1
EOF

RUN chmod +x /app/wait-for-db.sh && \
    sed -i 's/\r$//' /app/wait-for-db.sh

# ============================================
# BACKEND BUILD
# ============================================
WORKDIR /app

# Provide shared local package used by backend/frontend file: dependencies.
COPY packages/media-metadata-contract /app/packages/media-metadata-contract

WORKDIR /app/backend

# Copy backend package files and install dependencies
COPY backend/package*.json ./
COPY backend/prisma ./prisma/
# Prisma 7 CLI reads schema/migrations/datasource config from prisma.config.ts
COPY backend/prisma.config.ts ./
COPY backend/databaseUrl.js ./
RUN echo "=== Migrations copied ===" && ls -la prisma/migrations/ && echo "=== End migrations ==="
RUN npm ci && npm cache clean --force
RUN npx prisma generate

# Copy backend source and build
COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npm run build

# Prune backend dev dependencies after build (typescript, jest, tsx, etc.),
# then reinstall the prisma CLI locally: the startup script needs
# `npx prisma migrate deploy`, and Prisma 7's prisma.config.ts imports
# "prisma/config", which must resolve from the app's own node_modules —
# a globally-installed CLI cannot satisfy that import after prune.
RUN PRISMA_VERSION=$(node -p "require('./node_modules/prisma/package.json').version") && \
    npm prune --omit=dev && \
    npm install --no-save prisma@"$PRISMA_VERSION" && \
    npm cache clean --force

COPY backend/docker-entrypoint.sh ./
COPY backend/healthcheck.js ./healthcheck-backend.js

# Create log directory (cache will be in /data volume)
RUN mkdir -p /app/backend/logs

# ============================================
# FRONTEND BUILD
# ============================================
WORKDIR /app/frontend

# Copy frontend package files and install dependencies
COPY frontend/package*.json ./
RUN npm ci && npm cache clean --force

# Copy frontend source and build
COPY frontend/ ./

# Build Next.js (production)
ARG NEXT_PUBLIC_LOG_LEVEL
ARG NEXT_PUBLIC_BUILD_TYPE=nightly
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_LOG_LEVEL=$NEXT_PUBLIC_LOG_LEVEL
ENV NEXT_PUBLIC_BUILD_TYPE=$NEXT_PUBLIC_BUILD_TYPE
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
RUN npm run build

# Validate the built runtime config (headers, CSP, proxy behavior) while dev
# dependencies are still present: the smoke imports proxy.ts via the tsx
# loader, which npm prune removes. Production never needs tsx -- server.js
# uses the plain-JS server-proxy and Next compiles proxy.ts during build.
RUN npm run test:config:runtime

# Prune frontend dev dependencies after build (typescript, eslint, playwright, etc.)
# and remove Next.js build cache (not needed at runtime)
RUN npm prune --omit=dev && \
    npm cache clean --force && \
    rm -rf .next/cache

# ============================================
# SECURITY HARDENING
# ============================================
# Remove dangerous tools and build dependencies AFTER all builds are complete
# Keep: bash (supervisor), gosu (postgres user switching), python3 (audio analyzer)
RUN apt-get purge -y --auto-remove build-essential python3-dev 2>/dev/null || true && \
    rm -f /usr/bin/wget /bin/wget 2>/dev/null || true && \
    rm -f /usr/bin/curl /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/*

# ============================================
# CONFIGURATION
# ============================================
WORKDIR /app

# Copy healthcheck script
COPY healthcheck-prod.js /app/healthcheck.js
COPY scripts/aio-postgres-credentials.sh /app/aio-postgres-credentials.sh
RUN chmod 500 /app/aio-postgres-credentials.sh

# Create supervisord config - logs to stdout/stderr for Docker visibility
RUN cat > /etc/supervisor/conf.d/soundspan.conf << 'EOF'
[supervisord]
nodaemon=true
logfile=/dev/null
logfile_maxbytes=0
pidfile=/var/run/supervisord.pid
# Supervisord stays root only to drop workloads to soundspan/postgres/redis.
user=root

[program:postgres]
command=/usr/lib/postgresql/16/bin/postgres -D /data/postgres -c listen_addresses=127.0.0.1
user=postgres
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10

[program:redis]
command=/usr/bin/redis-server --dir /data/redis --appendonly yes
user=redis
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=20

[program:backend]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/backend && node dist/index.js"
user=soundspan
autostart=true
autorestart=unexpected
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
directory=/app/backend
priority=30

[program:frontend]
command=/bin/bash -c "cd /app/frontend && npm start"
user=soundspan
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",BACKEND_URL="http://localhost:3006",PORT="3030"
priority=40

[program:audio-analyzer]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/audio-analyzer && python3 analyzer.py"
user=soundspan
autostart=true
autorestart=unexpected
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=DATABASE_URL="%(ENV_DATABASE_URL)s",REDIS_URL="%(ENV_REDIS_URL)s",MUSIC_PATH="%(ENV_MUSIC_PATH)s",BATCH_SIZE="%(ENV_BATCH_SIZE)s",SLEEP_INTERVAL="%(ENV_SLEEP_INTERVAL)s",MAX_ANALYZE_SECONDS="%(ENV_MAX_ANALYZE_SECONDS)s",BRPOP_TIMEOUT="%(ENV_BRPOP_TIMEOUT)s",MODEL_IDLE_TIMEOUT="%(ENV_MODEL_IDLE_TIMEOUT)s",NUM_WORKERS="%(ENV_NUM_WORKERS)s",THREADS_PER_WORKER="%(ENV_THREADS_PER_WORKER)s",AUDIO_REDIS_SOCKET_TIMEOUT="%(ENV_AUDIO_REDIS_SOCKET_TIMEOUT)s",CUDA_VISIBLE_DEVICES="%(ENV_CUDA_VISIBLE_DEVICES)s"
priority=50

[program:vibe-provider-dclap]
command=python3 __main__.py
user=soundspan
autostart=true
autorestart=unexpected
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
directory=/app/vibe-provider-dclap
environment=PYTHONPATH="/app",PYTHONDONTWRITEBYTECODE="1",PYTHONUNBUFFERED="1",INTERNAL_API_SECRET="%(ENV_INTERNAL_API_SECRET)s",MUSIC_PATH="%(ENV_MUSIC_PATH)s",DCLAP_HTTP_PORT="%(ENV_DCLAP_HTTP_PORT)s",DCLAP_ONNX_INTRA_OP_THREADS="%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s",MODEL_IDLE_TIMEOUT="%(ENV_MODEL_IDLE_TIMEOUT)s",DCLAP_MODEL_PATH="%(ENV_DCLAP_MODEL_PATH)s",DCLAP_TOKENIZER_PATH="%(ENV_DCLAP_TOKENIZER_PATH)s",DCLAP_IMAGE_VERSION="%(ENV_DCLAP_IMAGE_VERSION)s",TRANSFORMERS_OFFLINE="1",HF_HUB_OFFLINE="1",TOKENIZERS_PARALLELISM="false",OMP_NUM_THREADS="%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s",OPENBLAS_NUM_THREADS="%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s",MKL_NUM_THREADS="%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s",NUMEXPR_MAX_THREADS="%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s"
priority=25
EOF

# Fix Windows line endings in supervisor config
RUN sed -i 's/\r$//' /etc/supervisor/conf.d/soundspan.conf

# Create startup script with root check
RUN cat > /app/start.sh << 'EOF'
#!/bin/bash
set -e

# Security check: Warn if running internal services as root
# Note: This container runs multiple services, some require root for initial setup
# but individual services (postgres, backend processes) run as non-root users

echo ""
echo "============================================================"
echo "  soundspan - Premium Self-Hosted Music Server"
echo ""
echo "  Features:"
echo "    - AI-Powered Vibe Matching (Essentia ML)"
echo "    - Smart Playlists & Mood Detection"
echo "    - High-Quality Audio Streaming"
echo ""
echo "  Security:"
echo "    - Hardened container (no wget/curl/nc)"
echo "    - Auto-generated encryption keys"
echo "============================================================"
echo ""

# Find PostgreSQL binaries (version may vary)
PG_BIN=$(find /usr/lib/postgresql -name "bin" -type d | head -1)
if [ -z "$PG_BIN" ]; then
    echo "ERROR: PostgreSQL binaries not found!"
    exit 1
fi
echo "Using PostgreSQL from: $PG_BIN"

# Prepare data directories (bind-mount safe)
echo "Preparing data directories..."
mkdir -p /data/postgres /data/redis /run/postgresql \
    /data/cache/covers /data/cache/transcodes /data/cache/home /data/secrets /app/backend/logs
chmod 700 /data/secrets
chown -R soundspan:soundspan /data/cache /data/secrets /app/backend/logs

if id postgres >/dev/null 2>&1; then
    chown -R postgres:postgres /data/postgres /run/postgresql 2>/dev/null || true
    chmod 700 /data/postgres 2>/dev/null || true
    if ! gosu postgres test -w /data/postgres; then
        POSTGRES_UID=$(id -u postgres)
        POSTGRES_GID=$(id -g postgres)
        echo "ERROR: /data/postgres is not writable by postgres (${POSTGRES_UID}:${POSTGRES_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

if id redis >/dev/null 2>&1; then
    chown -R redis:redis /data/redis 2>/dev/null || true
    chmod 700 /data/redis 2>/dev/null || true
    if ! gosu redis test -w /data/redis; then
        REDIS_UID=$(id -u redis)
        REDIS_GID=$(id -g redis)
        echo "ERROR: /data/redis is not writable by redis (${REDIS_UID}:${REDIS_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

# Resolve application secrets: operator environment, persisted file, generated.
resolve_secret_candidate() {
    local candidate="$1"
    local secret_file="$2"

    SECRET_NEEDS_PERSIST=false
    if [ -n "$candidate" ]; then
        RESOLVED_SECRET="$candidate"
        SECRET_NEEDS_PERSIST=true
    elif [ -f "$secret_file" ]; then
        RESOLVED_SECRET=$(cat "$secret_file")
    else
        RESOLVED_SECRET=$(openssl rand -hex 32)
        SECRET_NEEDS_PERSIST=true
    fi
}

validate_critical_secret() {
    local secret_name="$1"
    local secret_value="$2"
    local published_default="$3"

    if [ -z "$secret_value" ] || [ "$secret_value" = "$published_default" ] || [ "${#secret_value}" -lt 32 ]; then
        echo "ERROR: ${secret_name} is missing, uses the published default, or is shorter than 32 characters." >&2
        return 1
    fi
}

persist_secret_atomically() {
    local secret_value="$1"
    local secret_file="$2"
    local temporary_file

    temporary_file=$(mktemp "${secret_file}.tmp.XXXXXX")
    if ! printf '%s' "$secret_value" > "$temporary_file"; then
        rm -f -- "$temporary_file"
        return 1
    fi
    if ! chmod 600 "$temporary_file"; then
        rm -f -- "$temporary_file"
        return 1
    fi
    chown soundspan:soundspan "$temporary_file" 2>/dev/null || true
    if ! mv -f -- "$temporary_file" "$secret_file"; then
        rm -f -- "$temporary_file"
        return 1
    fi
}

secure_secret_file() {
    local secret_file="$1"

    chmod 600 "$secret_file"
    chown soundspan:soundspan "$secret_file" 2>/dev/null || true
}

resolve_secret_candidate "${SESSION_SECRET:-}" /data/secrets/session_secret
SESSION_SECRET="$RESOLVED_SECRET"
SESSION_SECRET_NEEDS_PERSIST="$SECRET_NEEDS_PERSIST"
resolve_secret_candidate "${SETTINGS_ENCRYPTION_KEY:-}" /data/secrets/encryption_key
SETTINGS_ENCRYPTION_KEY="$RESOLVED_SECRET"
SETTINGS_ENCRYPTION_KEY_NEEDS_PERSIST="$SECRET_NEEDS_PERSIST"
resolve_secret_candidate "${INTERNAL_API_SECRET:-}" /data/secrets/internal_api_secret
INTERNAL_API_SECRET="$RESOLVED_SECRET"
INTERNAL_API_SECRET_NEEDS_PERSIST="$SECRET_NEEDS_PERSIST"
resolve_secret_candidate "${POSTGRES_PASSWORD:-}" /data/secrets/postgres_password
POSTGRES_PASSWORD="$RESOLVED_SECRET"
POSTGRES_PASSWORD_NEEDS_PERSIST="$SECRET_NEEDS_PERSIST"
unset RESOLVED_SECRET SECRET_NEEDS_PERSIST

# Validate every resolved candidate before changing any persisted secret.
validate_critical_secret SESSION_SECRET "$SESSION_SECRET" "changeme-generate-secure-key"
validate_critical_secret SETTINGS_ENCRYPTION_KEY "$SETTINGS_ENCRYPTION_KEY" "default-encryption-key-change-me"
validate_critical_secret INTERNAL_API_SECRET "$INTERNAL_API_SECRET" "soundspan-internal-secret-change-me"
if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "ERROR: POSTGRES_PASSWORD must not be empty." >&2
    exit 1
fi

if [ "$SESSION_SECRET_NEEDS_PERSIST" = true ]; then
    persist_secret_atomically "$SESSION_SECRET" /data/secrets/session_secret
fi
if [ "$SETTINGS_ENCRYPTION_KEY_NEEDS_PERSIST" = true ]; then
    persist_secret_atomically "$SETTINGS_ENCRYPTION_KEY" /data/secrets/encryption_key
fi
if [ "$INTERNAL_API_SECRET_NEEDS_PERSIST" = true ]; then
    persist_secret_atomically "$INTERNAL_API_SECRET" /data/secrets/internal_api_secret
fi
if [ "$POSTGRES_PASSWORD_NEEDS_PERSIST" = true ]; then
    persist_secret_atomically "$POSTGRES_PASSWORD" /data/secrets/postgres_password
fi
unset SESSION_SECRET_NEEDS_PERSIST SETTINGS_ENCRYPTION_KEY_NEEDS_PERSIST
unset INTERNAL_API_SECRET_NEEDS_PERSIST POSTGRES_PASSWORD_NEEDS_PERSIST

secure_secret_file /data/secrets/session_secret
secure_secret_file /data/secrets/encryption_key
secure_secret_file /data/secrets/internal_api_secret
secure_secret_file /data/secrets/postgres_password

# Resolve the PostgreSQL URL after its validated password is persisted.
DATABASE_URL=$(/app/aio-postgres-credentials.sh database-url)

# Clean up stale PID file if exists
rm -f /data/postgres/postmaster.pid 2>/dev/null || true

# Initialize PostgreSQL if not already done
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."
    gosu postgres $PG_BIN/initdb -D /data/postgres

    # Configure PostgreSQL for authenticated loopback access only.
    echo "host all all 127.0.0.1/32 scram-sha-256" >> /data/postgres/pg_hba.conf
    echo "host all all ::1/128 scram-sha-256" >> /data/postgres/pg_hba.conf
    echo "listen_addresses='localhost'" >> /data/postgres/postgresql.conf
fi

# Harden authentication rules migrated from older persistent volumes.
sed -i '/0\.0\.0\.0\/0/d' /data/postgres/pg_hba.conf 2>/dev/null || true
if ! grep -q "host all all 127.0.0.1/32 scram-sha-256" /data/postgres/pg_hba.conf; then
    echo "host all all 127.0.0.1/32 scram-sha-256" >> /data/postgres/pg_hba.conf
fi

# Start PostgreSQL temporarily to create database and user
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -o "-c listen_addresses=127.0.0.1" -w start

# Create the user if needed, then always synchronize its persisted password.
/app/aio-postgres-credentials.sh sync-role
gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'soundspan'" | grep -q 1 || \
    gosu postgres psql -c "CREATE DATABASE soundspan OWNER soundspan;"

# Create pgvector extension as superuser (required before migrations)
echo "Creating pgvector extension..."
gosu postgres psql -d soundspan -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run Prisma migrations
cd /app/backend
export DATABASE_URL
echo "Running Prisma migrations..."
ls -la prisma/migrations/ || echo "No migrations directory!"

# Check if _prisma_migrations table exists (indicates previous Prisma setup)
MIGRATIONS_EXIST=$(gosu postgres psql -d soundspan -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_prisma_migrations')" 2>/dev/null || echo "f")

# Check if User table exists (indicates existing data)
USER_TABLE_EXIST=$(gosu postgres psql -d soundspan -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User')" 2>/dev/null || echo "f")

# Handle rename migration for existing databases
echo "Checking if rename migration needs to be marked as applied..."
if gosu postgres psql -d soundspan -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='SystemSettings' AND column_name='soulseekFallback');" 2>/dev/null | grep -q 't'; then
    echo "Old column exists, marking migration as applied..."
    gosu postgres psql -d soundspan -c "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (gen_random_uuid(), '', NOW(), '20250101000000_rename_soulseek_fallback', '', NULL, NOW(), 1) ON CONFLICT DO NOTHING;" 2>/dev/null || true
fi

if [ "$MIGRATIONS_EXIST" = "t" ]; then
    # Normal migration flow - migrations table exists
    echo "Migration history found, running migrate deploy..."
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Database migration failed! Check logs above."
        exit 1
    fi
elif [ "$USER_TABLE_EXIST" = "t" ]; then
    # Database has data but no migrations table - needs baseline
    echo "Existing database detected without migration history."
    echo "Creating baseline from current schema..."
    # Mark the init migration as already applied (baseline)
    npx prisma migrate resolve --applied 20241130000000_init 2>&1 || true
    # Now run any subsequent migrations
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Migration after baseline failed!"
        exit 1
    fi
else
    # Fresh database - run migrations normally
    echo "Fresh database detected, running initial migrations..."
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Initial migration failed. Check database connection and schema."
        exit 1
    fi
fi
echo "✓ Migrations completed successfully"

# Verify schema exists before starting services
echo "Verifying database schema..."
if ! gosu postgres psql -d soundspan -c "SELECT 1 FROM \"Track\" LIMIT 1" >/dev/null 2>&1; then
    echo "FATAL: Track table does not exist after migration!"
    echo "Database schema verification failed. Container will exit."
    exit 1
fi
echo "✓ Schema verification passed"

# Create flag file for wait-for-db.sh
touch /data/.schema_ready
echo "✓ Schema ready flag created"

# Stop PostgreSQL (supervisord will start it)
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w stop

# Map AIO/chart tuning variables to the analyzer runtime contract.
export NUM_WORKERS="${AUDIO_ANALYSIS_WORKERS:-2}"
export THREADS_PER_WORKER="${AUDIO_ANALYSIS_THREADS_PER_WORKER:-1}"
export BATCH_SIZE="${AUDIO_ANALYSIS_BATCH_SIZE:-10}"
export BRPOP_TIMEOUT="${AUDIO_BRPOP_TIMEOUT:-30}"
export MAX_ANALYZE_SECONDS="${MAX_ANALYZE_SECONDS:-90}"
export MODEL_IDLE_TIMEOUT="${MODEL_IDLE_TIMEOUT:-${AUDIO_MODEL_IDLE_TIMEOUT:-300}}"
export SLEEP_INTERVAL="${SLEEP_INTERVAL:-5}"
export AUDIO_REDIS_SOCKET_TIMEOUT="${AUDIO_REDIS_SOCKET_TIMEOUT:-35}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export MUSIC_PATH="${MUSIC_PATH:-/music}"
export DCLAP_HTTP_PORT="${DCLAP_HTTP_PORT:-8092}"
export DCLAP_ONNX_INTRA_OP_THREADS="${DCLAP_ONNX_INTRA_OP_THREADS:-1}"
export DCLAP_MODEL_PATH="${DCLAP_MODEL_PATH:-/app/vibe-provider-dclap/models}"
export DCLAP_TOKENIZER_PATH="${DCLAP_TOKENIZER_PATH:-/app/vibe-provider-dclap/tokenizer}"
export DCLAP_IMAGE_VERSION="${DCLAP_IMAGE_VERSION:-dclap-student-v1}"
export VIBE_PROVIDER_URL="${VIBE_PROVIDER_URL:-http://localhost:8092}"
export DATABASE_URL
export SESSION_SECRET SETTINGS_ENCRYPTION_KEY INTERNAL_API_SECRET
export NODE_ENV=production
export PORT=3006
export HOME=/data/cache/home
export XDG_CACHE_HOME=/data/cache/home/.cache

# Write environment file for backend
cat > /app/backend/.env << ENVEOF
NODE_ENV=production
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
PORT=3006
MUSIC_PATH=$MUSIC_PATH
TRANSCODE_CACHE_PATH=/data/cache/transcodes
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
INTERNAL_API_SECRET=$INTERNAL_API_SECRET
VIBE_PROVIDER_URL=$VIBE_PROVIDER_URL
ENVEOF
chmod 600 /app/backend/.env
chown soundspan:soundspan /app/backend/.env 2>/dev/null || true

# Normalize runtime streaming engine mode (consumed by frontend /runtime-config route).
ENGINE_MODE="${STREAMING_ENGINE_MODE:-}"
case "$ENGINE_MODE" in
    ""|"videojs"|"howler"|"native")
        ;;
    *)
        echo "WARN: Invalid STREAMING_ENGINE_MODE '$ENGINE_MODE'; expected native|howler|videojs. Using primary default (native)."
        ENGINE_MODE=""
        ;;
esac

echo "Frontend runtime STREAMING_ENGINE_MODE: ${ENGINE_MODE:-native (primary default)}"
export STREAMING_ENGINE_MODE="$ENGINE_MODE"

echo "Starting soundspan..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
EOF

# Fix Windows line endings (CRLF -> LF) and make executable
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

# Expose ports
EXPOSE 3030

# Health check using Node.js (no wget)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

# Volumes
VOLUME ["/music", "/data"]

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
