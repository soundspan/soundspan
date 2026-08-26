"""Behavioral tests for shared sidecar runtime helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from services.common.sidecar_runtime_utils import ensure_repository_root_on_path


@pytest.mark.parametrize("sidecar", ["tidal-streamer", "ytmusic-streamer"])
def test_shallow_container_module_path_does_not_append(
    monkeypatch: pytest.MonkeyPatch, sidecar: str
) -> None:
    """Container entrypoints with only two ancestors remain import-safe."""
    original_path = [f"existing-{sidecar}"]
    monkeypatch.setattr(sys, "path", original_path.copy())

    ensure_repository_root_on_path("/app/app.py")

    assert sys.path == original_path


def test_deep_repository_module_path_appends_root_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An in-tree sidecar module exposes the repository package root."""
    repository_root = tmp_path / "checkout"
    module_path = repository_root / "services" / "tidal-streamer" / "app.py"
    module_path.parent.mkdir(parents=True)
    monkeypatch.setattr(sys, "path", ["existing"])

    ensure_repository_root_on_path(str(module_path))
    ensure_repository_root_on_path(str(module_path))

    assert sys.path == ["existing", str(repository_root)]


def test_existing_repository_root_is_not_duplicated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An existing repository path remains a single sys.path entry."""
    repository_root = tmp_path / "checkout"
    module_path = repository_root / "services" / "ytmusic-streamer" / "app.py"
    module_path.parent.mkdir(parents=True)
    monkeypatch.setattr(sys, "path", [str(repository_root)])

    ensure_repository_root_on_path(str(module_path))

    assert sys.path == [str(repository_root)]


def test_deep_non_repository_module_path_does_not_append(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A deep layout without a services directory does not alter sys.path."""
    layout_root = tmp_path / "installed"
    module_path = layout_root / "package" / "sidecar" / "app.py"
    module_path.parent.mkdir(parents=True)
    monkeypatch.setattr(sys, "path", ["existing"])

    ensure_repository_root_on_path(str(module_path))

    assert sys.path == ["existing"]
