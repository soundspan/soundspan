"""Wire-contract tests for the DCLAP HTTP provider."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from pathlib import Path

import http_server
import httpx
import music_path
import numpy as np
import pytest
from model_provider import AudioDecodeError


@pytest.fixture(autouse=True)
def inline_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep HTTP tests deterministic when the sandbox cannot wake executor threads."""

    async def run_inline(function: Callable[..., object], *args: object) -> object:
        await asyncio.sleep(0)
        return function(*args)

    monkeypatch.setattr(http_server.asyncio, "to_thread", run_inline)


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

    def start_idle_monitor(self) -> None:
        """Record app startup."""
        self.started += 1

    def stop_idle_monitor(self) -> None:
        """Record app shutdown."""
        self.stopped += 1

    def get_text_embedding(self, text: str) -> object:
        """Record and fulfill one text embedding."""
        self.text_calls.append(text)
        if self.error is not None:
            raise self.error
        return self.text_result

    def get_audio_embedding(self, audio_path: str) -> object:
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
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=transport, base_url="http://test") as client,
        ):
            return await client.request(method, path, json=json, headers=headers)

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


@pytest.mark.parametrize("header", [None, "wrong-secret"])
def test_auth_rejects_missing_or_wrong_secret(
    monkeypatch: pytest.MonkeyPatch,
    header: str | None,
) -> None:
    """Require the configured internal secret on every route."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")
    headers = {} if header is None else {"X-Internal-Secret": header}

    response = _request(StubProvider(), "GET", "/health", headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "Unauthorized"}


def test_auth_accepts_matching_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow a request with the matching internal secret."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")

    response = _request(
        StubProvider(),
        "GET",
        "/health",
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
    """Map invalid text bodies to the stable 400 response."""
    response = _request(StubProvider(), "POST", "/v1/embed/text", json=payload)

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid request body"}


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
