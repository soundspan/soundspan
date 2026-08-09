# CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity
FROM python:3.12-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# CPU thread limiting for PyTorch and numerical libraries
# Prevents workers from using all CPU cores
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    TORCH_NUM_THREADS=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies from the hash-pinned lock (roadmap F50) so a
# rebuild of this commit resolves the identical transitive tree. torch /
# torchaudio / torchvision resolve from plain PyPI (today's source), pinned+hashed.
COPY services/audio-analyzer-clap/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Create models directory
RUN mkdir -p /app/models

# Download CLAP model at build time
# Using music_audioset checkpoint for music-specific embeddings
# Pinned to an immutable repo commit (not `resolve/main`, which can move) and
# verified against a pinned sha256 digest (roadmap F38); a mismatch fails the
# build. Digest measured 2026-07-11 (see docs/modernization-roadmap.md F38).
RUN set -e; \
    MODEL_URL="https://huggingface.co/lukewys/laion_clap/resolve/b3708341862f581175dba5c356a4ebf74a9b6651/music_audioset_epoch_15_esc_90.14.pt"; \
    curl -L -o /app/models/music_audioset_epoch_15_esc_90.14.pt "${MODEL_URL}"; \
    echo "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd  /app/models/music_audioset_epoch_15_esc_90.14.pt" | sha256sum -c -

# Verify model loads correctly
RUN python -c "import laion_clap; model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base'); model.load_ckpt('/app/models/music_audioset_epoch_15_esc_90.14.pt'); print('CLAP model verified successfully')"

# Copy application code
COPY services/audio-analyzer-clap/analyzer.py /app/analyzer.py
COPY services/common /app/services/common

# Create non-root user
RUN useradd -m -u 1000 analyzer && \
    chown -R analyzer:analyzer /app

USER analyzer

# Health check that imports laion_clap
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import laion_clap; print('OK')" || exit 1

CMD ["python", "analyzer.py"]
