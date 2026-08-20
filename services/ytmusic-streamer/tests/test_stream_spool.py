"""Behavioral tests for the YouTube Music stream spool."""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from httpx import AsyncClient, Response

VIDEO_ID = "dQw4w9WgXcQ"
QUALITY = "HIGH"


def _wake_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Wake the Python 3.14 test loop after a worker callback queues work."""
    if loop.is_closed():
        raise AssertionError("Cannot wake a closed event loop")

    def schedule_wakes() -> None:
        loop.call_later(0.001, lambda: None)
        loop.call_later(0.002, lambda: None)

    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if running_loop is loop:
        schedule_wakes()
    else:
        loop.call_soon_threadsafe(schedule_wakes)


def _signal_async_event(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    """Set an event from a worker thread and wake its waiter."""
    loop.call_soon_threadsafe(event.set)
    _wake_event_loop(loop)


async def _await_file_response(task: asyncio.Task[Response]) -> Response:
    """Keep the Python 3.14 test loop waking while FileResponse uses AnyIO threads."""
    for _ in range(200):
        if task.done():
            return await task
        await asyncio.sleep(0.01)
    raise TimeoutError("FileResponse test did not finish")


class CapturingExecutor:
    """Thread executor that exposes the latest submitted future to tests."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=2)
        self.latest: Future[tuple[str, str]] | None = None

    def submit(
        self, function: Callable[..., tuple[str, str]], /, *args: Any
    ) -> Future[tuple[str, str]]:
        self.latest = self._executor.submit(function, *args)
        return self.latest

    def wake_loop_on_completion(self, loop: asyncio.AbstractEventLoop) -> None:
        """Wake the loop after its executor-future callback is queued."""
        if self.latest is None:
            raise AssertionError("No spool download was submitted")
        self.latest.add_done_callback(lambda _finished: _wake_event_loop(loop))

    def shutdown(self) -> None:
        """Join all worker threads owned by this test executor."""
        self._executor.shutdown(wait=True, cancel_futures=True)


@pytest.fixture()
def stream_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Any]:
    """Provide isolated spool state for one test."""
    import ytmusic_stream

    ytmusic_stream._spool_tasks.clear()
    monkeypatch.setattr(ytmusic_stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    executor = CapturingExecutor()
    try:
        monkeypatch.setattr(ytmusic_stream, "_yt_dlp_spool_executor", executor)
        yield ytmusic_stream
    finally:
        ytmusic_stream._spool_tasks.clear()
        executor.shutdown()


@pytest.mark.parametrize(
    ("suffix", "expected"),
    [
        (".m4a", "audio/mp4"),
        (".mp4", "audio/mp4"),
        (".aac", "audio/mp4"),
        (".webm", "audio/webm"),
        (".opus", "audio/webm"),
        (".bin", "application/octet-stream"),
    ],
)
def test_spool_content_type_maps_audio_containers(
    stream_module: Any, suffix: str, expected: str
) -> None:
    path = Path(f"track{suffix}")

    assert stream_module._spool_content_type(path) == expected


def test_spool_candidates_return_newest_valid_file(stream_module: Any, tmp_path: Path) -> None:
    missing_dir = tmp_path / "missing"
    stream_module.YTMUSIC_SPOOL_DIR = missing_dir
    assert stream_module._spool_candidates(VIDEO_ID, QUALITY) == []
    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) is None

    missing_dir.mkdir()
    oldest = missing_dir / f"{VIDEO_ID}-{QUALITY}.m4a"
    newest = missing_dir / f"{VIDEO_ID}-{QUALITY}.webm"
    zero_byte = missing_dir / f"{VIDEO_ID}-{QUALITY}.aac"
    partial = missing_dir / f"{VIDEO_ID}-{QUALITY}.m4a.part"
    auxiliary = missing_dir / f"{VIDEO_ID}-{QUALITY}.webm.ytdl"
    unrelated = missing_dir / "unrelated.m4a"
    for path, body in (
        (oldest, b"old"),
        (newest, b"new"),
        (zero_byte, b""),
        (partial, b"partial"),
        (auxiliary, b"aux"),
        (unrelated, b"other"),
    ):
        path.write_bytes(body)
    now = time.time()
    os.utime(oldest, (now - 20, now - 20))
    os.utime(newest, (now - 10, now - 10))

    assert stream_module._spool_candidates(VIDEO_ID, QUALITY) == [newest, oldest]
    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) == newest


def test_prune_spool_evicts_oldest_completed_files(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 12)
    paths = [tmp_path / f"track-{index}.m4a" for index in range(3)]
    now = time.time()
    for index, path in enumerate(paths):
        path.write_bytes(b"123456")
        os.utime(path, (now + index, now + index))

    stream_module._prune_spool()

    assert not paths[0].exists()
    assert paths[1].exists()
    assert paths[2].exists()


def test_prune_spool_honors_exclude(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 12)
    paths = [tmp_path / f"track-{index}.m4a" for index in range(3)]
    now = time.time()
    for index, path in enumerate(paths):
        path.write_bytes(b"123456")
        os.utime(path, (now + index, now + index))

    stream_module._prune_spool(exclude=paths[0])

    assert paths[0].exists()
    assert not paths[1].exists()
    assert paths[2].exists()


def test_prune_spool_removes_only_stale_partials(stream_module: Any, tmp_path: Path) -> None:
    stale_part = tmp_path / "stale.m4a.part"
    stale_aux = tmp_path / "stale.webm.ytdl"
    fresh_part = tmp_path / "fresh.m4a.part"
    for path in (stale_part, stale_aux, fresh_part):
        path.write_bytes(b"partial")
    stale_time = time.time() - stream_module._SPOOL_PARTIAL_STALE_SECONDS - 1
    os.utime(stale_part, (stale_time, stale_time))
    os.utime(stale_aux, (stale_time, stale_time))

    stream_module._prune_spool()

    assert not stale_part.exists()
    assert not stale_aux.exists()
    assert fresh_part.exists()


def test_hls_formats_keep_progressive_last_resort(stream_module: Any) -> None:
    for selector in stream_module._YTMUSIC_HLS_FORMATS.values():
        assert "protocol=m3u8" in selector
        assert selector.endswith("/ba/b")


@pytest.mark.anyio
async def test_concurrent_spool_requests_share_one_download(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    calls = 0
    lookups = 0
    expected = (str(tmp_path / "track.m4a"), "audio/mp4")

    def find_spool(video_id: str, quality: str) -> None:
        nonlocal lookups
        lookups += 1

    def slow_download(video_id: str, quality: str) -> tuple[str, str]:
        nonlocal calls
        calls += 1
        _signal_async_event(loop, started)
        if not release.wait(timeout=2):
            raise HTTPException(status_code=500, detail="test release timed out")
        return expected

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", slow_download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", find_spool)
    first = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    try:
        await started.wait()
        stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
        second = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
        await asyncio.sleep(0)
        assert lookups == 2
        assert calls == 1
    finally:
        release.set()

    first_result, second_result = await asyncio.wait_for(asyncio.gather(first, second), timeout=2)
    assert first_result == expected
    assert second_result == expected
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_failed_spool_request_is_not_reused(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    calls = 0

    def failed_download(video_id: str, quality: str) -> tuple[str, str]:
        nonlocal calls
        calls += 1
        _signal_async_event(loop, started)
        raise HTTPException(status_code=502, detail="download failed")

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", failed_download)

    first = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    await started.wait()
    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
    with pytest.raises(HTTPException, match="download failed"):
        await first
    assert stream_module._spool_tasks == {}

    started.clear()
    second = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    await started.wait()
    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
    with pytest.raises(HTTPException, match="download failed"):
        await second
    assert calls == 2
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_waiter_timeout_keeps_single_flight_until_download_finishes(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    expected = (str(tmp_path / "track.m4a"), "audio/mp4")

    def slow_download(video_id: str, quality: str) -> tuple[str, str]:
        _signal_async_event(loop, started)
        if not release.wait(timeout=2):
            raise HTTPException(status_code=500, detail="test release timed out")
        return expected

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", slow_download)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TIMEOUT", 0.05)

    try:
        with pytest.raises(HTTPException) as raised:
            await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY)
        assert started.is_set()
        assert raised.value.status_code == 504
        assert raised.value.detail == "YouTube Music spool timed out"
        shared_task = stream_module._spool_tasks[f"{VIDEO_ID}:{QUALITY}"]
        assert not shared_task.done()
    finally:
        release.set()

    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
    await asyncio.sleep(0.01)
    assert await shared_task == expected
    await asyncio.sleep(0)
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_proxy_endpoint_serves_full_and_range_responses(
    client: AsyncClient,
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    body = b"stream body"

    def write_spool(video_id: str, quality: str) -> tuple[str, str]:
        path = tmp_path / f"{video_id}-{quality}.m4a"
        path.write_bytes(body)
        return str(path), "audio/mp4"

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", write_spool)

    full_request = asyncio.create_task(client.get(f"/proxy/{VIDEO_ID}?user_id=__public__"))
    response = await _await_file_response(full_request)
    range_request = asyncio.create_task(
        client.get(
            f"/proxy/{VIDEO_ID}?user_id=__public__",
            headers={"Range": "bytes=0-3"},
        )
    )
    ranged = await _await_file_response(range_request)

    assert response.status_code == 200
    assert response.content == body
    assert response.headers["accept-ranges"] == "bytes"
    assert ranged.status_code == 206
    assert ranged.content == body[:4]
    assert ranged.headers["accept-ranges"] == "bytes"
