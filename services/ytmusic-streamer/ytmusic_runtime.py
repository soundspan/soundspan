"""Shared composition, logging, paths, and cross-cutting helpers."""

import os
import sys
from functools import partial
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI

_MODULE_PATH = Path(__file__).resolve()
if len(_MODULE_PATH.parents) >= 3:
    REPOSITORY_ROOT = _MODULE_PATH.parents[2]
    if (REPOSITORY_ROOT / "services").is_dir() and str(REPOSITORY_ROOT) not in sys.path:
        sys.path.append(str(REPOSITORY_ROOT))

from services.common.logging_utils import configure_service_logger
from services.common.sidecar_runtime_utils import (
    ensure_repository_root_on_path,
    install_urllib3_pool_warning_throttle,
    register_error_handlers,
    require_internal_secret,
    sanitized_http_error,
)

ensure_repository_root_on_path(__file__)

JsonObject = dict[str, Any]
JsonList = list[JsonObject]

# ── Logging ─────────────────────────────────────────────────────────
log = configure_service_logger("ytmusic-streamer")
install_urllib3_pool_warning_throttle()
_sanitized_http_error = partial(sanitized_http_error, log)

# ── FastAPI app ─────────────────────────────────────────────────────
app = FastAPI(
    title="soundspan YouTube Music Streamer",
    version="1.0.0",
    dependencies=[Depends(require_internal_secret)],
    # The docs/openapi routes are registered via add_route(), which app-level
    # dependencies do NOT cover — left on they'd disclose the full API schema
    # unauthenticated. Internal M2M service, no docs consumer: disable them.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
register_error_handlers(app, log)

# ── Paths ───────────────────────────────────────────────────────────
DATA_PATH = Path(os.getenv("DATA_PATH", "/data"))

# Realistic browser User-Agent for yt-dlp and httpx proxy requests
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def _bound_cache(cache: dict[str, JsonObject], max_size: int) -> None:
    """Evict oldest entries; callers must hold the owning cache's lock."""
    while len(cache) > max_size:
        cache.pop(next(iter(cache)))
