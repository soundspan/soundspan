"""Behavioral tests for the YouTube Music stream spool."""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast

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


class GatedSpoolDownload:
    """Controllable async spool download used to exercise task callbacks."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.failing_keys: set[str] = set()

    async def __call__(self, video_id: str, quality: str) -> tuple[str, str]:
        self.started.set()
        await self.release.wait()
        if f"{video_id}:{quality}" in self.failing_keys:
            raise HTTPException(status_code=502, detail="download failed")
        return (f"{video_id}-{quality}.m4a", "audio/mp4")

    def reset(self, *failing_keys: str) -> None:
        """Close the prior phase and prepare a new gated phase."""
        self.started.clear()
        self.release.clear()
        self.failing_keys = set(failing_keys)


async def _assert_spool_task_completion_lifecycle(
    stream_module: Any, download: GatedSpoolDownload
) -> None:
    """Prove success and failure callbacks both decrement pending jobs."""
    success = stream_module._create_spool_task("success:HIGH", "success", "HIGH")
    await asyncio.wait_for(download.started.wait(), timeout=1)
    assert stream_module._spool_pending_jobs == 1
    download.release.set()
    assert await success == ("success-HIGH.m4a", "audio/mp4")
    assert stream_module._spool_pending_jobs == 0

    download.reset("failure:HIGH")
    failure = stream_module._create_spool_task("failure:HIGH", "failure", "HIGH")
    await asyncio.wait_for(download.started.wait(), timeout=1)
    assert stream_module._spool_pending_jobs == 1
    download.release.set()
    with pytest.raises(HTTPException, match="download failed"):
        await failure
    assert stream_module._spool_pending_jobs == 0
    assert stream_module._spool_tasks == {}


async def _start_same_key_waiter(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    capacity_tasks: list[asyncio.Task[tuple[str, str]]],
) -> asyncio.Task[tuple[str, str]]:
    """Start and observe a same-key waiter while the queue is full."""
    real_await_spool_task = stream_module._await_spool_task
    existing_joined = asyncio.Event()

    async def record_existing_join(task: asyncio.Task[tuple[str, str]]) -> tuple[str, str]:
        if task is capacity_tasks[0]:
            existing_joined.set()
        return cast(tuple[str, str], await real_await_spool_task(task))

    monkeypatch.setattr(stream_module, "_await_spool_task", record_existing_join)
    waiter = asyncio.create_task(stream_module._get_ytmusic_spooled_stream("video-0", "HIGH"))
    await asyncio.wait_for(existing_joined.wait(), timeout=1)
    assert not waiter.done()
    return waiter


def _install_preflight_miss(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, dict[str, int]]:
    """Install a lookup whose first miss races with a completed file landing."""
    cached_path = tmp_path / f"{VIDEO_ID}-LOW.m4a"
    lookup_counts: dict[str, int] = {}

    def find_after_preflight_miss(video_id: str, quality: str) -> Path | None:
        key = f"{video_id}:{quality}"
        lookup_counts[key] = lookup_counts.get(key, 0) + 1
        if key == f"{VIDEO_ID}:LOW" and lookup_counts[key] == 1:
            cached_path.write_bytes(b"cached")
            return None
        return cached_path if key == f"{VIDEO_ID}:LOW" else None

    monkeypatch.setattr(stream_module, "_find_spooled_file", find_after_preflight_miss)
    return cached_path, lookup_counts


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


def test_spool_lookup_holds_prune_lock_while_scanning_and_touching(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    path.write_bytes(b"audio")
    lock_state = {"held": False}

    class TrackingLock:
        def __enter__(self) -> None:
            assert not lock_state["held"]
            lock_state["held"] = True

        def __exit__(self, *args: object) -> None:
            lock_state["held"] = False

    def guarded_candidates(video_id: str, quality: str) -> list[Path]:
        assert lock_state["held"]
        return [path]

    def guarded_touch(candidate: Path, times: object) -> None:
        assert candidate == path
        assert times is None
        assert lock_state["held"]

    monkeypatch.setattr(stream_module, "_spool_prune_lock", TrackingLock())
    monkeypatch.setattr(stream_module, "_spool_candidates", guarded_candidates)
    monkeypatch.setattr(stream_module.os, "utime", guarded_touch)

    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) == path
    assert not lock_state["held"]


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


def test_sync_spool_options_reject_live_streams(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import yt_dlp

    captured_options: dict[str, Any] = {}

    class CapturingYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            captured_options.update(options)

        def __enter__(self) -> CapturingYoutubeDL:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
            raise RuntimeError("stop after capturing options")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", CapturingYoutubeDL)

    with pytest.raises(HTTPException):
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    match_filter = captured_options["match_filter"]
    assert callable(match_filter)
    live_rejection = match_filter({"is_live": True, "title": "Live stream"})
    assert isinstance(live_rejection, str)
    assert live_rejection
    assert match_filter({"is_live": False, "title": "Recorded track"}) is None
    assert len(captured_options["progress_hooks"]) == 1


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
    tmp_path: Path,
) -> None:
    download = GatedSpoolDownload()
    monkeypatch.setattr(
        stream_module,
        "_download_ytmusic_spool_bounded",
        download,
    )
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    await _assert_spool_task_completion_lifecycle(stream_module, download)
    download.reset()
    capacity_tasks = [
        stream_module._create_spool_task(f"video-{index}:HIGH", f"video-{index}", "HIGH")
        for index in range(stream_module._SPOOL_MAX_PENDING_JOBS)
    ]
    assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
    existing_waiter = await _start_same_key_waiter(stream_module, monkeypatch, capacity_tasks)
    assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
    cached_path, lookup_counts = _install_preflight_miss(stream_module, monkeypatch, tmp_path)
    assert await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, "LOW") == (
        str(cached_path),
        "audio/mp4",
    )
    assert lookup_counts[f"{VIDEO_ID}:LOW"] == 2

    with pytest.raises(HTTPException) as raised:
        await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, "MEDIUM")
    assert raised.value.status_code == 503
    assert raised.value.detail == "YouTube Music spool queue is full"
    assert lookup_counts[f"{VIDEO_ID}:MEDIUM"] == 2

    download.release.set()
    completed = await asyncio.gather(*capacity_tasks)
    assert await existing_waiter == completed[0]
    assert stream_module._spool_pending_jobs == 0
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
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args: None)
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
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args: None)
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
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args: None)
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
