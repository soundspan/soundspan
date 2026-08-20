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


async def _await_async_event(event: asyncio.Event) -> None:
    """Keep the Python 3.14 test loop waking until a worker signals an event."""
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError("Worker event was not signaled")


async def _run_inline(function: Callable[..., Any], *args: Any) -> Any:
    """Run an asyncio.to_thread target inline for deterministic unit tests."""
    return function(*args)


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
    ytmusic_stream._spool_pending_jobs = 0
    monkeypatch.setattr(ytmusic_stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    executor = CapturingExecutor()
    try:
        monkeypatch.setattr(ytmusic_stream, "_yt_dlp_spool_executor", executor)
        yield ytmusic_stream
    finally:
        ytmusic_stream._spool_tasks.clear()
        ytmusic_stream._spool_pending_jobs = 0
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
    paths = [tmp_path / f"AAAAAAAAAA{index}-{QUALITY}.m4a" for index in range(3)]
    now = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 10
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
    paths = [tmp_path / f"BBBBBBBBBB{index}-{QUALITY}.m4a" for index in range(3)]
    now = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 10
    for index, path in enumerate(paths):
        path.write_bytes(b"123456")
        os.utime(path, (now + index, now + index))

    stream_module._prune_spool(exclude=paths[0])

    assert paths[0].exists()
    assert not paths[1].exists()
    assert paths[2].exists()


def test_prune_spool_removes_only_stale_partials(stream_module: Any, tmp_path: Path) -> None:
    stale_part = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a.part"
    stale_aux = tmp_path / f"{VIDEO_ID}-LOW.webm.ytdl"
    fresh_part = tmp_path / f"{VIDEO_ID}-MEDIUM.m4a.part"
    for path in (stale_part, stale_aux, fresh_part):
        path.write_bytes(b"partial")
    stale_time = time.time() - stream_module._SPOOL_PARTIAL_STALE_SECONDS - 1
    os.utime(stale_part, (stale_time, stale_time))
    os.utime(stale_aux, (stale_time, stale_time))

    stream_module._prune_spool()

    assert not stale_part.exists()
    assert not stale_aux.exists()
    assert fresh_part.exists()


def test_prune_spool_keeps_young_completed_files(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 1)
    path = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    path.write_bytes(b"over budget")

    stream_module._prune_spool()

    assert path.exists()

    old = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 1
    os.utime(path, (old, old))
    stream_module._prune_spool()

    assert not path.exists()


def test_prune_spool_ignores_files_it_does_not_own(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 1)
    owned_completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    owned_partial = tmp_path / f"{VIDEO_ID}-LOW.webm.part"
    unowned_paths = [
        tmp_path / "shared-data.m4a",
        tmp_path / f"{VIDEO_ID}-ULTRA.m4a",
        tmp_path / "shared-data.webm.part",
        tmp_path / f"{VIDEO_ID}-ULTRA.webm.ytdl",
    ]
    for path in (owned_completed, owned_partial, *unowned_paths):
        path.write_bytes(b"shared")
    old = time.time() - stream_module._SPOOL_PARTIAL_STALE_SECONDS - 1
    for path in (owned_completed, owned_partial, *unowned_paths):
        os.utime(path, (old, old))

    total, entries = stream_module._collect_spool_entries()

    assert total == owned_completed.stat().st_size
    assert [entry[2] for entry in entries] == [owned_completed]
    assert not owned_partial.exists()

    stream_module._prune_spool()

    assert not owned_completed.exists()
    assert all(path.exists() for path in unowned_paths)


def test_hls_formats_keep_progressive_last_resort(stream_module: Any) -> None:
    for selector in stream_module._YTMUSIC_HLS_FORMATS.values():
        assert "protocol=m3u8" in selector
        assert selector.endswith("/ba/b")


def test_spool_progress_hook_rejects_oversized_download(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 10)
    hook = stream_module._build_spool_progress_hook(time.monotonic())

    with pytest.raises(Exception, match="downloaded bytes"):
        hook({"downloaded_bytes": 11})


def test_spool_progress_hook_rejects_elapsed_timeout(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT", 0.1)
    hook = stream_module._build_spool_progress_hook(time.monotonic() - 1)

    with pytest.raises(Exception, match="download timeout"):
        hook({"downloaded_bytes": 0})


def test_spool_progress_hook_allows_progress_under_limits(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 10)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT", 10)
    hook = stream_module._build_spool_progress_hook(time.monotonic())

    hook({"downloaded_bytes": 10})


def test_spool_options_include_live_filter_and_progress_hook(stream_module: Any) -> None:
    def match_filter(info: dict[str, Any]) -> None:
        return None

    def progress_hook(status: dict[str, Any]) -> None:
        return None

    options = stream_module._build_ytmusic_spool_options(
        VIDEO_ID,
        QUALITY,
        match_filter=match_filter,
        progress_hook=progress_hook,
    )

    assert options["match_filter"] is match_filter
    assert options["progress_hooks"] == [progress_hook]


def test_sync_spool_deletes_completed_file_over_total_budget(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import yt_dlp

    completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 4)

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            self.options = options

        def __enter__(self) -> FakeYoutubeDL:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
            completed.write_bytes(b"12345")
            return {"id": VIDEO_ID}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)

    with pytest.raises(HTTPException):
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    assert not completed.exists()


@pytest.mark.anyio
async def test_concurrent_spool_requests_share_one_download(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    calls = 0
    lookups = 0
    to_thread_calls = 0
    expected = (str(tmp_path / "track.m4a"), "audio/mp4")

    async def run_inline(function: Callable[..., Any], *args: Any) -> Any:
        nonlocal to_thread_calls
        to_thread_calls += 1
        return function(*args)

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
    monkeypatch.setattr(stream_module.asyncio, "to_thread", run_inline)
    first = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    try:
        await _await_async_event(started)
        stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
        second = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
        await asyncio.sleep(0)
        assert lookups == 1
        assert to_thread_calls == 1
        assert calls == 1
    finally:
        release.set()

    for _ in range(200):
        if first.done() and second.done():
            break
        await asyncio.sleep(0.01)
    assert first.done()
    assert second.done()
    first_result, second_result = await asyncio.gather(first, second)
    assert first_result == expected
    assert second_result == expected
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_spool_queue_rejects_new_key_but_joins_existing_task(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = ("existing.m4a", "audio/mp4")
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    tasks: list[asyncio.Future[tuple[str, str]]] = [
        asyncio.get_running_loop().create_future()
        for _ in range(stream_module._SPOOL_MAX_PENDING_JOBS)
    ]
    keys = [f"video-{index}:HIGH" for index in range(len(tasks))]
    stream_module._spool_tasks.update(zip(keys, tasks, strict=True))
    stream_module._spool_pending_jobs = len(tasks)

    try:
        queue_request = asyncio.create_task(
            stream_module._get_ytmusic_spooled_stream(VIDEO_ID, "LOW")
        )
        for _ in range(200):
            if queue_request.done():
                break
            await asyncio.sleep(0.01)
        assert queue_request.done()
        with pytest.raises(HTTPException) as raised:
            await queue_request
        assert raised.value.status_code == 503
        assert raised.value.detail == "YouTube Music spool queue is full"

        existing_waiter = asyncio.create_task(
            stream_module._get_ytmusic_spooled_stream("video-0", "HIGH")
        )
        await asyncio.sleep(0)
        assert not existing_waiter.done()
        for task in tasks:
            task.set_result(expected)
        assert await asyncio.wait_for(existing_waiter, timeout=1) == expected
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=1,
        )
        stream_module._spool_tasks.clear()
        stream_module._spool_pending_jobs = 0


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
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    first = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    await _await_async_event(started)
    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
    with pytest.raises(HTTPException, match="download failed"):
        await first
    assert stream_module._spool_tasks == {}

    started.clear()
    second = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    await _await_async_event(started)
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
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

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
    for _ in range(200):
        if shared_task.done():
            break
        await asyncio.sleep(0.01)
    assert shared_task.done()
    assert shared_task.result() == expected
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
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

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
