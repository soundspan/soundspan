# CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity
FROM python:3.10-slim

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

# Install Python dependencies
COPY services/audio-analyzer-clap/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Create models directory
RUN mkdir -p /app/models

# Download CLAP model at build time
# Using music_audioset checkpoint for music-specific embeddings
RUN --mount=type=secret,id=hf_token \
    HF_TOKEN=$(cat /run/secrets/hf_token) \
    set -e; \
    MODEL_URL="https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt"; \
    if [ -n "${HF_TOKEN}" ]; then \
        curl -L -H "Authorization: Bearer ${HF_TOKEN}" -o /app/models/music_audioset_epoch_15_esc_90.14.pt "${MODEL_URL}"; \
    else \
        curl -L -o /app/models/music_audioset_epoch_15_esc_90.14.pt "${MODEL_URL}"; \
    fi

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
