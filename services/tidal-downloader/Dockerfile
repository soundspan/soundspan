# TIDAL Downloader Service - FastAPI sidecar using tiddl for TIDAL downloads
FROM python:3.14-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies from the hash-pinned lock (roadmap F50) so a
# rebuild of this commit resolves the identical transitive tree.
COPY services/tidal-downloader/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Copy application code
COPY services/tidal-downloader/app.py ./app.py
COPY services/common ./common

# Create writable directories and non-root user
# - /data/.tiddl : tiddl library cache/config (RWO — single pod)
# - /tmp/tidal   : ephemeral scratch space for in-progress downloads
RUN useradd -m -u 1000 tidal && \
    mkdir -p /data/.tiddl /tmp/tidal && \
    chown -R tidal:tidal /app /data /tmp/tidal

ENV TIDDL_PATH=/data/.tiddl
ENV MUSIC_PATH=/music
ENV TIDAL_TRACK_DELAY=3
ENV PYTHONUNBUFFERED=1

# Drop to non-root user (compatible with K8s runAsNonRoot / runAsUser: 1000)
USER tidal

EXPOSE 8585

# tini handles PID 1 reaping and signal forwarding (SIGTERM from K8s)
ENTRYPOINT ["tini", "--"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8585/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8585"]
