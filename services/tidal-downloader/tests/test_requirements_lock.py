"""Dependency-lock synchronization tests for the TIDAL sidecar."""

import re
from pathlib import Path


def test_docker_python_matches_lock_target() -> None:
    """The image interpreter must match the version used to resolve its lock."""
    service_root = Path(__file__).resolve().parents[1]
    dockerfile = (service_root / "Dockerfile").read_text(encoding="utf-8")
    lock = (service_root / "requirements.lock").read_text(encoding="utf-8")
    image_match = re.search(
        r"^FROM python:(\d+)\.(\d+)-slim(?:@sha256:[0-9a-f]{64})?$", dockerfile, re.MULTILINE
    )
    target_match = re.search(r"--python-version (\d+)\.(\d+) ", lock)

    assert image_match is not None
    assert target_match is not None
    image_version = tuple(int(part) for part in image_match.groups())
    lock_version = tuple(int(part) for part in target_match.groups())
    assert image_version == (3, 14)
    assert lock_version == image_version


def test_uvicorn_lock_satisfies_manifest_floor() -> None:
    """The image lock must ship at least the Uvicorn floor in the manifest."""
    service_root = Path(__file__).resolve().parents[1]
    manifest = (service_root / "requirements.txt").read_text(encoding="utf-8")
    lock = (service_root / "requirements.lock").read_text(encoding="utf-8")
    floor_match = re.search(r"^uvicorn>=(\d+)\.(\d+)\.(\d+)$", manifest, re.MULTILINE)
    lock_match = re.search(r"^uvicorn==(\d+)\.(\d+)\.(\d+) \\", lock, re.MULTILINE)

    assert floor_match is not None
    assert lock_match is not None
    floor = tuple(int(part) for part in floor_match.groups())
    locked = tuple(int(part) for part in lock_match.groups())
    # 0.52.0 is the Uvicorn advisory security-baseline minimum; Dependabot may raise the floor above it.
    assert floor >= (0, 52, 0)
    assert locked >= floor
