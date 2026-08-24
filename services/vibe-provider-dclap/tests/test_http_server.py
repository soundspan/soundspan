"""Wire-contract tests for the DCLAP HTTP provider."""

from __future__ import annotations

import asyncio
import math
import threading
import time
from collections.abc import Callable
from pathlib import Path

import http_server
import httpx
import music_path
import numpy as np
import pytest
from model_provider import (
    AudioDecodeError,
    InferenceCancellation,
    InferenceCancelledError,
    InferenceDeadlineExceededError,
    InferenceQueueFullError,
)

INTERNAL_API_SECRET = "test-internal-secret-value"


@pytest.fixture(autouse=True)
def internal_api_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the internal secret used by authenticated behavior tests."""
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_API_SECRET)


@pytest.fixture(autouse=True)
def inline_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep HTTP tests deterministic when the sandbox cannot wake executor threads."""

    async def run_inline(function: Callable[..., object], *args: object) -> object:
        await asyncio.sleep(0)
        return function(*args)

    async def run_dependency_inline(
        function: Callable[..., object],
        **kwargs: object,
    ) -> object:
        return function(**kwargs)

    monkeypatch.setattr(http_server.asyncio, "to_thread", run_inline)
    monkeypatch.setattr(
        "fastapi.dependencies.utils.run_in_threadpool",
        run_dependency_inline,
    )


class StubProvider:
    """Return configurable embeddings without importing model dependencies."""

    def __init__(
        self,
        *,
        text_result: object | None = None,
        audio_result: object | None = None,
        error: Exception | None = None,
    ) -> None:
        self.text_result = text_result
        self.audio_result = audio_result
        self.error = error
        self.text_calls: list[str] = []
        self.audio_calls: list[str] = []
        self.started = 0
        self.stopped = 0
        self._admission = threading.BoundedSemaphore(1)

    def try_reserve_inference(self) -> bool:
        """Reserve one HTTP-owned inference admission slot."""
        return self._admission.acquire(blocking=False)

    def release_inference(self) -> None:
        """Release one HTTP-owned inference admission slot."""
        self._admission.release()

    def start_idle_monitor(self) -> None:
        """Record app startup."""
        self.started += 1

    def stop_idle_monitor(self) -> None:
        """Record app shutdown."""
        self.stopped += 1

    def get_text_embedding(
        self,
        text: str,
        _cancellation: InferenceCancellation,
    ) -> object:
        """Record and fulfill one text embedding."""
        self.text_calls.append(text)
        if self.error is not None:
            raise self.error
        return self.text_result

    def get_audio_embedding(
        self,
        audio_path: str,
        _cancellation: InferenceCancellation,
    ) -> object:
        """Record and fulfill one audio embedding."""
        self.audio_calls.append(audio_path)
        if self.error is not None:
            raise self.error
        return self.audio_result


def _request(
    provider: StubProvider,
    method: str,
    path: str,
    *,
    json: object | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """Send one request through HTTPX's direct ASGI transport."""

    async def send() -> httpx.Response:
        app = http_server.create_app(provider)
        transport = httpx.ASGITransport(app=app)
        request_headers = {"X-Internal-Secret": INTERNAL_API_SECRET} if headers is None else headers
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=transport, base_url="http://test") as client,
        ):
            return await client.request(method, path, json=json, headers=request_headers)

    return asyncio.run(send())


def test_health_never_loads_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve health without touching either embedding tower."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    provider = StubProvider(error=AssertionError("model must remain unloaded"))

    response = _request(provider, "GET", "/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert provider.text_calls == []
    assert provider.audio_calls == []
    assert (provider.started, provider.stopped) == (1, 1)


def test_space_is_the_distinct_pinned_student_space() -> None:
    """Expose the literal DCLAP student identity and preprocessing recipe."""
    response = _request(StubProvider(), "GET", "/v1/space")

    assert response.status_code == 200
    assert response.content == (
        b'{"family":"clap-music-audioset-dclap-student","checkpointHash":"c892c7a8666dfa5adec5f0b76ecdd9b5394f5afa925d1362750309b6b9b96639","dim":512,"sampleRateHz":48000,'
        b'"preprocessing":{"sampleRateHz":48000,"mono":true,"int16RoundTrip":true,"clip":[-1.0,1.0],"segmentSamples":480000,"hopSamples":240000,'
        b'"mel":{"nFft":2048,"hopLength":480,"winLength":2048,"nMels":128,"fminHz":0,"fmaxHz":14000,"window":"hann","center":true,"padMode":"reflect","power":2.0,'
        b'"powerToDb":{"ref":1.0,"amin":1e-10,"topDb":null},"tensorLayout":"(1,1,128,time)"},"aggregation":"mean+l2-normalize","normalizationEpsilon":1e-9},'
        b'"revision":"dclap-student-v1","textTower":true}'
    )
    assert response.json() == {
        "family": "clap-music-audioset-dclap-student",
        "checkpointHash": "c892c7a8666dfa5adec5f0b76ecdd9b5394f5afa925d1362750309b6b9b96639",
        "dim": 512,
        "sampleRateHz": 48000,
        "preprocessing": {
            "sampleRateHz": 48000,
            "mono": True,
            "int16RoundTrip": True,
            "clip": [-1.0, 1.0],
            "segmentSamples": 480000,
            "hopSamples": 240000,
            "mel": {
                "nFft": 2048,
                "hopLength": 480,
                "winLength": 2048,
                "nMels": 128,
                "fminHz": 0,
                "fmaxHz": 14000,
                "window": "hann",
                "center": True,
                "padMode": "reflect",
                "power": 2.0,
                "powerToDb": {"ref": 1.0, "amin": 1e-10, "topDb": None},
                "tensorLayout": "(1,1,128,time)",
            },
            "aggregation": "mean+l2-normalize",
            "normalizationEpsilon": 1e-9,
        },
        "revision": "dclap-student-v1",
        "textTower": True,
    }


def test_audio_budget_leaves_backend_abort_margin() -> None:
    """Keep fifteen seconds for cancellation mapping before the backend aborts."""
    assert http_server.AUDIO_INFERENCE_BUDGET_SECONDS == 100.0


@pytest.mark.parametrize("header", [None, "wrong-secret"])
def test_auth_rejects_missing_or_wrong_secret(
    monkeypatch: pytest.MonkeyPatch,
    header: str | None,
) -> None:
    """Require the configured internal secret on non-health routes."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")
    headers = {} if header is None else {"X-Internal-Secret": header}

    response = _request(StubProvider(), "GET", "/v1/space", headers=headers)

    assert response.status_code == 403
    assert response.json() == {"error": "Forbidden"}


def test_auth_rejects_unset_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed on non-health routes when the internal secret is unset."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)

    response = _request(StubProvider(), "GET", "/v1/space", headers={})

    assert response.status_code == 403
    assert response.json() == {"error": "Forbidden"}


def test_auth_rejects_published_default_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reject the published default even when the request header matches it."""
    default_secret = "soundspan-internal-secret-change-me"
    monkeypatch.setenv("INTERNAL_API_SECRET", default_secret)

    response = _request(
        StubProvider(),
        "GET",
        "/v1/space",
        headers={"X-Internal-Secret": default_secret},
    )

    assert response.status_code == 403
    assert response.json() == {"error": "Forbidden"}


def test_health_accepts_missing_header_with_configured_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the health probe exempt when the internal secret is configured."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")

    response = _request(StubProvider(), "GET", "/health", headers={})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_auth_accepts_matching_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow a request with the matching internal secret."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")

    response = _request(
        StubProvider(),
        "GET",
        "/v1/space",
        headers={"X-Internal-Secret": "expected-secret"},
    )

    assert response.status_code == 200


def test_text_embedding_returns_normalized_vector() -> None:
    """Return one normalized 512-dimensional text vector."""
    provider = StubProvider(text_result=np.full(512, 2.0, dtype=np.float32))

    response = _request(provider, "POST", "/v1/embed/text", json={"text": "mellow jazz"})

    vector = response.json()["vector"]
    assert response.status_code == 200
    assert len(vector) == 512
    assert math.isclose(math.sqrt(sum(value * value for value in vector)), 1.0, rel_tol=1e-6)
    assert provider.text_calls == ["mellow jazz"]


@pytest.mark.parametrize("payload", [{}, {"text": ""}, {"text": " "}, {"text": "x" * 2049}])
def test_text_embedding_rejects_invalid_body(payload: dict[str, str]) -> None:
    """Map invalid text bodies to the stable 422 response."""
    response = _request(StubProvider(), "POST", "/v1/embed/text", json=payload)

    assert response.status_code == 422
    assert response.json() == {"error": "Invalid request parameters"}


def test_text_model_load_failure_is_unavailable() -> None:
    """Map text model load failure to 503."""
    response = _request(
        StubProvider(error=RuntimeError("load failed")),
        "POST",
        "/v1/embed/text",
        json={"text": "mellow jazz"},
    )

    assert response.status_code == 503
    assert response.json() == {"error": "Model unavailable"}


@pytest.mark.parametrize(
    ("error", "status", "body"),
    [
        (
            InferenceDeadlineExceededError("deadline exceeded"),
            408,
            {"error": "Inference deadline exceeded"},
        ),
        (
            InferenceCancelledError("request cancelled"),
            503,
            {"error": "Inference cancelled"},
        ),
        (
            InferenceQueueFullError("queue full"),
            429,
            {"error": "Inference queue is full"},
        ),
    ],
)
def test_text_inference_control_failures_have_retryable_http_mappings(
    error: Exception,
    status: int,
    body: dict[str, str],
) -> None:
    """Expose deadline, cancellation, and admission outcomes as stable responses."""
    response = _request(
        StubProvider(error=error),
        "POST",
        "/v1/embed/text",
        json={"text": "mellow jazz"},
    )

    assert response.status_code == status
    assert response.json() == body
    if status == 429:
        assert response.headers["retry-after"] == "1"


def test_http_admission_rejects_before_executor_submission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return 429 without submitting excess work to the thread executor."""
    submissions = 0

    async def send_requests() -> tuple[httpx.Response, httpx.Response]:
        nonlocal submissions
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocking_to_thread(function: Callable[..., object], *args: object) -> object:
            nonlocal submissions
            submissions += 1
            started.set()
            await release.wait()
            return function(*args)

        monkeypatch.setattr(http_server.asyncio, "to_thread", blocking_to_thread)
        provider = StubProvider(text_result=np.ones(512, dtype=np.float32))
        app = http_server.create_app(provider)
        transport = httpx.ASGITransport(app=app)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                headers={"X-Internal-Secret": INTERNAL_API_SECRET},
            ) as client,
        ):
            active = asyncio.create_task(client.post("/v1/embed/text", json={"text": "active"}))
            await asyncio.wait_for(started.wait(), timeout=1)
            release_timer = asyncio.get_running_loop().call_later(0.2, release.set)
            try:
                rejected = await client.post("/v1/embed/text", json={"text": "excess"})
            finally:
                release_timer.cancel()
                release.set()
            return await active, rejected

    active_response, rejected_response = asyncio.run(send_requests())

    assert active_response.status_code == 200
    assert rejected_response.status_code == 429
    assert submissions == 1


def test_budget_expiry_returns_cancelled_response_without_waiting_for_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop awaiting timed-out blocking work while its thread reaches a safe point."""
    finished = threading.Event()

    class SlowProvider(StubProvider):
        def get_text_embedding(
            self,
            _text: str,
            _cancellation: InferenceCancellation,
        ) -> object:
            return np.ones(512, dtype=np.float32)

    async def slow_to_thread(function: Callable[..., object], *args: object) -> object:
        release = asyncio.Event()
        timer = asyncio.get_running_loop().call_later(0.4, release.set)
        try:
            await release.wait()
            return function(*args)
        finally:
            timer.cancel()
            finished.set()

    monkeypatch.setattr(http_server.asyncio, "to_thread", slow_to_thread)
    monkeypatch.setattr(http_server, "TEXT_INFERENCE_BUDGET_SECONDS", 0.02)
    started_at = time.monotonic()

    response = _request(
        SlowProvider(),
        "POST",
        "/v1/embed/text",
        json={"text": "slow"},
    )

    elapsed = time.monotonic() - started_at
    assert response.status_code == 503
    assert response.json() == {"error": "Inference cancelled"}
    assert elapsed < 0.2
    assert finished.wait(timeout=1)


def test_invalid_model_vector_is_unavailable() -> None:
    """Reject a model result outside the published 512-dimensional contract."""
    provider = StubProvider(text_result=np.ones(511, dtype=np.float32))

    response = _request(provider, "POST", "/v1/embed/text", json={"text": "mellow jazz"})

    assert response.status_code == 503
    assert response.json() == {"error": "Model unavailable"}


@pytest.mark.parametrize("track_ref", ["../outside.flac", "/etc/passwd", "bad\x00.flac"])
def test_audio_embedding_rejects_unsafe_refs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    track_ref: str,
) -> None:
    """Reject traversal, absolute, and NUL refs before model work."""
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))
    provider = StubProvider()

    response = _request(provider, "POST", "/v1/embed/audio", json={"trackRef": track_ref})

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid trackRef"}
    assert provider.audio_calls == []


def test_audio_embedding_reports_missing_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return 404 for a safe ref whose file does not exist."""
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))

    response = _request(
        StubProvider(),
        "POST",
        "/v1/embed/audio",
        json={"trackRef": "missing.flac"},
    )

    assert response.status_code == 404
    assert response.json() == {"error": "Audio file not found"}


def test_audio_embedding_returns_normalized_vector(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return one normalized audio vector for a contained file."""
    track = tmp_path / "track.flac"
    track.touch()
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))
    provider = StubProvider(audio_result=np.full(512, 3.0, dtype=np.float32))

    response = _request(provider, "POST", "/v1/embed/audio", json={"trackRef": track.name})

    assert response.status_code == 200
    assert len(response.json()["vector"]) == 512
    assert provider.audio_calls == [str(track.resolve())]


def test_audio_decode_failure_is_unprocessable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Map a loader decode error to 422 instead of provider unavailability."""
    track = tmp_path / "broken.flac"
    track.touch()
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))

    response = _request(
        StubProvider(error=AudioDecodeError("decode failed")),
        "POST",
        "/v1/embed/audio",
        json={"trackRef": track.name},
    )

    assert response.status_code == 422
    assert response.json() == {"error": "Audio could not be decoded"}


def test_audio_model_load_failure_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Map an audio model load error to 503."""
    track = tmp_path / "track.flac"
    track.touch()
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))

    response = _request(
        StubProvider(error=RuntimeError("load failed")),
        "POST",
        "/v1/embed/audio",
        json={"trackRef": track.name},
    )

    assert response.status_code == 503
    assert response.json() == {"error": "Model unavailable"}
