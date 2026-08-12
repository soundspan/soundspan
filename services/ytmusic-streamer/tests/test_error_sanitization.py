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
