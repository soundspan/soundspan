"""Behavioral coverage for queued audio-path containment."""

from __future__ import annotations

import logging
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


class RecordingAnalyzer:
    """Record analysis requests without opening audio files."""

    def __init__(self) -> None:
        self.paths: list[str] = []

    def analyze(self, file_path: str) -> dict[str, Any]:
        """Record the resolved path and return a successful result."""
        self.paths.append(file_path)
        return {"bpm": 120.0}


def _analyze_queued_path(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    music_root: Path,
    queued_path: str,
) -> tuple[RecordingAnalyzer, tuple[str, str, dict[str, Any]]]:
    """Run one queued path through the process-worker boundary."""
    analyzer = RecordingAnalyzer()
    monkeypatch.setattr(module, "MUSIC_PATH", str(music_root))
    monkeypatch.setattr(module, "_process_analyzer", analyzer)
    result = module._analyze_track_in_process(("track-1", queued_path))
    return analyzer, result


@pytest.mark.parametrize("attack_kind", ["absolute", "dot_segment"])
def test_queued_traversal_path_is_rejected_without_analysis(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    attack_kind: str,
) -> None:
    """Reject absolute and parent-traversal queue values before analysis."""
    music_root = tmp_path / "music"
    music_root.mkdir()
    outside_file = tmp_path / "outside.flac"
    outside_file.touch()
    queued_path = str(outside_file) if attack_kind == "absolute" else "../outside.flac"

    with caplog.at_level(logging.WARNING):
        analyzer, result = _analyze_queued_path(
            loaded_analyzer,
            monkeypatch,
            music_root,
            queued_path,
        )

    assert analyzer.paths == []
    assert result[2] == {"_error": "Invalid audio path", "_permanent": True}
    assert "Rejected queued audio path" in caplog.text
    assert str(outside_file) not in caplog.text
    assert queued_path not in caplog.text


def test_queued_symlink_escape_is_rejected_without_analysis(
    loaded_analyzer: ModuleType,
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

    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        "linked/track.flac",
    )

    assert analyzer.paths == []
    assert result[2] == {"_error": "Invalid audio path", "_permanent": True}


def test_queued_in_library_path_is_analyzed(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resolve and analyze a valid relative path beneath the music library."""
    music_root = tmp_path / "music"
    track_path = music_root / "artist" / "track.flac"
    track_path.parent.mkdir(parents=True)
    track_path.touch()

    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        "artist/track.flac",
    )

    assert analyzer.paths == [str(track_path.resolve())]
    assert result == ("track-1", "artist/track.flac", {"bpm": 120.0})
