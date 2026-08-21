"""Tests for /library/playlists endpoint."""

from __future__ import annotations

import asyncio
import gc
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from ytmusicapi.exceptions import YTMusicServerError

# ---------------------------------------------------------------------------
# Sample data returned by ytmusicapi's get_library_playlists()
# ---------------------------------------------------------------------------
_SAMPLE_PLAYLISTS = [
    {
        "playlistId": "RDTMAK5uy_abc123",
        "title": "My Supermix",
        "thumbnails": [
            {"url": "http://img/small", "width": 120},
            {"url": "http://img/large", "width": 226},
        ],
        "count": "50+ songs",
        "description": "A mix of everything you love",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "RDEM_fresh456",
        "title": "Fresh finds, old favorites",
        "thumbnails": [{"url": "http://img/fresh", "width": 226}],
        "count": "50+ songs",
        "description": "Rediscover old gems alongside new picks",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "PLuserlist789",
        "title": "My Custom Playlist",
        "thumbnails": [{"url": "http://img/custom", "width": 226}],
        "count": "12 songs",
        "description": "",
        "author": [{"name": "Josh"}],
    },
    {
        "playlistId": "LM",
        "title": "Liked Music",
        "thumbnails": [],
        "count": "200 songs",
        "description": "All your liked songs",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "SE",
        "title": "Episodes for Later",
        "thumbnails": [],
        "count": "5 episodes",
        "description": "",
        "author": [{"name": "YouTube Music"}],
    },
]


def _provider_result(func: Any, playlists: list[dict[str, Any]]) -> Any:
    """Run a provider callback against a deterministic YTMusic fake."""
    return func(MagicMock(get_library_playlists=MagicMock(return_value=playlists)))


def _library_error(status_code: int, detail: str) -> HTTPException:
    """Build the stable HTTP error returned by the route in direct-call tests."""
    return HTTPException(status_code=status_code, detail=detail)


async def _capture_playlist_result(
    app: Any,
    user_id: str = "shared-user",
    limit: int = 25,
    mixes_only: bool = False,
) -> Any:
    """Return either the playlist payload or its mapped HTTP error."""
    try:
        return await app.library_playlists(user_id=user_id, limit=limit, mixes_only=mixes_only)
    except HTTPException as error:
        return error


async def _wait_for_ready_queue_turn() -> None:
    """Wait until callbacks already queued on the event loop have run."""
    ready = asyncio.Event()
    asyncio.get_running_loop().call_soon(ready.set)
    await ready.wait()


def _wake_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Wake the Python 3.14 test loop after a real worker settles."""

    def schedule_wakes() -> None:
        loop.call_later(0.001, lambda: None)
        loop.call_later(0.002, lambda: None)

    loop.call_soon_threadsafe(schedule_wakes)


class _CapturingThreadPoolExecutor:
    """Own real worker threads and expose submitted futures for deterministic wakes."""

    def __init__(self, max_workers: int, thread_name_prefix: str) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=thread_name_prefix,
        )
        self.jobs: list[Future[Any]] = []
        self.shutdown_started = threading.Event()
        self.shutdown_options: tuple[bool, bool] | None = None

    def submit(self, function: Callable[..., Any], /, *args: Any) -> Future[Any]:
        job = self._executor.submit(function, *args)
        self.jobs.append(job)
        return job

    def wake_job_on_completion(self, loop: asyncio.AbstractEventLoop, index: int) -> None:
        self.jobs[index].add_done_callback(lambda _job: _wake_event_loop(loop))

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        self.shutdown_options = (wait, cancel_futures)
        self.shutdown_started.set()
        self._executor.shutdown(wait=wait, cancel_futures=cancel_futures)


class _BlockingShutdownExecutor:
    """Hold executor shutdown until a test explicitly releases it."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.shutdown_started = threading.Event()
        self.shutdown_finished = threading.Event()
        self.release_shutdown = threading.Event()
        self.shutdown_options: tuple[bool, bool] | None = None

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        self.shutdown_options = (wait, cancel_futures)
        self.shutdown_started.set()
        for _attempt in range(200):
            if self.release_shutdown.wait(timeout=0.01):
                break
            _wake_event_loop(self.loop)
        self.shutdown_finished.set()


class _RepeatedTimeoutProvider:
    """Block two real provider calls, then expose one controlled recovery call."""

    concurrency = 2

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.all_started = asyncio.Event()
        self.recovered_started = asyncio.Event()
        self.release_timed_out = threading.Event()
        self.release_recovered = threading.Event()
        self.requests: list[asyncio.Task[Any]] = []
        self.calls = 0
        self._lock = threading.Lock()

    def __call__(self, uid: Any, operation: Any, func: Any) -> Any:
        try:
            call_number = self._reserve_call()
            if call_number <= self.concurrency:
                if not self.release_timed_out.wait(timeout=2):
                    raise TimeoutError("test provider release timed out")
                raise RuntimeError("late provider failure")
            self.loop.call_soon_threadsafe(self.recovered_started.set)
            _wake_event_loop(self.loop)
            if not self.release_recovered.wait(timeout=2):
                raise TimeoutError("test recovered provider release timed out")
            return _provider_result(func, [])
        finally:
            _wake_event_loop(self.loop)

    def _reserve_call(self) -> int:
        with self._lock:
            self.calls += 1
            if self.calls == self.concurrency:
                self.loop.call_soon_threadsafe(self.all_started.set)
            return self.calls

    def release_initial_jobs(self, executor: _CapturingThreadPoolExecutor) -> None:
        executor.wake_job_on_completion(self.loop, 0)
        executor.wake_job_on_completion(self.loop, 1)
        self.release_timed_out.set()

    def release_recovery_job(self, executor: _CapturingThreadPoolExecutor) -> None:
        executor.wake_job_on_completion(self.loop, 2)
        self.release_recovered.set()

    def release_all(self) -> None:
        self.release_timed_out.set()
        self.release_recovered.set()


async def _exercise_provider_pool_saturation(
    app: Any,
    monkeypatch: pytest.MonkeyPatch,
    executor: _CapturingThreadPoolExecutor,
    provider: _RepeatedTimeoutProvider,
) -> tuple[list[Any], HTTPException, Any]:
    """Drive real provider jobs through timeout, saturation, drain, and recovery."""
    providers_drained = asyncio.Event()
    original_consume = app._consume_library_playlist_provider_job

    def track_settlement(future: asyncio.Future[Any]) -> None:
        original_consume(future)
        if not app._library_playlist_provider_jobs:
            providers_drained.set()

    monkeypatch.setattr(app, "_consume_library_playlist_provider_job", track_settlement)
    with patch("app._run_ytmusic_with_auth_retry", side_effect=provider):
        provider.requests = [
            asyncio.create_task(_capture_playlist_result(app, "user-0")),
            asyncio.create_task(_capture_playlist_result(app, "user-1")),
        ]
        await asyncio.wait_for(provider.all_started.wait(), timeout=2)
        timed_out = await asyncio.gather(*provider.requests)
        saturated = await asyncio.wait_for(
            _capture_playlist_result(app, "saturated-user"), timeout=0.2
        )
        provider.release_initial_jobs(executor)
        await asyncio.wait_for(providers_drained.wait(), timeout=2)
        monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.5)
        recovered_task = asyncio.create_task(_capture_playlist_result(app, "recovered-user"))
        await asyncio.wait_for(provider.recovered_started.wait(), timeout=2)
        provider.release_recovery_job(executor)
        recovered = await asyncio.wait_for(recovered_task, timeout=1)
    return timed_out, saturated, recovered


class _JsonRequest:
    """Provide the JSON method used by the credential restore handler."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


@pytest.fixture(autouse=True)
def library_playlist_provider_runner(
    monkeypatch: pytest.MonkeyPatch,
    local_app_module: None,
) -> Callable[[str, int], Awaitable[list[dict[str, Any]]]]:
    """Run ordinary provider mocks inline; real-thread regressions restore the runner."""
    import app

    real_runner = cast(
        "Callable[[str, int], Awaitable[list[dict[str, Any]]]]",
        app._run_library_playlist_provider,
    )

    async def run_inline(user_id: str, limit: int) -> list[dict[str, Any]]:
        return cast("list[dict[str, Any]]", app._call_library_playlist_provider(user_id, limit))

    monkeypatch.setattr(app, "_run_library_playlist_provider", run_inline)
    return real_runner


class TestLibraryPlaylists:
    """Verify /library/playlists returns user's library playlists."""

    def test_provider_transport_session_has_bounded_request_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """YTMusic transport calls should carry the explicit provider timeout."""
        import app

        request = MagicMock(return_value=MagicMock())
        session = MagicMock()
        session.request = request
        monkeypatch.setattr(app.requests, "Session", MagicMock(return_value=session))

        configured_session = app._build_ytmusic_requests_session()
        configured_session.request("POST", "https://music.youtube.test/youtubei/v1/browse")

        request.assert_called_once_with(
            "POST",
            "https://music.youtube.test/youtubei/v1/browse",
            timeout=app.YTMUSIC_REQUEST_TIMEOUT_SECONDS,
        )

    @pytest.mark.anyio
    async def test_returns_playlists_for_authenticated_user(self, client: AsyncClient) -> None:
        """Should return formatted playlist data for an authenticated user."""
        mock_run = MagicMock(
            side_effect=lambda uid, operation, func: func(
                MagicMock(get_library_playlists=MagicMock(return_value=_SAMPLE_PLAYLISTS))
            )
        )

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            resp = await client.get("/library/playlists", params={"user_id": "user-1"})

        assert resp.status_code == 200
        data = resp.json()
        assert "playlists" in data
        assert data["total"] == len(_SAMPLE_PLAYLISTS)
        # Verify shape of first item
        first = data["playlists"][0]
        assert first["playlistId"] == "RDTMAK5uy_abc123"
        assert first["title"] == "My Supermix"
        assert first["thumbnails"] == _SAMPLE_PLAYLISTS[0]["thumbnails"]
        assert first["description"] == "A mix of everything you love"

    @pytest.mark.anyio
    async def test_returns_401_when_no_oauth(self, client: AsyncClient) -> None:
        """Should return 401 when user has no OAuth credentials."""

        def raise_401(uid: Any, operation: Any, func: Any) -> Any:
            raise HTTPException(status_code=401, detail="No OAuth credentials")

        with patch("app._run_ytmusic_with_auth_retry", side_effect=raise_401):
            resp = await client.get("/library/playlists", params={"user_id": "no-auth-user"})

        assert resp.status_code == 401

    @pytest.mark.anyio
    async def test_requires_user_id_parameter(self, client: AsyncClient) -> None:
        """Should return 422 when user_id is missing."""
        resp = await client.get("/library/playlists")
        assert resp.status_code == 422

    @pytest.mark.anyio
    async def test_passes_limit_to_ytmusicapi(self, client: AsyncClient) -> None:
        """Should forward the limit parameter to get_library_playlists."""
        captured_calls = []

        def capture_run(uid: Any, operation: Any, func: Any) -> Any:
            mock_yt = MagicMock()
            mock_yt.get_library_playlists.return_value = []
            result = func(mock_yt)
            captured_calls.append(mock_yt.get_library_playlists.call_args)
            return result

        with patch("app._run_ytmusic_with_auth_retry", side_effect=capture_run):
            resp = await client.get("/library/playlists", params={"user_id": "user-1", "limit": 10})

        assert resp.status_code == 200
        assert captured_calls[0] == ((10,),) or captured_calls[0].kwargs.get("limit") == 10

    @pytest.mark.anyio
    async def test_mixes_only_filter(self, client: AsyncClient) -> None:
        """When mixes_only=true, should filter to auto-generated playlists only."""
        mock_run = MagicMock(
            side_effect=lambda uid, operation, func: func(
                MagicMock(get_library_playlists=MagicMock(return_value=_SAMPLE_PLAYLISTS))
            )
        )

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            resp = await client.get(
                "/library/playlists",
                params={"user_id": "user-1", "mixes_only": "true"},
            )

        assert resp.status_code == 200
        data = resp.json()
        # Should exclude user-created playlists and special IDs (LM, SE)
        titles = [p["title"] for p in data["playlists"]]
        assert "My Supermix" in titles
        assert "Fresh finds, old favorites" in titles
        assert "My Custom Playlist" not in titles
        assert "Liked Music" not in titles
        assert "Episodes for Later" not in titles

    @pytest.mark.anyio
    async def test_negative_caches_upstream_400_per_request_shape(
        self, client: AsyncClient
    ) -> None:
        """A repeated upstream 400 should fail fast for the exact request shape."""
        import app

        app._library_playlist_error_cache.clear()
        mock_run = MagicMock(
            side_effect=YTMusicServerError(
                "Server returned HTTP 400: Bad Request. Request contains an invalid argument."
            )
        )

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            first = await client.get("/library/playlists", params={"user_id": "user-1"})
            second = await client.get("/library/playlists", params={"user_id": "user-1"})
            other_user = await client.get("/library/playlists", params={"user_id": "user-2"})

        assert first.status_code == 502
        assert second.status_code == 502
        assert second.json() == first.json()
        assert other_user.status_code == 502
        assert mock_run.call_count == 2

    @pytest.mark.anyio
    async def test_negative_cache_does_not_cross_mixes_only_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A mixes-only 400 must not suppress the same user's unfiltered request."""
        import app

        app._library_playlist_error_cache.clear()
        calls = 0

        def fail_mixes_then_succeed(uid: Any, operation: Any, func: Any) -> Any:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise YTMusicServerError("Server returned HTTP 400: Bad Request.")
            return _provider_result(func, [])

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            return function(*args, **kwargs)

        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        with patch("app._run_ytmusic_with_auth_retry", side_effect=fail_mixes_then_succeed):
            failed_mix = await _capture_playlist_result(app, "user-1", 25, True)
            unfiltered = await _capture_playlist_result(app, "user-1", 25, False)
            cached_mix = await _capture_playlist_result(app, "user-1", 25, True)

        assert failed_mix.status_code == 502
        assert unfiltered["total"] == 0
        assert cached_mix.status_code == 502
        assert calls == 2

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        ("outcome", "expected_status", "cache_seconds"),
        [
            pytest.param("success", None, 600, id="success"),
            pytest.param("transient", 500, 600, id="transient-error"),
            pytest.param("bad-request", 502, 0, id="negative-cache-disabled"),
        ],
    )
    async def test_concurrent_requests_share_one_flight_outcome(
        self,
        monkeypatch: pytest.MonkeyPatch,
        outcome: str,
        expected_status: int | None,
        cache_seconds: int,
    ) -> None:
        """All concurrent waiters should observe one task's success or error."""
        import app

        request_count = 6
        requests_ready = asyncio.Event()
        requests_started = 0
        release_requests = asyncio.Event()
        provider_started = asyncio.Event()
        release_provider = asyncio.Event()
        all_slots_reserved = asyncio.Event()
        reserved_slots = 0
        original_reserve = app._reserve_library_playlist_slot
        app._library_playlist_error_cache.clear()
        app._library_playlist_inflight.clear()
        monkeypatch.setattr(app, "LIBRARY_ERROR_CACHE_SECONDS", cache_seconds)

        async def reserve_slot(key: Any, deadline: float) -> Any:
            nonlocal reserved_slots
            slot = await original_reserve(key, deadline)
            reserved_slots += 1
            if reserved_slots == request_count:
                all_slots_reserved.set()
            return slot

        def run_upstream(uid: Any, operation: Any, func: Any) -> Any:
            if outcome == "success":
                return _provider_result(func, _SAMPLE_PLAYLISTS)
            if outcome == "transient":
                raise TimeoutError("provider timed out")
            raise YTMusicServerError("Server returned HTTP 400: Bad Request.")

        async def controlled_provider(user_id: str, limit: int) -> Any:
            provider_started.set()
            await release_provider.wait()
            return app._call_library_playlist_provider(user_id, limit)

        def sanitized_error(
            _operation: str,
            _error: Exception,
            status_code: int,
            detail: str,
        ) -> HTTPException:
            return _library_error(status_code, detail)

        async def request() -> Any:
            nonlocal requests_started
            requests_started += 1
            if requests_started == request_count:
                requests_ready.set()
            await release_requests.wait()
            return await _capture_playlist_result(app)

        monkeypatch.setattr(app, "_reserve_library_playlist_slot", reserve_slot)
        monkeypatch.setattr(app, "_run_library_playlist_provider", controlled_provider)
        mock_run = MagicMock(side_effect=run_upstream)
        with (
            patch("app._run_ytmusic_with_auth_retry", mock_run),
            patch("app._sanitized_http_error", side_effect=sanitized_error),
        ):
            requests = [asyncio.create_task(request()) for _ in range(request_count)]
            await requests_ready.wait()
            release_requests.set()
            await asyncio.wait_for(provider_started.wait(), timeout=2)
            await asyncio.wait_for(all_slots_reserved.wait(), timeout=2)
            release_provider.set()
            responses = await asyncio.gather(*requests)

        if expected_status is None:
            assert [response["total"] for response in responses] == [len(_SAMPLE_PLAYLISTS)] * 6
        else:
            assert [response.status_code for response in responses] == [
                expected_status
            ] * request_count
        assert mock_run.call_count == 1
        assert app._library_playlist_inflight == {}

    @pytest.mark.anyio
    async def test_cancelled_leader_keeps_shared_worker_until_failure_is_cached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Cancelling one waiter must not cancel or retire the shared provider task."""
        import app

        provider_started = asyncio.Event()
        release_provider = asyncio.Event()
        second_reserved = asyncio.Event()
        reservations = 0
        original_reserve = app._reserve_library_playlist_slot
        app._library_playlist_error_cache.clear()
        app._library_playlist_inflight.clear()

        async def reserve_slot(key: Any, deadline: float) -> Any:
            nonlocal reservations
            flight = await original_reserve(key, deadline)
            reservations += 1
            if reservations == 2:
                second_reserved.set()
            return flight

        async def controlled_provider(user_id: str, limit: int) -> Any:
            provider_started.set()
            await release_provider.wait()
            return app._call_library_playlist_provider(user_id, limit)

        mock_run = MagicMock(
            side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request.")
        )
        monkeypatch.setattr(app, "_reserve_library_playlist_slot", reserve_slot)
        monkeypatch.setattr(app, "_run_library_playlist_provider", controlled_provider)

        with (
            patch("app._run_ytmusic_with_auth_retry", mock_run),
            patch(
                "app._sanitized_http_error",
                side_effect=lambda _operation, _error, status, detail: _library_error(
                    status, detail
                ),
            ),
        ):
            leader = asyncio.create_task(_capture_playlist_result(app))
            await asyncio.wait_for(provider_started.wait(), timeout=2)
            leader.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leader
            assert len(app._library_playlist_inflight) == 1

            follower = asyncio.create_task(_capture_playlist_result(app))
            await asyncio.wait_for(second_reserved.wait(), timeout=2)
            assert not follower.done()
            release_provider.set()
            response = await follower
            cached = await _capture_playlist_result(app)

        assert response.status_code == 502
        assert cached.status_code == 502
        assert mock_run.call_count == 1
        assert ("shared-user", 25, False) in app._library_playlist_error_cache
        assert app._library_playlist_inflight == {}

    @pytest.mark.anyio
    async def test_saturated_registry_uses_request_deadline_and_recovers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A distinct request should fail within budget, then proceed after a slot frees."""
        import app

        provider_started = asyncio.Event()
        release_provider = asyncio.Event()
        app._library_playlist_inflight.clear()
        app._library_playlist_tasks.clear()
        monkeypatch.setattr(app, "LIBRARY_ERROR_CACHE_MAX", 1)
        monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.05)

        async def controlled_provider(user_id: str, limit: int) -> Any:
            provider_started.set()
            await release_provider.wait()
            return app._call_library_playlist_provider(user_id, limit)

        mock_run = MagicMock(side_effect=lambda uid, operation, func: _provider_result(func, []))
        monkeypatch.setattr(app, "_run_library_playlist_provider", controlled_provider)

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            first = asyncio.create_task(_capture_playlist_result(app, "user-1"))
            try:
                await asyncio.wait_for(provider_started.wait(), timeout=2)
                saturated = await asyncio.wait_for(
                    _capture_playlist_result(app, "user-2"), timeout=0.5
                )
                assert saturated.status_code == 503
                assert saturated.detail == app._LIBRARY_PLAYLIST_ERROR_DETAIL
            finally:
                release_provider.set()
                await first

            recovered = await asyncio.wait_for(_capture_playlist_result(app, "user-3"), timeout=0.5)

        assert recovered["total"] == 0
        assert mock_run.call_count == 2
        assert app._library_playlist_inflight == {}

    @pytest.mark.anyio
    async def test_repeated_real_thread_timeouts_retain_jobs_until_workers_settle(
        self,
        monkeypatch: pytest.MonkeyPatch,
        library_playlist_provider_runner: Callable[[str, int], Awaitable[list[dict[str, Any]]]],
    ) -> None:
        """Timed-out real threads should consume bounded admission until they settle."""
        import app

        executor = _CapturingThreadPoolExecutor(
            _RepeatedTimeoutProvider.concurrency,
            "test-library-playlists",
        )
        loop = asyncio.get_running_loop()
        provider = _RepeatedTimeoutProvider(loop)
        original_handler = loop.get_exception_handler()
        exception_contexts: list[dict[str, Any]] = []
        app._library_playlist_error_cache.clear()
        app._library_playlist_inflight.clear()
        app._library_playlist_tasks.clear()
        app._library_playlist_provider_jobs.clear()
        monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.05)
        monkeypatch.setattr(app, "_LIBRARY_PLAYLIST_PROVIDER_TIMEOUT_GRACE_SECONDS", 0.01)
        monkeypatch.setattr(app, "LIBRARY_PLAYLIST_PROVIDER_CONCURRENCY", provider.concurrency)
        monkeypatch.setattr(app, "_library_playlist_provider_executor", executor)
        monkeypatch.setattr(app, "_run_library_playlist_provider", library_playlist_provider_runner)
        loop.set_exception_handler(lambda _loop, context: exception_contexts.append(context))
        try:
            timed_out, saturated, recovered = await _exercise_provider_pool_saturation(
                app, monkeypatch, executor, provider
            )
            assert [response.status_code for response in timed_out] == [504, 504]
            assert saturated.status_code == 503
            assert saturated.detail == app._LIBRARY_PLAYLIST_ERROR_DETAIL
            assert not isinstance(recovered, HTTPException)
            assert recovered["total"] == 0
            assert provider.calls == provider.concurrency + 1
            assert app._library_playlist_provider_jobs == set()
            gc.collect()
            await _wait_for_ready_queue_turn()
            assert exception_contexts == []
        finally:
            loop.set_exception_handler(original_handler)
            provider.release_all()
            await asyncio.gather(*provider.requests, return_exceptions=True)
            executor.shutdown()

    @pytest.mark.anyio
    async def test_shutdown_drains_blocked_provider_and_rejects_new_admission(
        self,
        monkeypatch: pytest.MonkeyPatch,
        library_playlist_provider_runner: Callable[[str, int], Awaitable[list[dict[str, Any]]]],
    ) -> None:
        """Shutdown should stop intake before waiting for an owned worker to settle."""
        import app

        executor = _CapturingThreadPoolExecutor(1, "test-library-shutdown")
        loop = asyncio.get_running_loop()
        provider_started = asyncio.Event()
        release_provider = threading.Event()
        app._library_playlist_provider_jobs.clear()
        monkeypatch.setattr(app, "_library_playlist_provider_executor", executor)
        monkeypatch.setattr(app, "_library_playlist_provider_admitting", True)
        monkeypatch.setattr(app, "_run_library_playlist_provider", library_playlist_provider_runner)

        def blocked_provider(uid: Any, operation: Any, func: Any) -> Any:
            try:
                loop.call_soon_threadsafe(provider_started.set)
                _wake_event_loop(loop)
                if not release_provider.wait(timeout=2):
                    raise TimeoutError("test provider release timed out")
                return _provider_result(func, [])
            finally:
                _wake_event_loop(loop)

        shutdown_task: asyncio.Task[None] | None = None
        with patch("app._run_ytmusic_with_auth_retry", side_effect=blocked_provider):
            admitted = asyncio.create_task(_capture_playlist_result(app, "admitted-user"))
            try:
                await asyncio.wait_for(provider_started.wait(), timeout=2)
                shutdown_task = asyncio.create_task(app.shutdown())
                shutdown_started = await asyncio.to_thread(executor.shutdown_started.wait, 1)
                assert shutdown_started

                rejected = await _capture_playlist_result(app, "rejected-user")
                assert rejected.status_code == 503
                assert rejected.detail == app._LIBRARY_PLAYLIST_ERROR_DETAIL

                executor.wake_job_on_completion(loop, 0)
                release_provider.set()
                await asyncio.wait_for(shutdown_task, timeout=2)
                response = await asyncio.wait_for(admitted, timeout=2)
            finally:
                release_provider.set()
                if shutdown_task is not None:
                    await asyncio.gather(shutdown_task, return_exceptions=True)
                await asyncio.gather(admitted, return_exceptions=True)

        assert response["total"] == 0
        assert executor.shutdown_options == (True, True)

    @pytest.mark.anyio
    async def test_shutdown_stops_waiting_at_provider_drain_deadline(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Shutdown should return when a running provider cannot drain in time."""
        import app

        executor = _BlockingShutdownExecutor(asyncio.get_running_loop())
        monkeypatch.setattr(app, "_library_playlist_provider_executor", executor)
        monkeypatch.setattr(app, "_library_playlist_provider_admitting", True)
        monkeypatch.setattr(app, "_LIBRARY_PLAYLIST_PROVIDER_DRAIN_SECONDS", 0.02)

        try:
            await asyncio.wait_for(app.shutdown_library_playlist_provider(), timeout=0.5)
            assert executor.shutdown_started.is_set()
            assert not executor.shutdown_finished.is_set()
            assert not app._library_playlist_provider_admitting
            assert executor.shutdown_options == (True, True)
        finally:
            executor.release_shutdown.set()

        finished = await asyncio.to_thread(executor.shutdown_finished.wait, 1)
        assert finished

    @pytest.mark.anyio
    async def test_late_waiter_receives_shared_flight_internal_deadline_as_504(
        self,
        monkeypatch: pytest.MonkeyPatch,
        library_playlist_provider_runner: Callable[[str, int], Awaitable[list[dict[str, Any]]]],
    ) -> None:
        """A waiter joining after the leader timeout should keep the 504 contract."""
        import app

        executor = _CapturingThreadPoolExecutor(1, "test-late-waiter")
        provider_started = asyncio.Event()
        release_provider = threading.Event()
        loop = asyncio.get_running_loop()
        app._library_playlist_inflight.clear()
        app._library_playlist_tasks.clear()
        app._library_playlist_provider_jobs.clear()
        monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.2)
        monkeypatch.setattr(app, "_LIBRARY_PLAYLIST_PROVIDER_TIMEOUT_GRACE_SECONDS", 0.05)
        monkeypatch.setattr(app, "LIBRARY_PLAYLIST_PROVIDER_CONCURRENCY", 1)
        monkeypatch.setattr(app, "_library_playlist_provider_executor", executor)
        monkeypatch.setattr(app, "_run_library_playlist_provider", library_playlist_provider_runner)

        def blocked_provider(uid: Any, operation: Any, func: Any) -> Any:
            try:
                loop.call_soon_threadsafe(provider_started.set)
                _wake_event_loop(loop)
                if not release_provider.wait(timeout=2):
                    raise TimeoutError("test provider release timed out")
                return _provider_result(func, [])
            finally:
                _wake_event_loop(loop)

        try:
            with patch(
                "app._run_ytmusic_with_auth_retry", side_effect=blocked_provider
            ) as provider:
                leader_task = asyncio.create_task(_capture_playlist_result(app, "shared-user"))
                await asyncio.wait_for(provider_started.wait(), timeout=2)
                leader = await leader_task
                assert ("shared-user", 25, False) in app._library_playlist_inflight

                late_waiter = await asyncio.wait_for(
                    _capture_playlist_result(app, "shared-user"), timeout=0.2
                )

            assert leader.status_code == 504
            assert late_waiter.status_code == 504
            assert late_waiter.detail == leader.detail
            assert provider.call_count == 1
        finally:
            executor.wake_job_on_completion(loop, 0)
            release_provider.set()
            executor.shutdown()
            await _wait_for_ready_queue_turn()

    @pytest.mark.anyio
    async def test_credential_restore_clears_cached_failure(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Restored credentials should force the next request back upstream."""
        import app

        app._library_playlist_error_cache.clear()
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        calls = 0

        def fail_then_succeed(uid: Any, operation: Any, func: Any) -> Any:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise YTMusicServerError("Server returned HTTP 400: Bad Request.")
            return _provider_result(func, [])

        with patch("app._run_ytmusic_with_auth_retry", side_effect=fail_then_succeed):
            failed = await _capture_playlist_result(app, "user-1")
            restored = await app.auth_restore(_JsonRequest({"oauth_json": "{}"}), user_id="user-1")
            retried = await _capture_playlist_result(app, "user-1")

        assert failed.status_code == 502
        assert restored["status"] == "ok"
        assert retried["total"] == 0
        assert calls == 2

    @pytest.mark.anyio
    async def test_restore_write_failure_still_sweeps_credential_state(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A partial restore must invalidate state tied to the replaced OAuth file."""
        import app

        original_write = app._write_private_file
        writes = 0
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)

        def fail_client_credentials_write(path: Path, content: str) -> None:
            nonlocal writes
            writes += 1
            if writes == 2:
                app._ytmusic_instances["user-1"] = MagicMock()
                app._ytmusic_auto_tv_fallback_users.add("user-1")
                app._remember_library_playlist_error(("user-1", 25, False))
                raise OSError("client credentials write failed")
            original_write(path, content)

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            return function(*args, **kwargs)

        monkeypatch.setattr(app, "_write_private_file", fail_client_credentials_write)
        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        request = _JsonRequest({"oauth_json": "{}", "client_id": "cid", "client_secret": "secret"})

        with pytest.raises(OSError, match="client credentials write failed"):
            await app.auth_restore(request, user_id="user-1")

        assert app._oauth_file("user-1").exists()
        assert "user-1" not in app._ytmusic_instances
        assert "user-1" not in app._ytmusic_auto_tv_fallback_users
        assert not any(key[0] == "user-1" for key in app._library_playlist_error_cache)

    @pytest.mark.anyio
    async def test_device_code_cancellation_waits_for_oauth_write_before_sweep(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Cancellation must retain a real worker until token replacement settles."""
        import app

        class SuccessfulOAuthCredentials:
            """Return one deterministic replacement token."""

            def __init__(self, client_id: Any, client_secret: Any) -> None:
                pass

            def token_from_code(self, device_code: Any) -> dict[str, str]:
                return {"access_token": "access", "refresh_token": "refresh"}

        oauth_write_started = asyncio.Event()
        release_oauth_write = threading.Event()
        mutation_order: list[str] = []
        loop = asyncio.get_running_loop()
        original_finish = app.finish_library_credential_mutation
        original_write = app._write_private_file
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        monkeypatch.setattr(app, "OAuthCredentials", SuccessfulOAuthCredentials)
        app._library_playlist_error_cache.clear()

        def blocked_oauth_write(path: Path, content: str) -> None:
            if path == app._oauth_file("user-1"):
                loop.call_soon_threadsafe(oauth_write_started.set)
                if not release_oauth_write.wait(timeout=2):
                    raise TimeoutError("OAuth write was not released")
            original_write(path, content)
            if path == app._oauth_file("user-1"):
                mutation_order.append("write")

        async def tracked_finish(user_id: str, token: int) -> None:
            await original_finish(user_id, token)
            mutation_order.append("sweep")

        monkeypatch.setattr(app, "_write_private_file", blocked_oauth_write)
        monkeypatch.setattr(app, "finish_library_credential_mutation", tracked_finish)
        request = app.DeviceCodePollRequest(
            client_id="cid", client_secret="secret", device_code="dc"
        )
        with (
            patch(
                "app._run_ytmusic_with_auth_retry",
                side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request."),
            ),
            patch(
                "app._sanitized_http_error",
                side_effect=lambda _operation, _error, status, detail: _library_error(
                    status, detail
                ),
            ),
        ):
            poll_task = asyncio.create_task(app.auth_device_code_poll(request, user_id="user-1"))
            try:
                await asyncio.wait_for(oauth_write_started.wait(), timeout=2)
                poll_task.cancel()
                stale_response = await _capture_playlist_result(app, "user-1")
                assert stale_response.status_code == 502
                assert not poll_task.done()
                release_oauth_write.set()
                with pytest.raises(asyncio.CancelledError):
                    await poll_task
            finally:
                release_oauth_write.set()
                await asyncio.gather(poll_task, return_exceptions=True)

        assert app._oauth_file("user-1").exists()
        assert app._client_creds_file("user-1").exists()
        assert mutation_order == ["write", "sweep"]
        assert not any(key[0] == "user-1" for key in app._library_playlist_error_cache)

    @pytest.mark.anyio
    async def test_clear_cancellation_waits_for_both_unlinks_before_sweep(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Cancellation must not let a real worker skip the second credential unlink."""
        import app

        unlink_started = asyncio.Event()
        release_unlink = threading.Event()
        mutation_order: list[str] = []
        loop = asyncio.get_running_loop()
        original_finish = app.finish_library_credential_mutation
        original_unlink = app._unlink_if_exists
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        oauth_path = app._oauth_file("user-1")
        creds_path = app._client_creds_file("user-1")
        oauth_path.write_text("{}")
        creds_path.write_text("{}")

        def blocked_unlink(path: Path) -> None:
            if path == oauth_path:
                loop.call_soon_threadsafe(unlink_started.set)
                if not release_unlink.wait(timeout=2):
                    raise TimeoutError("Credential unlink was not released")
            original_unlink(path)
            mutation_order.append(path.name)

        async def tracked_finish(user_id: str, token: int) -> None:
            await original_finish(user_id, token)
            mutation_order.append("sweep")

        monkeypatch.setattr(app, "_unlink_if_exists", blocked_unlink)
        monkeypatch.setattr(app, "finish_library_credential_mutation", tracked_finish)
        clear_task = asyncio.create_task(app.auth_clear(user_id="user-1"))
        try:
            await asyncio.wait_for(unlink_started.wait(), timeout=2)
            clear_task.cancel()
            assert not clear_task.done()
            release_unlink.set()
            with pytest.raises(asyncio.CancelledError):
                await clear_task
        finally:
            release_unlink.set()
            await asyncio.gather(clear_task, return_exceptions=True)

        assert not oauth_path.exists()
        assert not creds_path.exists()
        assert mutation_order == [oauth_path.name, creds_path.name, "sweep"]

    @pytest.mark.anyio
    async def test_repeated_clear_cancellation_waits_for_mutation_before_sweep(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Repeated cancellation must not overtake retained credential mutation work."""
        import app

        mutation_started = asyncio.Event()
        release_mutation = asyncio.Event()
        mutation_order: list[str] = []
        original_finish = app.finish_library_credential_mutation
        original_unlink = app._unlink_if_exists
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        oauth_path = app._oauth_file("user-1")
        creds_path = app._client_creds_file("user-1")
        oauth_path.write_text("{}")
        creds_path.write_text("{}")

        def tracked_unlink(path: Path) -> None:
            original_unlink(path)
            mutation_order.append(path.name)

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            mutation_started.set()
            await release_mutation.wait()
            return function(*args, **kwargs)

        async def tracked_finish(user_id: str, token: int) -> None:
            await original_finish(user_id, token)
            mutation_order.append("sweep")

        monkeypatch.setattr(app, "_unlink_if_exists", tracked_unlink)
        monkeypatch.setattr(app, "finish_library_credential_mutation", tracked_finish)
        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        clear_task = asyncio.create_task(app.auth_clear(user_id="user-1"))
        try:
            await asyncio.wait_for(mutation_started.wait(), timeout=2)
            clear_task.cancel()
            await _wait_for_ready_queue_turn()
            clear_task.cancel()
            await _wait_for_ready_queue_turn()
            assert not clear_task.done()
            assert mutation_order == []
            release_mutation.set()
            with pytest.raises(asyncio.CancelledError):
                await clear_task
        finally:
            release_mutation.set()
            await asyncio.gather(clear_task, return_exceptions=True)

        assert not oauth_path.exists()
        assert not creds_path.exists()
        assert mutation_order == [oauth_path.name, creds_path.name, "sweep"]

    @pytest.mark.anyio
    async def test_stalled_credential_mutation_fails_closed_and_fresh_mutation_recovers(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A stuck filesystem worker must time out without reopening its cache fence."""
        import app

        mutation_started = asyncio.Event()
        release_mutation = asyncio.Event()
        late_failure_consumed = asyncio.Event()
        loop = asyncio.get_running_loop()
        original_handler = loop.get_exception_handler()
        exception_contexts: list[dict[str, Any]] = []
        original_consume = app._consume_retained_credential_mutation_task
        mutation_calls = 0
        provider = MagicMock(
            side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request.")
        )
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        monkeypatch.setattr(app, "CREDENTIAL_MUTATION_SETTLEMENT_TIMEOUT_SECONDS", 0.05)
        app._library_playlist_error_cache.clear()

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            nonlocal mutation_calls
            if function is app._clear_credential_files:
                mutation_calls += 1
            if function is app._clear_credential_files and mutation_calls == 1:
                mutation_started.set()
                await release_mutation.wait()
                raise OSError("late credential mutation failed")
            return function(*args, **kwargs)

        def track_late_failure(task: asyncio.Task[None]) -> None:
            original_consume(task)
            if task.done() and isinstance(task.exception(), OSError):
                late_failure_consumed.set()

        loop.set_exception_handler(lambda _loop, context: exception_contexts.append(context))
        monkeypatch.setattr(app, "_consume_retained_credential_mutation_task", track_late_failure)
        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        clear_error: HTTPException | None = None
        clear_task = asyncio.create_task(app.auth_clear(user_id="user-1"))
        try:
            await asyncio.wait_for(mutation_started.wait(), timeout=2)
            try:
                await asyncio.wait_for(asyncio.shield(clear_task), timeout=0.5)
            except HTTPException as error:
                clear_error = error

            assert clear_error is not None
            assert clear_error.status_code == 503
            assert "user-1" in app._library_playlist_credential_mutations

            with patch("app._run_ytmusic_with_auth_retry", provider):
                fenced = await _capture_playlist_result(app, "user-1")
            assert fenced.status_code == 502
            assert ("user-1", 25, False) not in app._library_playlist_error_cache

            retained_tasks = tuple(app._retained_credential_mutation_tasks)
            assert len(retained_tasks) == 1
            release_mutation.set()
            await asyncio.gather(*retained_tasks, return_exceptions=True)
            await asyncio.wait_for(late_failure_consumed.wait(), timeout=2)
            await _wait_for_ready_queue_turn()
            assert app._retained_credential_mutation_tasks == set()

            recovered = await app.auth_clear(user_id="user-1")
            assert recovered["status"] == "ok"
            assert "user-1" not in app._library_playlist_credential_mutations

            provider.reset_mock()
            with patch("app._run_ytmusic_with_auth_retry", provider):
                first = await _capture_playlist_result(app, "user-1")
                second = await _capture_playlist_result(app, "user-1")
            assert first.status_code == 502
            assert second.status_code == 502
            assert provider.call_count == 1

            clear_error = None
            gc.collect()
            await _wait_for_ready_queue_turn()
            assert exception_contexts == []
        finally:
            loop.set_exception_handler(original_handler)
            release_mutation.set()
            await asyncio.gather(clear_task, return_exceptions=True)

    @pytest.mark.anyio
    async def test_late_credential_restore_invalidates_client_cached_after_timeout(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Late mutation settlement must sweep clients cached after the request timed out."""
        import app

        class CredentialSnapshot:
            """Capture the credential contents used to construct one client."""

            def __init__(self, oauth_path: str, **_kwargs: Any) -> None:
                self.oauth_json = Path(oauth_path).read_text()

        mutation_started = asyncio.Event()
        release_mutation = asyncio.Event()
        late_finalized = asyncio.Event()
        loop = asyncio.get_running_loop()
        original_handler = loop.get_exception_handler()
        exception_contexts: list[dict[str, Any]] = []
        original_finish = app.finish_library_credential_mutation
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        monkeypatch.setattr(app, "YTMusic", CredentialSnapshot)
        monkeypatch.setattr(app, "CREDENTIAL_MUTATION_SETTLEMENT_TIMEOUT_SECONDS", 0.05)
        app._oauth_file("user-1").write_text('{"credential":"old"}')

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            if function is app._write_credential_files:
                mutation_started.set()
                await release_mutation.wait()
            return function(*args, **kwargs)

        async def tracked_finish(user_id: str, token: int) -> None:
            await original_finish(user_id, token)
            late_finalized.set()

        loop.set_exception_handler(lambda _loop, context: exception_contexts.append(context))
        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        monkeypatch.setattr(app, "finish_library_credential_mutation", tracked_finish)
        restore_task = asyncio.create_task(
            app.auth_restore(
                _JsonRequest({"oauth_json": '{"credential":"new"}'}),
                user_id="user-1",
            )
        )
        try:
            await asyncio.wait_for(mutation_started.wait(), timeout=2)
            with pytest.raises(HTTPException) as error:
                await asyncio.wait_for(asyncio.shield(restore_task), timeout=0.5)
            assert error.value.status_code == 503

            stale_client = app._get_ytmusic("user-1")
            app._ytmusic_auto_tv_fallback_users.add("user-1")
            app._remember_library_playlist_error(("user-1", 25, False))

            release_mutation.set()
            await asyncio.wait_for(late_finalized.wait(), timeout=2)
            await _wait_for_ready_queue_turn()

            assert "user-1" not in app._ytmusic_instances
            assert "user-1" not in app._ytmusic_auto_tv_fallback_users
            assert ("user-1", 25, False) not in app._library_playlist_error_cache
            assert "user-1" not in app._library_playlist_credential_mutations
            fresh_client = app._get_ytmusic("user-1")
            assert fresh_client is not stale_client
            assert fresh_client.oauth_json == '{"credential":"new"}'

            gc.collect()
            await _wait_for_ready_queue_turn()
            assert exception_contexts == []
        finally:
            loop.set_exception_handler(original_handler)
            release_mutation.set()
            await asyncio.gather(restore_task, return_exceptions=True)
            await asyncio.gather(*app._retained_credential_mutation_tasks, return_exceptions=True)

    @pytest.mark.anyio
    async def test_credential_clear_removes_cached_failure_before_401(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Disconnecting should expose the authentication 401 instead of cached 502."""
        import app

        app._library_playlist_error_cache.clear()
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        calls = 0

        def fail_then_unauthorized(uid: Any, operation: Any, func: Any) -> Any:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise YTMusicServerError("Server returned HTTP 400: Bad Request.")
            raise HTTPException(status_code=401, detail="No OAuth credentials")

        with patch("app._run_ytmusic_with_auth_retry", side_effect=fail_then_unauthorized):
            failed = await _capture_playlist_result(app, "user-1")
            app._remember_library_playlist_error(("user-1", 25, True))
            app._remember_library_playlist_error(("user-2", 25, False))
            cleared = await app.auth_clear(user_id="user-1")
            disconnected = await _capture_playlist_result(app, "user-1")

        assert failed.status_code == 502
        assert cleared["status"] == "ok"
        assert disconnected.status_code == 401
        assert calls == 2
        assert not any(key[0] == "user-1" for key in app._library_playlist_error_cache)
        assert ("user-2", 25, False) in app._library_playlist_error_cache

    @pytest.mark.anyio
    async def test_credential_clear_sweeps_failure_admitted_during_unlink(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A provider 400 during credential removal must not survive completed clear."""
        import app

        old_provider_started = asyncio.Event()
        mid_clear_provider_started = asyncio.Event()
        oauth_unlinked = asyncio.Event()
        release_clear = asyncio.Event()
        release_providers = asyncio.Event()
        provider_calls = 0
        app._library_playlist_error_cache.clear()
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        oauth_path = app._oauth_file("user-1")
        oauth_path.write_text("{}")

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            if function is app._clear_credential_files:
                app._unlink_if_exists(oauth_path)
                oauth_unlinked.set()
                await release_clear.wait()
                app._unlink_if_exists(app._client_creds_file(args[0]))
                return None
            return function(*args, **kwargs)

        async def controlled_provider(user_id: str, limit: int) -> Any:
            nonlocal provider_calls
            provider_calls += 1
            if provider_calls == 1:
                old_provider_started.set()
            else:
                mid_clear_provider_started.set()
            await release_providers.wait()
            return app._call_library_playlist_provider(user_id, limit)

        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        monkeypatch.setattr(app, "_run_library_playlist_provider", controlled_provider)
        with (
            patch(
                "app._run_ytmusic_with_auth_retry",
                side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request."),
            ),
            patch(
                "app._sanitized_http_error",
                side_effect=lambda _operation, _error, status, detail: _library_error(
                    status, detail
                ),
            ),
        ):
            old_request = asyncio.create_task(_capture_playlist_result(app, "user-1"))
            await asyncio.wait_for(old_provider_started.wait(), timeout=2)
            clear_task = asyncio.create_task(app.auth_clear(user_id="user-1"))
            await asyncio.wait_for(oauth_unlinked.wait(), timeout=2)
            assert not oauth_path.exists()
            mid_clear_request = asyncio.create_task(_capture_playlist_result(app, "user-1"))
            try:
                await asyncio.wait_for(mid_clear_provider_started.wait(), timeout=2)
                assert provider_calls == 2
                release_clear.set()
                cleared = await clear_task
                cache_after_clear = dict(app._library_playlist_error_cache)
            finally:
                release_clear.set()
                release_providers.set()
                await asyncio.gather(
                    old_request,
                    mid_clear_request,
                    clear_task,
                    return_exceptions=True,
                )
            old_response = old_request.result()
            mid_clear_response = mid_clear_request.result()

        assert cleared["status"] == "ok"
        assert cache_after_clear == {}
        assert old_response.status_code == 502
        assert mid_clear_response.status_code == 502
        assert app._library_playlist_error_cache == {}

    @pytest.mark.anyio
    async def test_device_code_replacement_clears_cached_failure(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """New device-code credentials should force the next request upstream."""
        import app

        class SuccessfulOAuthCredentials:
            """Return one deterministic replacement token."""

            def __init__(self, client_id: Any, client_secret: Any) -> None:
                pass

            def token_from_code(self, device_code: Any) -> dict[str, str]:
                return {"access_token": "access", "refresh_token": "refresh"}

        app._library_playlist_error_cache.clear()
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)
        monkeypatch.setattr(app, "OAuthCredentials", SuccessfulOAuthCredentials)
        calls = 0

        def fail_then_succeed(uid: Any, operation: Any, func: Any) -> Any:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise YTMusicServerError("Server returned HTTP 400: Bad Request.")
            return _provider_result(func, [])

        with patch("app._run_ytmusic_with_auth_retry", side_effect=fail_then_succeed):
            failed = await _capture_playlist_result(app, "user-1")
            replaced = await app.auth_device_code_poll(
                app.DeviceCodePollRequest(
                    client_id="cid", client_secret="secret", device_code="dc"
                ),
                user_id="user-1",
            )
            retried = await _capture_playlist_result(app, "user-1")

        assert failed.status_code == 502
        assert replaced["status"] == "success"
        assert retried["total"] == 0
        assert calls == 2

    @pytest.mark.anyio
    async def test_credential_restore_detaches_active_old_credential_flight(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Restoring credentials should allow new work while the old worker settles."""
        import app

        first_started = asyncio.Event()
        release_first = asyncio.Event()
        calls = 0
        app._library_playlist_error_cache.clear()
        monkeypatch.setattr(app, "DATA_PATH", tmp_path)

        def succeed(uid: Any, operation: Any, func: Any) -> Any:
            return _provider_result(func, [])

        async def controlled_to_thread(function: Any, *args: Any, **kwargs: Any) -> Any:
            return function(*args, **kwargs)

        async def controlled_provider(user_id: str, limit: int) -> Any:
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                await release_first.wait()
                raise YTMusicServerError("Server returned HTTP 400: Bad Request.")
            return app._call_library_playlist_provider(user_id, limit)

        monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)
        monkeypatch.setattr(app, "_run_library_playlist_provider", controlled_provider)
        with patch("app._run_ytmusic_with_auth_retry", side_effect=succeed):
            old_request = asyncio.create_task(_capture_playlist_result(app, "user-1"))
            await asyncio.wait_for(first_started.wait(), timeout=2)
            try:
                restored = await app.auth_restore(
                    _JsonRequest({"oauth_json": "{}"}), user_id="user-1"
                )
                retried = await asyncio.wait_for(_capture_playlist_result(app, "user-1"), timeout=2)
            finally:
                release_first.set()
            old_response = await old_request
            after_old_settled = await _capture_playlist_result(app, "user-1")

        assert restored["status"] == "ok"
        assert retried["total"] == 0
        assert old_response.status_code == 502
        assert after_old_settled["total"] == 0
        assert calls == 3
        assert not any(key[0] == "user-1" for key in app._library_playlist_error_cache)
        assert app._library_playlist_inflight == {}

    @pytest.mark.anyio
    async def test_negative_cache_expires_without_sleep(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An expired entry should allow the provider call again."""
        import app

        now = 100.0
        monkeypatch.setattr(app, "LIBRARY_ERROR_CACHE_SECONDS", 10)
        monkeypatch.setattr(app, "_library_playlist_error_now", lambda: now)
        app._library_playlist_error_cache.clear()
        mock_run = MagicMock(
            side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request.")
        )

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            await client.get("/library/playlists", params={"user_id": "user-1"})
            now = 111.0
            await client.get("/library/playlists", params={"user_id": "user-1"})

        assert mock_run.call_count == 2

    @pytest.mark.anyio
    async def test_success_clears_a_concurrent_negative_cache_entry(
        self, client: AsyncClient
    ) -> None:
        """A successful provider response should remove a same-user failure entry."""
        import app

        app._library_playlist_error_cache.clear()

        def cache_then_succeed(uid: Any, operation: Any, func: Any) -> Any:
            app._remember_library_playlist_error((uid, 25, False))
            return func(MagicMock(get_library_playlists=MagicMock(return_value=[])))

        with patch("app._run_ytmusic_with_auth_retry", side_effect=cache_then_succeed):
            response = await client.get("/library/playlists", params={"user_id": "user-1"})

        assert response.status_code == 200
        assert ("user-1", 25, False) not in app._library_playlist_error_cache

    @pytest.mark.anyio
    async def test_negative_cache_evicts_oldest_entry_at_size_bound(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The oldest request-shape failure should be evicted at the cache cap."""
        import app

        monkeypatch.setattr(app, "LIBRARY_ERROR_CACHE_MAX", 2)
        app._library_playlist_error_cache.clear()
        mock_run = MagicMock(
            side_effect=YTMusicServerError("Server returned HTTP 400: Bad Request.")
        )

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            for user_id in ("user-1", "user-2", "user-3"):
                await client.get("/library/playlists", params={"user_id": user_id})

        assert list(app._library_playlist_error_cache) == [
            ("user-2", 25, False),
            ("user-3", 25, False),
        ]

    @pytest.mark.anyio
    async def test_transient_non_provider_failure_is_not_cached(self, client: AsyncClient) -> None:
        """Generic timeouts should be retried because they may be transient."""
        import app

        app._library_playlist_error_cache.clear()
        mock_run = MagicMock(side_effect=TimeoutError("provider timed out"))

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            first = await client.get("/library/playlists", params={"user_id": "user-1"})
            second = await client.get("/library/playlists", params={"user_id": "user-1"})

        assert first.status_code == 500
        assert second.status_code == 500
        assert mock_run.call_count == 2
