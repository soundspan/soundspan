"""HTTP provider contract tests for the torch CLAP sidecar."""

from __future__ import annotations

import importlib.util
import json
import math
import re
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_audio_analyzer_clap_env import _load_analyzer_with_recording_redis

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
HTTP_SERVER_PATH = SERVICE_ROOT / "http_server.py"
MIGRATION_PATH = (
    REPOSITORY_ROOT
    / "backend/prisma/migrations/20260816120000_add_embedding_space_registry/migration.sql"
)


class StubAnalyzer:
    """Return configurable vectors without loading the real CLAP model."""

    def __init__(
        self,
        *,
        text_result: np.ndarray | None = None,
        audio_result: np.ndarray | None = None,
        error: Exception | None = None,
    ) -> None:
        self.text_result = text_result
        self.audio_result = audio_result
        self.error = error
        self.text_calls: list[str] = []
        self.audio_calls: list[str] = []

    def get_text_embedding(self, text: str) -> np.ndarray | None:
        """Record a text request and return the configured result."""
        self.text_calls.append(text)
        if self.error is not None:
            raise self.error
        return self.text_result

    def get_audio_embedding(self, audio_path: str) -> np.ndarray | None:
        """Record an audio request and return the configured result."""
        self.audio_calls.append(audio_path)
        if self.error is not None:
            raise self.error
        return self.audio_result


@pytest.fixture
def http_server_module(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """Load the HTTP module against an isolated analyzer module."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    analyzer_module = _load_analyzer_with_recording_redis(monkeypatch, [], [])
    monkeypatch.setitem(sys.modules, "analyzer", analyzer_module)
    spec = importlib.util.spec_from_file_location("clap_http_server_test_module", HTTP_SERVER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def _client(module: ModuleType, analyzer: StubAnalyzer) -> TestClient:
    """Create a provider-contract client for one analyzer stub."""
    return TestClient(module.create_app(analyzer))


def _seed_space() -> dict[str, Any]:
    """Read the canonical provider tuple from the registry migration."""
    migration = MIGRATION_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"VALUES\s*\(\s*'space_clap_music_audioset_v1',\s*"
        r"'(?P<family>[^']+)',\s*'(?P<hash>[0-9a-f]+)',\s*"
        r"(?P<dim>\d+),\s*'(?P<preprocessing>\{[^']+\})'::jsonb,\s*'active'\s*\)",
        migration,
        re.DOTALL,
    )
    assert match is not None
    preprocessing = json.loads(match.group("preprocessing"))
    return {
        "family": match.group("family"),
        "checkpointHash": match.group("hash"),
        "dim": int(match.group("dim")),
        "sampleRateHz": preprocessing["sampleRateHz"],
        "preprocessing": preprocessing,
    }


def test_health_does_not_load_model(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Report HTTP readiness without invoking either embedding tower."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    analyzer = StubAnalyzer(error=AssertionError("model must remain unloaded"))

    with _client(http_server_module, analyzer) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert analyzer.text_calls == []
    assert analyzer.audio_calls == []


def test_space_matches_registry_seed(http_server_module: ModuleType) -> None:
    """Expose exactly the embedding-space tuple seeded by the migration."""
    with _client(http_server_module, StubAnalyzer()) as client:
        response = client.get("/v1/space")

    assert response.status_code == 200
    assert response.json() == {
        **_seed_space(),
        "revision": http_server_module.clap.MODEL_VERSION,
        "textTower": True,
    }


@pytest.mark.parametrize("header", [None, "wrong-secret"])
def test_auth_rejects_missing_or_wrong_secret(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    header: str | None,
) -> None:
    """Require the configured internal secret on every route."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")
    headers = {} if header is None else {"X-Internal-Secret": header}

    with _client(http_server_module, StubAnalyzer()) as client:
        response = client.get("/health", headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "Unauthorized"}


def test_auth_accepts_matching_secret(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Allow requests carrying the configured internal secret."""
    monkeypatch.setenv("INTERNAL_API_SECRET", "expected-secret")

    with _client(http_server_module, StubAnalyzer()) as client:
        response = client.get("/health", headers={"X-Internal-Secret": "expected-secret"})

    assert response.status_code == 200


def test_auth_is_open_when_secret_is_not_configured(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the provider open when no internal secret is configured."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)

    with _client(http_server_module, StubAnalyzer()) as client:
        response = client.get("/health")

    assert response.status_code == 200


def test_text_embedding_is_normalized(http_server_module: ModuleType) -> None:
    """Defensively normalize a valid 512-dimensional model vector."""
    analyzer = StubAnalyzer(text_result=np.full(512, 2.0, dtype=np.float32))

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/text", json={"text": "mellow jazz"})

    assert response.status_code == 200
    vector = response.json()["vector"]
    assert len(vector) == 512
    assert math.isclose(math.sqrt(sum(value * value for value in vector)), 1.0, rel_tol=1e-6)
    assert analyzer.text_calls == ["mellow jazz"]


@pytest.mark.parametrize("text", ["", "x" * 2049])
def test_text_embedding_rejects_invalid_length(
    http_server_module: ModuleType,
    text: str,
) -> None:
    """Reject text outside the contract's inclusive 1..2048 range."""
    with _client(http_server_module, StubAnalyzer()) as client:
        response = client.post("/v1/embed/text", json={"text": text})

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid request body"}


def test_text_embedding_rejects_whitespace_only_text(
    http_server_module: ModuleType,
) -> None:
    """Reject text that is empty after stripping before model invocation."""
    analyzer = StubAnalyzer()

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/text", json={"text": " "})

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid request body"}
    assert analyzer.text_calls == []


def test_text_embedding_model_failure_is_unavailable(http_server_module: ModuleType) -> None:
    """Map model-load failures to the provider-unavailable response."""
    analyzer = StubAnalyzer(error=RuntimeError("checkpoint unavailable"))

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/text", json={"text": "mellow jazz"})

    assert response.status_code == 503
    assert response.json() == {"error": "Model unavailable"}


@pytest.mark.parametrize("track_ref", ["../outside.flac", "/etc/passwd"])
def test_audio_embedding_rejects_unsafe_refs(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    track_ref: str,
) -> None:
    """Drive traversal and absolute refs through the production resolver."""
    monkeypatch.setattr(http_server_module.clap, "MUSIC_PATH", str(tmp_path))
    analyzer = StubAnalyzer()

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/audio", json={"trackRef": track_ref})

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid trackRef"}
    assert analyzer.audio_calls == []


def test_audio_embedding_reports_missing_file(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return not-found before asking the analyzer to decode audio."""
    monkeypatch.setattr(http_server_module.clap, "MUSIC_PATH", str(tmp_path))
    analyzer = StubAnalyzer()

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/audio", json={"trackRef": "missing.flac"})

    assert response.status_code == 404
    assert response.json() == {"error": "Audio file not found"}
    assert analyzer.audio_calls == []


def test_audio_embedding_reports_decode_failure(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Map an existing but undecodable file to 422."""
    track = tmp_path / "broken.flac"
    track.touch()
    monkeypatch.setattr(http_server_module.clap, "MUSIC_PATH", str(tmp_path))
    analyzer = StubAnalyzer(audio_result=None)

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/audio", json={"trackRef": track.name})

    assert response.status_code == 422
    assert response.json() == {"error": "Audio could not be decoded"}
    assert analyzer.audio_calls == [str(track.resolve())]


def test_audio_embedding_reports_file_removed_during_analysis(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return not-found when the audio file disappears during analysis."""
    track = tmp_path / "removed.flac"
    track.touch()
    monkeypatch.setattr(http_server_module.clap, "MUSIC_PATH", str(tmp_path))

    class RemovingAnalyzer(StubAnalyzer):
        def get_audio_embedding(self, audio_path: str) -> None:
            self.audio_calls.append(audio_path)
            Path(audio_path).unlink()

    analyzer = RemovingAnalyzer()

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/audio", json={"trackRef": track.name})

    assert response.status_code == 404
    assert response.json() == {"error": "Audio file not found"}
    assert analyzer.audio_calls == [str(track.resolve())]


def test_audio_embedding_is_normalized(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return a normalized 512-dimensional vector for valid library audio."""
    track = tmp_path / "track.flac"
    track.touch()
    monkeypatch.setattr(http_server_module.clap, "MUSIC_PATH", str(tmp_path))
    analyzer = StubAnalyzer(audio_result=np.full(512, 3.0, dtype=np.float32))

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/audio", json={"trackRef": track.name})

    assert response.status_code == 200
    vector = response.json()["vector"]
    assert len(vector) == 512
    assert math.isclose(math.sqrt(sum(value * value for value in vector)), 1.0, rel_tol=1e-6)


def test_invalid_model_vector_is_unavailable(http_server_module: ModuleType) -> None:
    """Reject a model result that violates the provider dimension contract."""
    analyzer = StubAnalyzer(text_result=np.ones(511, dtype=np.float32))

    with _client(http_server_module, analyzer) as client:
        response = client.post("/v1/embed/text", json={"text": "mellow jazz"})

    assert response.status_code == 503
    assert response.json() == {"error": "Model unavailable"}


def test_http_server_stops_when_stop_event_is_set(
    http_server_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop the supervised Uvicorn thread within a short join budget."""
    server_started = threading.Event()
    exit_requested = threading.Event()
    stop_event = threading.Event()

    class FakeServer:
        def __init__(self, _config: Any) -> None:
            self._should_exit = False

        @property
        def should_exit(self) -> bool:
            return self._should_exit

        @should_exit.setter
        def should_exit(self, value: bool) -> None:
            self._should_exit = value
            if value:
                exit_requested.set()

        def run(self) -> None:
            server_started.set()
            assert exit_requested.wait(timeout=1)

    monkeypatch.setattr(http_server_module.uvicorn, "Config", lambda *args, **kwargs: object())
    monkeypatch.setattr(http_server_module.uvicorn, "Server", FakeServer)
    server_thread = threading.Thread(
        target=http_server_module.run_http_server,
        args=(StubAnalyzer(), stop_event),
    )
    server_thread.start()
    try:
        assert server_started.wait(timeout=1)
        stop_event.set()
        server_thread.join(timeout=0.25)
        assert not server_thread.is_alive()
    finally:
        stop_event.set()
        server_thread.join(timeout=1)
