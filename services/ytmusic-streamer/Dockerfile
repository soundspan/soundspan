# YouTube Music Streamer — FastAPI sidecar for soundspan
# Streams audio from YouTube Music via ytmusicapi + yt-dlp with a bounded transient spool
FROM denoland/deno:bin-2.9.5@sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa AS deno

FROM python:3.14-slim@sha256:ce40764625a4ff50df3548277632e7f96c4e77fe75fa848aae9885476e7df5a4

# yt-dlp uses Deno for YouTube's JavaScript challenge solving.
COPY --from=deno /deno /usr/local/bin/deno

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install system dependencies
# ffmpeg: required by yt-dlp for stream extraction
# curl: healthcheck probe
# tini: PID 1 signal handling (K8s SIGTERM)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies in two steps.
# Step 1: the hash-locked base — every dependency EXCEPT the two exempt YouTube
# libs, installed with --require-hashes so a rebuild of this commit resolves the
# identical transitive tree.
COPY services/ytmusic-streamer/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
# Step 2: yt-dlp + ytmusicapi are DELIBERATELY EXEMPT from hash-locking (roadmap
# F38/F50) so a YouTube breakage can be fixed with a same-day floor bump.
# Constraints pin every already-locked dist, so this step can only add yt-dlp,
# ytmusicapi, and yt-dlp-ejs. pip check fails the build on any unsatisfied or
# conflicting requirement.
COPY services/ytmusic-streamer/requirements-exempt.txt ./requirements-exempt.txt
RUN sed -n 's/^\([A-Za-z0-9._-]\+==[^ \\]\+\).*$/\1/p' requirements.lock > /tmp/lock-constraints.txt \
    && pip install --no-cache-dir -c /tmp/lock-constraints.txt -r requirements-exempt.txt \
    && pip check \
    && rm /tmp/lock-constraints.txt

# Copy the entrypoint and its split sidecar modules.
COPY services/ytmusic-streamer/*.py ./
COPY services/common ./common
COPY services/ytmusic-streamer/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Create writable directories and non-root user
# - /data: ytmusicapi OAuth token storage
RUN useradd -m -u 1000 ytmusic && \
    mkdir -p /data && \
    chown -R ytmusic:ytmusic /app /data

ENV PYTHONUNBUFFERED=1

# The entrypoint repairs legacy /data ownership, then drops to ytmusic via
# setpriv. Kubernetes deployments still enforce runAsNonRoot/runAsUser 1000
# through the chart securityContext; there the chown branch is skipped and
# fsGroup handles volume permissions.

EXPOSE 8586

# tini handles PID 1 reaping and signal forwarding (SIGTERM from K8s)
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8586/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8586"]
