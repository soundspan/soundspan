# DCLAP student ONNX provider for CPU-first vibe embeddings
FROM python:3.12-slim@sha256:876416ecde9aca2bcc90e1fb0c7a9500bbf749f5788b70f82d4c5a5c2357f8b4

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    DCLAP_ONNX_INTRA_OP_THREADS=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false \
    DCLAP_MODEL_PATH=/app/models \
    DCLAP_TOKENIZER_PATH=/app/tokenizer

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    libgomp1 \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Hash-locked, reproducible install (roadmap F50); the lock is re-resolved
# with the uv command recorded in requirements.lock.README.
COPY services/vibe-provider-dclap/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# pip is build-time tooling only; removing it from the runtime image drops
# its vendored dependencies (msgpack, setuptools metadata) from the scan
# surface alongside the other removed network tools.
RUN python3 -m pip uninstall -y pip

RUN mkdir -p /app/models /app/tokenizer /app/licenses/dclap

# Vendor the immutable upstream v1 release artifacts and fail on any byte drift.
RUN set -eu; \
    RELEASE_URL="https://github.com/NeptuneHub/AudioMuse-AI-DCLAP/releases/download/v1"; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/models/model_epoch_36.onnx "${RELEASE_URL}/model_epoch_36.onnx"; \
    echo "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971  /app/models/model_epoch_36.onnx" | sha256sum -c -; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/models/model_epoch_36.onnx.data "${RELEASE_URL}/model_epoch_36.onnx.data"; \
    echo "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657  /app/models/model_epoch_36.onnx.data" | sha256sum -c -; \
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 \
        --output /app/models/clap_text_model.onnx "${RELEASE_URL}/clap_text_model.onnx"; \
    echo "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714  /app/models/clap_text_model.onnx" | sha256sum -c -

# Vendor only tokenizer assets from an immutable Hugging Face snapshot. Runtime
# offline flags make any accidental network fallback fail closed.
RUN set -eu; \
    TOKENIZER_REVISION="8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"; \
    TOKENIZER_URL="https://huggingface.co/laion/clap-htsat-unfused/resolve/${TOKENIZER_REVISION}"; \
    for TOKENIZER_FILE in config.json merges.txt special_tokens_map.json tokenizer.json tokenizer_config.json vocab.json; do \
        curl --fail --location --retry 3 --connect-timeout 30 --max-time 600 \
            --output "/app/tokenizer/${TOKENIZER_FILE}" "${TOKENIZER_URL}/${TOKENIZER_FILE}"; \
    done; \
    echo "9efb9557bc804f2ca6e394486af2e45dfed0b18554909735a99c6220b84e4288  /app/tokenizer/config.json" | sha256sum -c -; \
    echo "fe36cab26d4f4421ed725e10a2e9ddb7f799449c603a96e7f29b5a3c82a95862  /app/tokenizer/merges.txt" | sha256sum -c -; \
    echo "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f  /app/tokenizer/special_tokens_map.json" | sha256sum -c -; \
    echo "77ef92283d67f0d97e1454909a964afcbfa2019f0fb9f18f8e88d5c25c3ba729  /app/tokenizer/tokenizer.json" | sha256sum -c -; \
    echo "377f91458f7729a4574a84c77bdce67dbc3c58c1a345a29bbf8c4eb1307948a3  /app/tokenizer/tokenizer_config.json" | sha256sum -c -; \
    echo "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e  /app/tokenizer/vocab.json" | sha256sum -c -

COPY services/vibe-provider-dclap/__main__.py /app/__main__.py
COPY services/vibe-provider-dclap/http_server.py /app/http_server.py
COPY services/vibe-provider-dclap/inference.py /app/inference.py
COPY services/vibe-provider-dclap/model_provider.py /app/model_provider.py
COPY services/vibe-provider-dclap/music_path.py /app/music_path.py
COPY services/vibe-provider-dclap/preprocessing.py /app/preprocessing.py
COPY services/vibe-provider-dclap/settings.py /app/settings.py
COPY services/vibe-provider-dclap/LICENSE services/vibe-provider-dclap/NOTICE.md /app/licenses/dclap/
COPY services/common /app/services/common

RUN useradd --create-home --uid 1000 dclap && chown -R dclap:dclap /app

USER dclap

EXPOSE 8092

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS -H "X-Internal-Secret: ${INTERNAL_API_SECRET:-}" \
        "http://localhost:${DCLAP_HTTP_PORT:-8092}/health" || exit 1

CMD ["python", "__main__.py"]
