# Audio Analyzer Service - Essentia with TensorFlow (MusiCNN)
# Using Ubuntu 20.04 with Python 3.8 for essentia-tensorflow compatibility
FROM ubuntu:20.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# CPU thread limiting for TensorFlow and numerical libraries
# Prevents each worker from using all CPU cores
# Override with docker-compose environment variables
ENV TF_NUM_INTRAOP_THREADS=1 \
    TF_NUM_INTEROP_THREADS=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    THREADS_PER_WORKER=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-dev \
    python3-pip \
    ffmpeg \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --upgrade pip setuptools wheel

WORKDIR /app

# Install ML dependencies explicitly.
# Some essentia-tensorflow builds no longer pull a top-level `tensorflow` package.
# We install TensorFlow directly so analyzer.py's runtime import checks stay valid.
RUN pip3 install --no-cache-dir \
    "tensorflow>=2.13.0,<2.16.0" \
    essentia-tensorflow

# Verify TensorFlow is importable and Essentia package is present.
# Avoid importing `essentia.standard` at build time; some build environments can
# fail entropy initialization (`random_device could not be read`) despite runtime
# pods working normally.
RUN python3 -c "import importlib.util; import tensorflow as tf; assert importlib.util.find_spec('essentia') is not None; print('TensorFlow:', tf.__version__); print('Essentia package present: OK')"

# Create models directory
RUN mkdir -p /app/models

# Download MusiCNN models from essentia.upf.edu/models/
# Each download is verified against a pinned sha256 digest (roadmap F38); a
# mismatch fails the build immediately instead of shipping a tampered or
# corrupted model. Digests measured 2026-07-11 (see docs/modernization-roadmap.md F38).
# Base embedding model
RUN curl -L -o /app/models/msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.pb" && \
    echo "cdea0722bcee7f731286843f2233e3aa69887bb5c3e2dce011eff55f38d04f3e  /app/models/msd-musicnn-1.pb" | sha256sum -c -

# Mood classification heads (using MusiCNN embeddings)
RUN curl -L -o /app/models/mood_happy-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_happy/mood_happy-msd-musicnn-1.pb" && \
    echo "d7382bc60304ea4578c298222968cd8d600c31252c7bf3e90b1f728ebb3ec36d  /app/models/mood_happy-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_sad-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_sad/mood_sad-msd-musicnn-1.pb" && \
    echo "a5e908cf7f59e8c379ff7c7d138dd85416985fddaebb5de14ca4193200411f61  /app/models/mood_sad-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_relaxed-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb" && \
    echo "1252d28ca7d2204e34e0cdf84a00aa2bc9627a87bdcf923df3aad39cfa69d2d9  /app/models/mood_relaxed-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_aggressive-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_aggressive/mood_aggressive-msd-musicnn-1.pb" && \
    echo "3b6eb5645e4b47a2ceb28ef3f8612f224640c583048770791b9fc6e8e5627a67  /app/models/mood_aggressive-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_party-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb" && \
    echo "765b096300ee1d92103cb0a122fc12c33882166fb94d37875284e82ce06322a1  /app/models/mood_party-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_acoustic-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_acoustic/mood_acoustic-msd-musicnn-1.pb" && \
    echo "519ee3af8210fe32e021002a0094546aeb6fb5a59d22b7d53c48e4ee1ac9e6cc  /app/models/mood_acoustic-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/mood_electronic-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb" && \
    echo "86c109b504fc6cf666c7513d684381a594218a552c3c954f212dd3a9d0c6cdc5  /app/models/mood_electronic-msd-musicnn-1.pb" | sha256sum -c -

# Other classification heads
RUN curl -L -o /app/models/danceability-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb" && \
    echo "874a4b86afc9e12de3f15a47baf9ff1ac676ace109c56203e26103f2259eb95e  /app/models/danceability-msd-musicnn-1.pb" | sha256sum -c - && \
    curl -L -o /app/models/voice_instrumental-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb" && \
    echo "eb762cc7ee6751b2ea32179d3716e2d60a1d1a9e615b7e3b8be8a6f79d71675e  /app/models/voice_instrumental-msd-musicnn-1.pb" | sha256sum -c -

# Verify models downloaded
RUN echo "Models downloaded:" && ls -lh /app/models/

# Install other dependencies
RUN pip3 install --no-cache-dir redis psycopg2-binary 'numpy>=1.19.0,<2.0.0'

# Copy application code
COPY services/audio-analyzer/analyzer.py /app/analyzer.py
COPY services/common /app/services/common

# Create non-root user
RUN useradd -m -u 1000 analyzer && \
    chown -R analyzer:analyzer /app

USER analyzer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD pgrep -f "python.*analyzer" || exit 1

CMD ["python3", "analyzer.py"]
