"""Runtime and lock-target synchronization tests for the audio analyzer."""

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
    assert image_version == (3, 11)
    assert lock_version == image_version


# Essentia bundles its own TensorFlow C runtime, so the Python TensorFlow stack
# is never imported; it only shipped keras/protobuf advisories (#717).
PYTHON_TENSORFLOW_STACK = ("tensorflow", "keras", "tensorboard", "tf-keras")


def test_analyzer_locks_exclude_python_tensorflow() -> None:
    """Neither the analyzer lock nor the AIO lock may install Python TensorFlow."""
    service_root = Path(__file__).resolve().parents[1]
    repo_root = service_root.parents[1]
    locks = (service_root / "requirements.lock", repo_root / "requirements-aio.lock")

    for lock in locks:
        text = lock.read_text(encoding="utf-8")
        assert "essentia-tensorflow==" in text, lock.name
        for package in PYTHON_TENSORFLOW_STACK:
            pattern = rf"^{re.escape(package)}=="
            assert re.search(pattern, text, re.MULTILINE) is None, f"{package} in {lock.name}"
