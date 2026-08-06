"""Runtime and lock-target synchronization tests for the CLAP sidecar."""

import re
from pathlib import Path


def test_docker_python_matches_lock_target() -> None:
    """The image interpreter must match the version used to resolve its lock."""
    service_root = Path(__file__).resolve().parents[1]
    dockerfile = (service_root / "Dockerfile").read_text(encoding="utf-8")
    lock = (service_root / "requirements.lock").read_text(encoding="utf-8")
    image_match = re.search(r"^FROM python:(\d+)\.(\d+)-slim$", dockerfile, re.MULTILINE)
    target_match = re.search(r"--python-version (\d+)\.(\d+) ", lock)

    assert image_match is not None
    assert target_match is not None
    image_version = tuple(int(part) for part in image_match.groups())
    lock_version = tuple(int(part) for part in target_match.groups())
    assert image_version == (3, 12)
    assert lock_version == image_version
