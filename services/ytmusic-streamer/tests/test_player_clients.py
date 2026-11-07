"""Tests for the yt-dlp player clients used by YouTube extraction."""

from __future__ import annotations

import importlib
from collections.abc import Sequence
from types import ModuleType
from typing import Any, cast

import pytest
from yt_dlp.extractor.youtube import YoutubeIE

# The client registry is private and deliberately imported here so dependency
# upgrades fail when configured client names or JavaScript requirements change.
from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS

VIDEO_ID = "dQw4w9WgXcQ"
REVIEWED_JS_PLAYER_CLIENTS = {"web", "web_safari"}
CLIENT_CONFIG_NAMES = (
    "YTMUSIC_INFO_PLAYER_CLIENTS",
    "YTMUSIC_INFO_FALLBACK_PLAYER_CLIENTS",
    "YTMUSIC_SPOOL_PLAYER_CLIENTS",
    "YTMUSIC_SPOOL_FALLBACK_PLAYER_CLIENTS",
    "YT_PLAYER_CLIENTS",
)
PRIMARY_CLIENT_CONFIG_NAMES = (
    "YTMUSIC_INFO_PLAYER_CLIENTS",
    "YTMUSIC_SPOOL_PLAYER_CLIENTS",
    "YT_PLAYER_CLIENTS",
)


@pytest.fixture()
def stream_module() -> ModuleType:
    """Import the stream module after the shared path fixture is active."""
    return importlib.import_module("ytmusic_stream")


def _configured_clients(stream_module: ModuleType, config_name: str) -> Sequence[str]:
    """Return one configured player-client sequence by its public constant name."""
    owner = (
        importlib.import_module("yt_download")
        if config_name == "YT_PLAYER_CLIENTS"
        else stream_module
    )
    clients = getattr(owner, config_name)
    assert isinstance(clients, (list, tuple))
    assert all(isinstance(client, str) for client in clients)
    return cast(Sequence[str], clients)


def _effective_clients(configured: Sequence[str]) -> set[str]:
    """Expand default/all clients and apply exclusions like yt-dlp."""
    effective: set[str] = set()
    excluded: set[str] = set()
    for client in configured:
        if client == "default":
            effective.update(YoutubeIE._DEFAULT_CLIENTS)
        elif client == "all":
            effective.update(INNERTUBE_CLIENTS)
        elif client.startswith("-"):
            excluded.add(client[1:])
        else:
            effective.add(client)
    return effective - excluded


def _capture_stream_info_options(
    stream_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Capture the yt-dlp options passed by the stream-info builder."""
    captured: dict[str, dict[str, Any]] = {}

    def capture(
        _cache_key: str,
        _url: str,
        ydl_opts: dict[str, Any],
        _video_id: str,
        _error_label: str,
        *,
        fallback_opts: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        captured["primary"] = ydl_opts
        assert fallback_opts is not None
        captured["fallback"] = fallback_opts
        return {}

    monkeypatch.setattr(stream_module, "_extract_stream_info", capture)
    stream_module._get_stream_url_sync("__public__", VIDEO_ID, "HIGH")
    return captured["primary"], captured["fallback"]


def _build_spool_options(stream_module: ModuleType) -> dict[str, Any]:
    """Build spool options with inert callbacks."""

    def match_filter(*_args: Any) -> None:
        return None

    def progress_hook(_status: dict[str, Any]) -> None:
        return None

    return cast(
        dict[str, Any],
        stream_module._build_ytmusic_spool_options(
            VIDEO_ID,
            "HIGH",
            match_filter=match_filter,
            progress_hook=progress_hook,
        ),
    )


@pytest.mark.parametrize("config_name", CLIENT_CONFIG_NAMES)
def test_named_player_clients_exist(stream_module: ModuleType, config_name: str) -> None:
    clients = _configured_clients(stream_module, config_name)

    for client in clients:
        if client in {"default", "all"} or client.startswith("-"):
            continue
        assert client in INNERTUBE_CLIENTS, f"dead yt-dlp player client: {client}"


# Fallback constants deliberately allow JavaScript-player clients.
@pytest.mark.parametrize("config_name", PRIMARY_CLIENT_CONFIG_NAMES)
def test_effective_clients_have_no_unreviewed_js_player(
    stream_module: ModuleType, config_name: str
) -> None:
    clients = _effective_clients(_configured_clients(stream_module, config_name))

    for client in sorted(clients):
        metadata = INNERTUBE_CLIENTS.get(client)
        requires_js = metadata is not None and metadata.get("REQUIRE_JS_PLAYER")
        assert not requires_js or client in REVIEWED_JS_PLAYER_CLIENTS, (
            f"yt-dlp now selects JS-player client {client} for {config_name}, "
            "which starts a ~300 MiB Deno solver per lookup; review it and exclude it "
            "in the player-client constants"
        )


def test_stream_info_uses_ytmusic_player_clients(
    stream_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    options, fallback_options = _capture_stream_info_options(stream_module, monkeypatch)
    player_clients = options["extractor_args"]["youtube"]["player_client"]
    fallback_clients = fallback_options["extractor_args"]["youtube"]["player_client"]

    assert isinstance(player_clients, list)
    assert player_clients == ["default", "-tv_samsung"]
    assert "android_music" not in player_clients
    assert fallback_clients == ["default"]


def test_spool_uses_ytmusic_player_clients(stream_module: ModuleType) -> None:
    options = _build_spool_options(stream_module)
    player_clients = options["extractor_args"]["youtube"]["player_client"]

    assert isinstance(player_clients, list)
    assert player_clients == ["default", "-tv_samsung", "web_safari"]


def test_player_client_builders_return_fresh_lists(
    stream_module: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    first_info, first_info_fallback = _capture_stream_info_options(stream_module, monkeypatch)
    first_spool = _build_spool_options(stream_module)
    first_info_clients = first_info["extractor_args"]["youtube"]["player_client"]
    first_info_fallback_clients = first_info_fallback["extractor_args"]["youtube"]["player_client"]
    first_spool_clients = first_spool["extractor_args"]["youtube"]["player_client"]
    first_info_clients.append("mutated")
    first_info_fallback_clients.append("mutated")
    first_spool_clients.append("mutated")

    second_info, second_info_fallback = _capture_stream_info_options(stream_module, monkeypatch)
    second_spool = _build_spool_options(stream_module)
    assert tuple(stream_module.YTMUSIC_INFO_PLAYER_CLIENTS) == ("default", "-tv_samsung")
    assert tuple(stream_module.YTMUSIC_SPOOL_PLAYER_CLIENTS) == (
        "default",
        "-tv_samsung",
        "web_safari",
    )
    assert tuple(stream_module.YTMUSIC_INFO_FALLBACK_PLAYER_CLIENTS) == ("default",)
    assert tuple(stream_module.YTMUSIC_SPOOL_FALLBACK_PLAYER_CLIENTS) == (
        "default",
        "web_safari",
    )
    assert second_info["extractor_args"]["youtube"]["player_client"] == [
        "default",
        "-tv_samsung",
    ]
    assert second_info_fallback["extractor_args"]["youtube"]["player_client"] == ["default"]
    assert second_spool["extractor_args"]["youtube"]["player_client"] == [
        "default",
        "-tv_samsung",
        "web_safari",
    ]
