"""Tests for opt-in yt-dlp JavaScript-client fallback behavior."""

from __future__ import annotations

import importlib
import logging
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest
from fastapi import HTTPException
from yt_dlp.utils import DownloadError

VIDEO_ID = "dQw4w9WgXcQ"
QUALITY = "HIGH"


@pytest.fixture()
def fallback_module() -> ModuleType:
    """Import the fallback policy after the shared path fixture is active."""
    return importlib.import_module("ytmusic_js_fallback")


@pytest.fixture()
def stream_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[ModuleType]:
    """Provide isolated stream caches and spool storage."""
    module = importlib.import_module("ytmusic_stream")
    module._stream_cache.clear()
    monkeypatch.setattr(module, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(module._extract_pacer, "wait", lambda: None)
    yield module
    module._stream_cache.clear()


@pytest.mark.parametrize("raw", ["1", "true", "yes", "on", " TRUE "])
def test_parse_bool_flag_accepts_truthy_spellings(fallback_module: ModuleType, raw: str) -> None:
    assert fallback_module.parse_bool_flag(raw) is True


@pytest.mark.parametrize("raw", [None, "", " ", "0", "false", "no", "off", " FALSE "])
def test_parse_bool_flag_accepts_falsy_spellings(
    fallback_module: ModuleType, raw: str | None
) -> None:
    assert fallback_module.parse_bool_flag(raw) is False


def test_parse_bool_flag_rejects_unknown_value_with_warning(
    fallback_module: ModuleType, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="ytmusic-streamer"):
        result = fallback_module.parse_bool_flag("sometimes")

    assert result is False
    assert "YTMUSIC_JS_CLIENT_FALLBACK" in caplog.text
    assert "sometimes" in caplog.text


def test_generic_download_error_is_fallback_eligible(fallback_module: ModuleType) -> None:
    assert fallback_module.is_fallback_eligible(DownloadError("provider failed")) is True


def test_age_restricted_error_is_not_fallback_eligible(fallback_module: ModuleType) -> None:
    error = DownloadError("Sign in to confirm your age")

    assert fallback_module.is_fallback_eligible(error) is False


def test_direct_spool_limit_is_not_fallback_eligible(fallback_module: ModuleType) -> None:
    error = fallback_module.SpoolLimitExceeded("downloaded bytes exceeded")

    assert fallback_module.is_fallback_eligible(error) is False


@pytest.mark.parametrize("chain_attr", ["__cause__", "__context__"])
def test_chained_spool_limit_is_not_fallback_eligible(
    fallback_module: ModuleType, chain_attr: str
) -> None:
    outer = DownloadError("provider failed")
    inner = fallback_module.SpoolLimitExceeded("downloaded bytes exceeded")
    setattr(outer, chain_attr, inner)

    assert fallback_module.is_fallback_eligible(outer) is False


def test_download_error_exc_info_spool_limit_is_not_fallback_eligible(
    fallback_module: ModuleType,
) -> None:
    try:
        raise fallback_module.SpoolLimitExceeded("downloaded bytes exceeded")
    except fallback_module.SpoolLimitExceeded:
        error = DownloadError("provider failed", exc_info=sys.exc_info())

    assert fallback_module.is_fallback_eligible(error) is False


def test_fallback_eligibility_walk_stops_on_exception_cycle(
    fallback_module: ModuleType,
) -> None:
    first = DownloadError("first")
    second = RuntimeError("second")
    first.__cause__ = second
    second.__context__ = first

    assert fallback_module.is_fallback_eligible(first) is True


def test_fallback_disabled_reraises_primary_error(
    fallback_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary_error = DownloadError("primary failed")
    fallback_calls = 0
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", False)

    def primary() -> str:
        raise primary_error

    def fallback() -> str:
        nonlocal fallback_calls
        fallback_calls += 1
        return "fallback"

    with pytest.raises(DownloadError) as raised:
        fallback_module.run_with_js_fallback(primary, fallback, label="stream info for test")

    assert raised.value is primary_error
    assert fallback_calls == 0


def test_eligible_failure_returns_fallback_result(
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    def primary() -> str:
        raise DownloadError("primary failed")

    with caplog.at_level(logging.WARNING, logger="ytmusic-streamer"):
        result = fallback_module.run_with_js_fallback(
            primary,
            lambda: "fallback",
            label="stream info for test",
        )

    assert result == "fallback"
    assert "primary clients failed" in caplog.text.lower()


def test_ineligible_failure_does_not_call_fallback(
    fallback_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary_error = fallback_module.SpoolLimitExceeded("downloaded bytes exceeded")
    fallback_calls = 0
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    def primary() -> str:
        raise primary_error

    def fallback() -> str:
        nonlocal fallback_calls
        fallback_calls += 1
        return "fallback"

    with pytest.raises(fallback_module.SpoolLimitExceeded) as raised:
        fallback_module.run_with_js_fallback(primary, fallback, label="spool for test")

    assert raised.value is primary_error
    assert fallback_calls == 0


def test_busy_fallback_slot_reraises_primary_error(
    fallback_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary_error = DownloadError("primary failed")
    fallback_calls = 0
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)
    monkeypatch.setattr(fallback_module, "JS_FALLBACK_SLOT_WAIT_SECONDS", 0.01)
    assert fallback_module._JS_FALLBACK_SLOT.acquire(blocking=False)

    def primary() -> str:
        raise primary_error

    def fallback() -> str:
        nonlocal fallback_calls
        fallback_calls += 1
        return "fallback"

    try:
        with pytest.raises(DownloadError) as raised:
            fallback_module.run_with_js_fallback(primary, fallback, label="stream info for test")
    finally:
        fallback_module._JS_FALLBACK_SLOT.release()

    assert raised.value is primary_error
    assert fallback_calls == 0


def test_fallback_error_propagates_and_releases_slot(
    fallback_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    fallback_error = RuntimeError("fallback failed")
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    def primary() -> str:
        raise DownloadError("primary failed")

    def fallback() -> str:
        raise fallback_error

    with pytest.raises(RuntimeError) as raised:
        fallback_module.run_with_js_fallback(primary, fallback, label="stream info for test")

    assert raised.value is fallback_error
    assert fallback_module._JS_FALLBACK_SLOT.acquire(blocking=False)
    fallback_module._JS_FALLBACK_SLOT.release()


def _install_stream_info_youtube_dl(
    monkeypatch: pytest.MonkeyPatch,
) -> list[list[str]]:
    import yt_dlp

    attempts: list[list[str]] = []

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            clients = options["extractor_args"]["youtube"]["player_client"]
            attempts.append(cast(list[str], clients))

        def __enter__(self) -> FakeYoutubeDL:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def extract_info(self, _url: str, *, download: bool) -> dict[str, Any]:
            assert download is False
            if len(attempts) == 1:
                raise DownloadError("primary failed")
            return {"url": "https://media.invalid/audio", "audio_ext": "m4a"}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)
    return attempts


def test_stream_info_retries_with_fallback_clients_and_caches_result(
    stream_module: ModuleType,
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = _install_stream_info_youtube_dl(monkeypatch)
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    first = stream_module._get_stream_url_sync("__public__", VIDEO_ID, QUALITY)
    second = stream_module._get_stream_url_sync("__public__", VIDEO_ID, QUALITY)

    assert first["url"] == "https://media.invalid/audio"
    assert second == first
    assert attempts == [["default", "-tv_samsung"], ["default"]]


def test_stream_info_does_not_retry_when_fallback_disabled(
    stream_module: ModuleType,
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = _install_stream_info_youtube_dl(monkeypatch)
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", False)

    with pytest.raises(HTTPException) as raised:
        stream_module._get_stream_url_sync("__public__", VIDEO_ID, QUALITY)

    assert raised.value.status_code == 502
    assert attempts == [["default", "-tv_samsung"]]


def _install_spool_youtube_dl(
    stream_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    primary_error: Callable[[], BaseException],
) -> list[list[str]]:
    import yt_dlp

    attempts: list[list[str]] = []

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            self.options = options
            clients = options["extractor_args"]["youtube"]["player_client"]
            attempts.append(cast(list[str], clients))

        def __enter__(self) -> FakeYoutubeDL:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def extract_info(self, _url: str, *, download: bool) -> dict[str, str]:
            assert download is True
            if len(attempts) == 1:
                raise primary_error()
            output = stream_module.YTMUSIC_SPOOL_DIR / f"{VIDEO_ID}-{QUALITY}.m4a"
            output.write_bytes(b"audio")
            return {"id": VIDEO_ID}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)
    return attempts


def test_spool_retries_with_fallback_clients(
    stream_module: ModuleType,
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = _install_spool_youtube_dl(
        stream_module,
        monkeypatch,
        lambda: DownloadError("primary failed"),
    )
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    path, content_type = stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    assert Path(path).read_bytes() == b"audio"
    assert content_type == "audio/mp4"
    assert attempts == [
        ["default", "-tv_samsung", "web_safari"],
        ["default", "web_safari"],
    ]


def test_spool_limit_failure_does_not_retry(
    stream_module: ModuleType,
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = _install_spool_youtube_dl(
        stream_module,
        monkeypatch,
        lambda: fallback_module.SpoolLimitExceeded("downloaded bytes exceeded"),
    )
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", True)

    with pytest.raises(HTTPException) as raised:
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    assert raised.value.status_code == 502
    assert attempts == [["default", "-tv_samsung", "web_safari"]]


def test_spool_does_not_retry_when_fallback_disabled(
    stream_module: ModuleType,
    fallback_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = _install_spool_youtube_dl(
        stream_module,
        monkeypatch,
        lambda: DownloadError("primary failed"),
    )
    monkeypatch.setattr(fallback_module, "JS_CLIENT_FALLBACK_ENABLED", False)

    with pytest.raises(HTTPException) as raised:
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    assert raised.value.status_code == 502
    assert attempts == [["default", "-tv_samsung", "web_safari"]]
