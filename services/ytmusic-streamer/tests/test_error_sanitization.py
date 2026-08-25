"""Future-contract tests for sanitizing internal errors in HTTP responses."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

MARKER = "sekrit-yt-abc123"
LOGGER_NAME = "ytmusic-streamer"


def test_shared_http_error_logs_detail_and_returns_generic_exception(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep provider details in logs while returning only the stable client detail."""
    import app  # noqa: F401 -- the runtime bootstraps the shared module path
    from common.sidecar_runtime_utils import sanitized_http_error

    logger = logging.getLogger("ytmusic-shared-error-test")
    with caplog.at_level(logging.ERROR, logger=logger.name):
        try:
            raise RuntimeError(MARKER)
        except RuntimeError as error:
            result = sanitized_http_error(logger, "shared operation", error, 502, "Safe detail")

    assert result.status_code == 502
    assert result.detail == "Safe detail"
    assert MARKER in caplog.text


def test_shared_pool_warning_filter_throttles_repeated_warnings(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Install the shared throttle in YouTube Music and suppress repeated warnings."""
    pool_logger = logging.getLogger("urllib3.connectionpool")
    previous_filters = list(pool_logger.filters)
    pool_logger.filters.clear()
    try:
        import app  # noqa: F401 -- importing the runtime installs the shared filter

        with caplog.at_level(logging.WARNING, logger=pool_logger.name):
            pool_logger.warning("Connection pool is full, discarding connection: one")
            pool_logger.warning("Connection pool is full, discarding connection: two")
    finally:
        pool_logger.filters[:] = previous_filters

    messages = [record.getMessage() for record in caplog.records if record.name == pool_logger.name]
    assert messages == [
        "urllib3 connection pool saturated; suppressing repeated pool-full warnings for 300s. "
        "Increase upstream pool size if this persists."
    ]


def test_shared_pool_warning_filter_installs_once() -> None:
    """Repeated installs (module reimports) must not stack duplicate filters."""
    from common.sidecar_runtime_utils import (
        _ThrottlePoolFullWarning,
        install_urllib3_pool_warning_throttle,
    )

    pool_logger = logging.getLogger("urllib3.connectionpool")
    previous_filters = list(pool_logger.filters)
    pool_logger.filters.clear()
    try:
        install_urllib3_pool_warning_throttle()
        install_urllib3_pool_warning_throttle()
        throttle_filters = [
            f for f in pool_logger.filters if isinstance(f, _ThrottlePoolFullWarning)
        ]
        assert len(throttle_filters) == 1
    finally:
        pool_logger.filters[:] = previous_filters


@pytest.mark.anyio
async def test_auth_status_reason_sanitized(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Auth status must log internal detail without returning it to clients."""
    import app

    monkeypatch.setattr(app, "DATA_PATH", tmp_path)
    (tmp_path / "oauth_u1.json").write_text("{}", encoding="utf-8")

    def raise_internal_error(user_id: Any) -> Any:
        """Simulate credential initialization exposing sensitive detail."""
        raise Exception(MARKER)

    monkeypatch.setattr(app, "_get_ytmusic", raise_internal_error)
    caplog.set_level(logging.WARNING, logger=LOGGER_NAME)

    response = await client.get("/auth/status?user_id=u1")

    assert response.status_code == 200
    assert response.json()["authenticated"] is False
    assert MARKER not in response.text
    assert any(
        record.name == LOGGER_NAME
        and record.levelno >= logging.WARNING
        and MARKER in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.anyio
async def test_device_code_init_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Device-code failures must keep logged exception details out of responses."""
    import app

    class FailingOAuthCredentials:
        """Raise sensitive detail while constructing OAuth credentials."""

        def __init__(self, client_id: Any, client_secret: Any) -> None:
            raise Exception(MARKER)

    monkeypatch.setattr(app, "OAuthCredentials", FailingOAuthCredentials)
    caplog.set_level(logging.WARNING, logger=LOGGER_NAME)

    response = await client.post(
        "/auth/device-code",
        json={"client_id": "c", "client_secret": "s"},
    )

    assert response.status_code == 500
    assert MARKER not in response.text
    assert any(
        record.name == LOGGER_NAME
        and record.levelno >= logging.WARNING
        and MARKER in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.anyio
async def test_search_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Search failures must keep logged exception details out of responses."""
    import app

    def raise_internal_error(
        user_id: Any, query: Any, filter_: Any, limit: Any, use_unauth_client: bool = True
    ) -> Any:
        """Simulate a search implementation failure with sensitive detail."""
        raise Exception(MARKER)

    monkeypatch.setattr(app, "_search_with_mode_fallback", raise_internal_error)
    caplog.set_level(logging.WARNING, logger=LOGGER_NAME)

    response = await client.post("/search?user_id=u1", json={"query": "q"})

    assert response.status_code == 500
    assert MARKER not in response.text
    assert any(
        record.name == LOGGER_NAME
        and record.levelno >= logging.WARNING
        and MARKER in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.anyio
async def test_home_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Home failures must keep logged exception details out of responses."""
    import app

    def raise_internal_error(mode: Any) -> Any:
        """Simulate public YTMusic client creation failing with sensitive detail."""
        raise Exception(MARKER)

    monkeypatch.setattr(app, "_get_public_ytmusic", raise_internal_error)
    caplog.set_level(logging.WARNING, logger=LOGGER_NAME)

    response = await client.get("/home?user_id=u1")

    assert response.status_code == 500
    assert MARKER not in response.text
    assert any(
        record.name == LOGGER_NAME
        and record.levelno >= logging.WARNING
        and MARKER in record.getMessage()
        for record in caplog.records
    )


def test_stream_extraction_error_sanitized(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Stream extraction must log internal detail but return a generic 502."""
    import app

    class FailingYoutubeDL:
        """Minimal yt-dlp context manager that fails during extraction."""

        def __init__(self, options: Any) -> None:
            self.options = options

        def __enter__(self) -> Any:
            return self

        def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
            return False

        def extract_info(self, url: Any, download: Any) -> Any:
            raise Exception(MARKER)

    yt_dlp_stub = SimpleNamespace(YoutubeDL=FailingYoutubeDL)
    monkeypatch.setitem(sys.modules, "yt_dlp", yt_dlp_stub)
    monkeypatch.setattr(app._extract_pacer, "wait", lambda: 0.0)
    app._stream_cache.clear()
    caplog.set_level(logging.WARNING, logger=LOGGER_NAME)

    with pytest.raises(HTTPException) as excinfo:
        app._get_yt_stream_url_sync("dQw4w9WgXcQ", "HIGH")

    assert excinfo.value.status_code == 502
    assert MARKER not in str(excinfo.value.detail)
    assert any(
        record.name == LOGGER_NAME
        and record.levelno >= logging.WARNING
        and MARKER in record.getMessage()
        for record in caplog.records
    )
