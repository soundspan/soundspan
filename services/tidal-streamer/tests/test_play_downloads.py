"""Play downloads stream a TIDAL track to listeners while it downloads once."""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from typing import Any

import httpx
import pytest
from httpx import AsyncClient

HEADERS = {"Authorization": "Bearer tok-header"}
SEGMENTS = {
    "https://tidal.test/init": b"INIT",
    "https://tidal.test/seg-1": b"-ONE",
    "https://tidal.test/seg-2": b"-TWO",
}


def _plan(track_id: int = 7) -> Any:
    return types.SimpleNamespace(
        track_id=track_id,
        urls=list(SEGMENTS),
        file_extension=".flac",
        stream=types.SimpleNamespace(
            manifestMimeType="application/vnd.tidal.bts",
            audioQuality="LOSSLESS",
            bitDepth=16,
            sampleRate=44100,
        ),
    )


class _Recorder:
    def __init__(self) -> None:
        self.plans = 0
        self.installed: list[bytes] = []
        self.gate: asyncio.Event | None = None


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    """Fake the TIDAL plan, segment server, and library install."""
    import tidal_play_downloads

    rec = _Recorder()

    def fake_plan(*_args: Any, **_kwargs: Any) -> Any:
        rec.plans += 1
        return _plan()

    async def serve_segment(request: httpx.Request) -> httpx.Response:
        if rec.gate is not None and str(request.url).endswith("seg-2"):
            await rec.gate.wait()
        return httpx.Response(200, content=SEGMENTS[str(request.url)])

    def fake_install(_plan: Any, data: bytes) -> dict[str, Any]:
        rec.installed.append(data)
        return {"track_id": 7, "quality": "LOSSLESS", "relative_path": "A/B/01 - Song.flac"}

    monkeypatch.setattr(tidal_play_downloads, "_plan_track_download", fake_plan)
    monkeypatch.setattr(tidal_play_downloads, "_install_track_download", fake_install)
    monkeypatch.setattr(
        tidal_play_downloads,
        "build_stream_proxy_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(serve_segment)),
    )
    tidal_play_downloads._ACTIVE_BY_TRACK.clear()
    tidal_play_downloads._BY_ID.clear()
    return rec


async def _play(client: AsyncClient) -> httpx.Response:
    return await client.post(
        "/download/track/play",
        json={"track_id": 7, "quality": "HI_RES_LOSSLESS"},
        headers=HEADERS,
    )


@pytest.mark.anyio
async def test_play_streams_the_download_and_installs_the_same_bytes(
    client: AsyncClient, recorder: _Recorder
) -> None:
    """The listener hears exactly the bytes that end up in the library."""
    resp = await _play(client)

    assert resp.status_code == 200
    assert resp.content == b"INIT-ONE-TWO"
    assert resp.headers["content-type"] == "audio/flac"
    assert resp.headers["x-tidal-quality"] == "LOSSLESS"
    assert resp.headers["x-tidal-codec"] == "flac"
    assert resp.headers["x-tidal-bit-depth"] == "16"
    assert resp.headers["x-tidal-sample-rate"] == "44100"

    result = await client.get(f"/download/track/play/{resp.headers['x-download-id']}")

    assert result.status_code == 200
    assert result.json()["relative_path"] == "A/B/01 - Song.flac"
    assert recorder.installed == [b"INIT-ONE-TWO"]


@pytest.mark.anyio
async def test_listeners_of_a_running_download_share_one_fetch(
    client: AsyncClient, recorder: _Recorder
) -> None:
    """A second play joins the running download and replays it from the start."""
    recorder.gate = asyncio.Event()
    first = asyncio.create_task(_play(client))
    await asyncio.sleep(0.05)
    second = asyncio.create_task(_play(client))
    await asyncio.sleep(0.05)
    recorder.gate.set()

    first_resp, second_resp = await asyncio.gather(first, second)

    assert first_resp.content == second_resp.content == b"INIT-ONE-TWO"
    assert first_resp.headers["x-download-id"] == second_resp.headers["x-download-id"]
    assert recorder.plans == 1
    assert len(recorder.installed) == 1


@pytest.mark.anyio
async def test_download_finishes_after_every_listener_leaves(recorder: _Recorder) -> None:
    """Skipping a song still leaves the whole file in the library."""
    import tidal_play_downloads

    recorder.gate = asyncio.Event()
    fake_api: Any = object()
    download = await tidal_play_downloads.start_play_download(
        fake_api, 7, "HI_RES_LOSSLESS", "tmpl", Path("/music")
    )
    listener = tidal_play_downloads.listen(download)
    assert await anext(listener) == b"INIT"
    await listener.aclose()
    recorder.gate.set()

    result = await tidal_play_downloads.wait_play_download(download)

    assert result["relative_path"] == "A/B/01 - Song.flac"
    assert recorder.installed == [b"INIT-ONE-TWO"]
    assert download.listeners == 0
    assert download.chunks == []


@pytest.mark.anyio
async def test_play_reports_an_expired_token_as_401(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, recorder: _Recorder
) -> None:
    """The backend refreshes the admin token and retries before any audio."""
    import tidal_play_downloads
    from tiddl.core.api import ApiError

    error: Exception = ApiError("The token has expired.")
    vars(error).update(status=401, sub_status=11003)

    def expired_plan(*_args: Any, **_kwargs: Any) -> Any:
        raise error

    monkeypatch.setattr(tidal_play_downloads, "_plan_track_download", expired_plan)

    resp = await _play(client)

    assert resp.status_code == 401


@pytest.mark.anyio
async def test_failed_install_is_reported_without_details(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, recorder: _Recorder
) -> None:
    """A download that cannot be installed fails its result request."""
    import tidal_play_downloads

    def broken_install(_plan: Any, _data: bytes) -> Any:
        raise OSError("disk full at /music/secret")

    monkeypatch.setattr(tidal_play_downloads, "_install_track_download", broken_install)

    resp = await _play(client)
    result = await client.get(f"/download/track/play/{resp.headers['x-download-id']}")

    assert result.status_code == 502
    assert "secret" not in result.text


@pytest.mark.anyio
async def test_unknown_play_download_is_404(client: AsyncClient, recorder: _Recorder) -> None:
    """Results are only kept for downloads this sidecar ran."""
    resp = await client.get("/download/track/play/not-a-download")

    assert resp.status_code == 404


def test_plan_and_install_split_keeps_track_downloads_working(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_download_track_sync` still plans, downloads, and installs in one call."""
    import tidal_downloads

    plan = types.SimpleNamespace(urls=["u1", "u2"])
    calls: list[Any] = []

    def fake_plan(*args: Any) -> Any:
        calls.append(("plan", args[1:]))
        return plan

    def fake_install(got_plan: Any, data: bytes) -> dict[str, Any]:
        calls.append(("install", got_plan is plan, data))
        return {"ok": True}

    monkeypatch.setattr(tidal_downloads, "_plan_track_download", fake_plan)
    monkeypatch.setattr(tidal_downloads, "_install_track_download", fake_install)
    fake_download_module = types.ModuleType("tiddl.core.utils.download")
    vars(fake_download_module)["download"] = lambda urls: b"".join(u.encode() for u in urls)
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.download", fake_download_module)

    fake_api: Any = object()
    result = tidal_downloads._download_track_sync(fake_api, 9, "HIGH", "tmpl", tmp_path)

    assert result == {"ok": True}
    assert calls == [("plan", (9, "HIGH", "tmpl", tmp_path)), ("install", True, b"u1u2")]
