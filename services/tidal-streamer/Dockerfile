# TIDAL Streamer Service - FastAPI sidecar using tiddl for TIDAL streaming and downloads
FROM python:3.15-slim@sha256:e97b88e416c3c01eb427b21fd8cd3ebf006e6ee38afcfcc3cae1c54ee2ab0a75

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install system dependencies
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies from the hash-pinned lock (roadmap F50) so a
# rebuild of this commit resolves the identical transitive tree.
COPY services/tidal-streamer/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# pip is build-time tooling only; removing it from the runtime image drops
# its vendored dependencies (msgpack, setuptools metadata) from the scan
# surface alongside the other removed network tools.
RUN python3 -m pip uninstall -y pip

# Copy the entrypoint and its split sidecar modules.
COPY services/tidal-streamer/*.py ./
COPY services/common ./services/common

# Create writable directories and non-root user
# - /data/.tiddl : tiddl library cache/config (RWO — single pod)
# - /tmp/tidal   : ephemeral scratch space for in-progress downloads
# Runtime-written paths also belong to group 0 with owner permissions so an
# arbitrary UID in group 0 (OpenShift restricted-v2) can write them. Sources
# are byte-compiled now because that UID cannot write /app at runtime.
RUN useradd -m -u 1000 tidal && \
    mkdir -p /data/.tiddl /tmp/tidal && \
    chown -R tidal:tidal /app /data /tmp/tidal && \
    chgrp -R 0 /data /tmp/tidal && \
    chmod -R g=u /data /tmp/tidal && \
    python3 -m compileall -q /app

ENV TIDDL_PATH=/data/.tiddl
ENV MUSIC_PATH=/music
ENV TIDAL_TRACK_DELAY=3
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# An arbitrary UID has no passwd entry or home directory.
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache

# Drop to non-root user (compatible with K8s runAsNonRoot / runAsUser: 1000)
USER 1000

EXPOSE 8585

# tini handles PID 1 reaping and signal forwarding (SIGTERM from K8s)
ENTRYPOINT ["tini", "--"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8585/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8585"]
