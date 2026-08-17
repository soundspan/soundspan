"""Runtime settings and immutable DCLAP embedding-space identity."""

from __future__ import annotations

import os

from services.common.analyzer_env import configure_thread_env, get_int_env

MODEL_VERSION = os.getenv("DCLAP_IMAGE_VERSION", "dclap-student-v1")
EMBEDDING_SPACE_FAMILY = "clap-music-audioset-dclap-student"
DCLAP_AUDIO_SHELL_HASH = "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971"
DCLAP_WEIGHTS_HASH = "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657"
DCLAP_TEXT_TOWER_HASH = "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714"
# sha256(audioShellHash + ":" + weightsHash + ":" + textTowerHash), using lowercase hex.
EMBEDDING_CHECKPOINT_HASH = "c892c7a8666dfa5adec5f0b76ecdd9b5394f5afa925d1362750309b6b9b96639"
EMBEDDING_DIM = 512
SAMPLE_RATE_HZ = 48000
HTTP_PORT = get_int_env("DCLAP_HTTP_PORT", 8092)
MODEL_IDLE_TIMEOUT = get_int_env("MODEL_IDLE_TIMEOUT", 300)
ONNX_INTRA_OP_THREADS = get_int_env("DCLAP_ONNX_INTRA_OP_THREADS", 1)
MODEL_DIRECTORY = os.getenv("DCLAP_MODEL_PATH", "/app/models")
TOKENIZER_DIRECTORY = os.getenv("DCLAP_TOKENIZER_PATH", "/app/tokenizer")

if HTTP_PORT <= 0 or HTTP_PORT > 65535:
    raise ValueError("DCLAP_HTTP_PORT must be between 1 and 65535")
if MODEL_IDLE_TIMEOUT < 0:
    raise ValueError("MODEL_IDLE_TIMEOUT must not be negative")
if ONNX_INTRA_OP_THREADS <= 0:
    raise ValueError("DCLAP_ONNX_INTRA_OP_THREADS must be positive")

configure_thread_env(ONNX_INTRA_OP_THREADS)

EMBEDDING_PREPROCESSING: dict[str, object] = {
    "sampleRateHz": SAMPLE_RATE_HZ,
    "mono": True,
    "int16RoundTrip": True,
    "clip": [-1.0, 1.0],
    "segmentSamples": 480000,
    "hopSamples": 240000,
    "mel": {
        "nFft": 2048,
        "hopLength": 480,
        "winLength": 2048,
        "nMels": 128,
        "fminHz": 0,
        "fmaxHz": 14000,
        "window": "hann",
        "center": True,
        "padMode": "reflect",
        "power": 2.0,
        "powerToDb": {"ref": 1.0, "amin": 1e-10, "topDb": None},
        "tensorLayout": "(1,1,128,time)",
    },
    "aggregation": "mean+l2-normalize",
    "normalizationEpsilon": 1e-9,
}
