"""Dependency-lock synchronization tests for the DCLAP provider."""

from __future__ import annotations

import re
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = SERVICE_ROOT / "requirements.lock"


def test_docker_python_matches_lock_target() -> None:
    """Require the shipped lock target to match the Python 3.12 image."""
    dockerfile = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")
    lock = LOCK_PATH.read_text(encoding="utf-8")
    image_match = re.search(
        r"^FROM python:(\d+)\.(\d+)-slim(?:@sha256:[0-9a-f]{64})?$",
        dockerfile,
        re.MULTILINE,
    )
    target_match = re.search(r"--python-version (\d+)\.(\d+) ", lock)

    assert image_match is not None
    assert target_match is not None
    assert tuple(int(part) for part in image_match.groups()) == (3, 12)
    assert tuple(int(part) for part in target_match.groups()) == (3, 12)
