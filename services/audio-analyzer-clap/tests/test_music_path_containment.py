"""Behavioral coverage for queued CLAP audio-path containment."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
from test_audio_analyzer_clap_env import _load_analyzer_with_recording_redis


class SingleJobRedis:
    """Return one queued job to the worker."""

    def __init__(self, job: dict[str, Any]) -> None:
        self.job = job
        self.deleted: list[str] = []

    def blpop(self, queue: str, timeout: int) -> tuple[str, str]:
        """Return the configured job without external Redis I/O."""
        return queue, json.dumps(self.job)

    def delete(self, key: str) -> None:
        """Record released queue reservations."""
        self.deleted.append(key)


class RecordingAnalyzer:
    """Record embedding requests without opening audio files."""

    def __init__(self) -> None:
        self.paths: list[str] = []

    def get_audio_embedding(
        self,
        audio_path: str,
        duration: float | None = None,
    ) -> np.ndarray:
        """Record the resolved path and return a valid embedding."""
        self.paths.append(audio_path)
        return np.zeros(512, dtype=np.float32)


@pytest.fixture
def analyzer_module(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """Load the CLAP analyzer with isolated heavyweight dependencies."""
    return _load_analyzer_with_recording_redis(monkeypatch, [], [])


def _process_queued_path(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    music_root: Path,
    queued_path: str,
) -> tuple[RecordingAnalyzer, list[tuple[str, str]], list[str]]:
    """Run one queued path through the CLAP worker boundary."""
    analyzer = RecordingAnalyzer()
    worker = module.Worker(1, analyzer, threading.Event())
    worker.redis_client = SingleJobRedis(
        {"trackId": "track-1", "filePath": queued_path, "duration": 30.0}
    )
    status_updates: list[tuple[str, str]] = []
    stored_track_ids: list[str] = []
    monkeypatch.setattr(module, "MUSIC_PATH", str(music_root))
    monkeypatch.setattr(worker, "_claim_track", lambda _track_id: True)
    monkeypatch.setattr(
        worker,
        "_update_track_status",
        lambda track_id, status: status_updates.append((track_id, status)),
    )

    def store_embedding(track_id: str, _embedding: np.ndarray) -> bool:
        stored_track_ids.append(track_id)
        return True

    monkeypatch.setattr(worker, "_store_embedding", store_embedding)
    monkeypatch.setattr(worker, "_mark_failed", lambda _track_id, _error: None)
    worker._process_job()
    return analyzer, status_updates, stored_track_ids


@pytest.mark.parametrize("attack_kind", ["absolute", "dot_segment"])
def test_queued_traversal_path_is_rejected_without_embedding(
    analyzer_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    attack_kind: str,
) -> None:
    """Reject absolute and parent-traversal queue values before audio loading."""
    music_root = tmp_path / "music"
    music_root.mkdir()
    outside_file = tmp_path / "outside.flac"
    outside_file.touch()
    queued_path = str(outside_file) if attack_kind == "absolute" else "../outside.flac"

    with caplog.at_level(logging.WARNING):
        analyzer, _status_updates, stored_track_ids = _process_queued_path(
            analyzer_module,
            monkeypatch,
            music_root,
            queued_path,
        )

    assert analyzer.paths == []
    assert stored_track_ids == []
    assert "Rejected queued CLAP path" in caplog.text
    assert str(outside_file) not in caplog.text
    assert queued_path not in caplog.text


def test_queued_symlink_escape_is_rejected_without_embedding(
    analyzer_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Reject an in-root symlink whose resolved target escapes the library."""
    music_root = tmp_path / "music"
    music_root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "track.flac").touch()
    (music_root / "linked").symlink_to(outside_dir, target_is_directory=True)

    analyzer, _status_updates, stored_track_ids = _process_queued_path(
        analyzer_module,
        monkeypatch,
        music_root,
        "linked/track.flac",
    )

    assert analyzer.paths == []
    assert stored_track_ids == []


def test_queued_in_library_path_is_embedded(
    analyzer_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resolve and embed a valid relative path beneath the music library."""
    music_root = tmp_path / "music"
    track_path = music_root / "artist" / "track.flac"
    track_path.parent.mkdir(parents=True)
    track_path.touch()

    analyzer, status_updates, stored_track_ids = _process_queued_path(
        analyzer_module,
        monkeypatch,
        music_root,
        "artist/track.flac",
    )

    assert analyzer.paths == [str(track_path.resolve())]
    assert status_updates == [("track-1", "completed")]
    assert stored_track_ids == ["track-1"]


def test_duplicate_queue_job_is_skipped_when_pending_claim_fails(
    analyzer_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Do not generate a second embedding when another worker owns the track."""
    music_root = tmp_path / "music"
    track_path = music_root / "artist" / "track.flac"
    track_path.parent.mkdir(parents=True)
    track_path.touch()
    analyzer = RecordingAnalyzer()
    worker = analyzer_module.Worker(1, analyzer, threading.Event())
    redis_client = SingleJobRedis(
        {"trackId": "track-1", "filePath": "artist/track.flac", "duration": 30.0}
    )
    worker.redis_client = redis_client
    monkeypatch.setattr(analyzer_module, "MUSIC_PATH", str(music_root))
    monkeypatch.setattr(worker, "_claim_track", lambda _track_id: False)
    monkeypatch.setattr(
        worker,
        "_store_embedding",
        lambda _track_id, _embedding: pytest.fail("duplicate was stored"),
    )

    worker._process_job()

    assert analyzer.paths == []
    assert redis_client.deleted == ["audio:clap:queue:reserved:track-1"]
