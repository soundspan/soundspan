"""Shared composition, logging, paths, and TIDAL client construction."""

import os
from functools import partial
from pathlib import Path
from typing import Any, Protocol, cast

from fastapi import Depends, FastAPI
from tidal_downloads import AlbumAPIProtocol, TrackDownloadAPIProtocol
from tiddl.core.api import TidalAPI, TidalClient

from services.common.logging_utils import configure_service_logger
from services.common.sidecar_runtime_utils import (
    install_urllib3_pool_warning_throttle,
    register_error_handlers,
    require_internal_secret,
    sanitized_http_error,
)

JsonObject = dict[str, Any]


class TidalAPIProtocol(TrackDownloadAPIProtocol, AlbumAPIProtocol, Protocol):
    """Typed boundary for the complete tiddl surface used by the service."""

    def get_session(self) -> Any: ...

    def get_search(self, query: str) -> Any: ...


log = configure_service_logger("tidal-streamer")
install_urllib3_pool_warning_throttle()
_sanitized_http_error = partial(sanitized_http_error, log)

app = FastAPI(
    title="soundspan TIDAL Streamer",
    version="2.0.0",
    dependencies=[Depends(require_internal_secret)],
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
register_error_handlers(app, log)

TIDDL_PATH = Path(os.getenv("TIDDL_PATH", "/data/.tiddl"))
MUSIC_PATH = Path(os.getenv("MUSIC_PATH", "/music"))


def _build_api(access_token: str, user_id: str, country_code: str) -> TidalAPIProtocol:
    """Create a fresh TidalAPI client from stored credentials."""
    cache_path = TIDDL_PATH / "api_cache"
    client = TidalClient(
        token=access_token,
        cache_name=str(cache_path),
        omit_cache=True,
    )
    return cast(TidalAPIProtocol, TidalAPI(client, user_id=user_id, country_code=country_code))
