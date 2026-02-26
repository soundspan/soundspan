# YouTube Music Streamer — FastAPI sidecar for soundspan
# Streams audio from YouTube Music via ytmusicapi + yt-dlp (no files saved to disk)
FROM python:3.13-slim

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

# Install Python dependencies
COPY services/ytmusic-streamer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY services/ytmusic-streamer/app.py ./app.py
COPY services/common ./common

# Create writable directories and non-root user
# - /data: ytmusicapi OAuth token storage
# chmod 777 ensures compatibility with pre-existing Docker volumes that may
# have been created with root ownership before the non-root user was added.
RUN useradd -m -u 1000 ytmusic && \
    mkdir -p /data && \
    chown -R ytmusic:ytmusic /app /data && \
    chmod 777 /data

ENV PYTHONUNBUFFERED=1

# Drop to non-root user (compatible with K8s runAsNonRoot / runAsUser: 1000)
USER ytmusic

EXPOSE 8586

# tini handles PID 1 reaping and signal forwarding (SIGTERM from K8s)
ENTRYPOINT ["tini", "--"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8586/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8586"]
