"""Runtime and lock-target synchronization tests for the CLAP sidecar."""

import re
from pathlib import Path


def _version(text: str, pattern: str) -> tuple[int, ...]:
    """Extract a dotted numeric version matched by ``pattern``."""
    match = re.search(pattern, text, re.MULTILINE)

    assert match is not None
    assert match.groups()
    return tuple(int(part) for part in match.groups())


def test_docker_python_matches_lock_target() -> None:
    """The image interpreter must match the version used to resolve its lock."""
    service_root = Path(__file__).resolve().parents[1]
    dockerfile = (service_root / "Dockerfile").read_text(encoding="utf-8")
    lock = (service_root / "requirements.lock").read_text(encoding="utf-8")
    image_match = re.search(r"^FROM python:(\d+)\.(\d+)-slim(?:@sha256:[0-9a-f]{64})?$", dockerfile, re.MULTILINE)
    target_match = re.search(r"--python-version (\d+)\.(\d+) ", lock)

    assert image_match is not None
    assert target_match is not None
    image_version = tuple(int(part) for part in image_match.groups())
    lock_version = tuple(int(part) for part in target_match.groups())
    assert image_version == (3, 12)
    assert lock_version == image_version


def test_security_audit_python_matches_image_runtime() -> None:
    """The security matrix must evaluate markers with the shipped interpreter."""
    service_root = Path(__file__).resolve().parents[1]
    repository_root = service_root.parents[1]
    workflow = (repository_root / ".github/workflows/security-scanning.yml").read_text(
        encoding="utf-8"
    )
    matrix_match = re.search(
        r"requirements: services/audio-analyzer-clap/requirements\.lock\s+"
        r"python-version: \"(\d+)\.(\d+)\"",
        workflow,
    )

    assert matrix_match is not None
    assert tuple(int(part) for part in matrix_match.groups()) == (3, 12)


def test_redis_floor_is_satisfied_by_all_runtime_locks() -> None:
    """Both CLAP deployment locks must satisfy the manifest's Redis floor."""
    service_root = Path(__file__).resolve().parents[1]
    repository_root = service_root.parents[1]
    manifest = (service_root / "requirements.txt").read_text(encoding="utf-8")
    service_lock = (service_root / "requirements.lock").read_text(encoding="utf-8")
    aio_lock = (repository_root / "requirements-aio.lock").read_text(encoding="utf-8")

    redis_floor = _version(manifest, r"^redis>=(\d+)\.(\d+)\.(\d+)$")
    service_pin = _version(service_lock, r"^redis==(\d+)\.(\d+)\.(\d+) \\$")
    aio_pin = _version(aio_lock, r"^redis==(\d+)\.(\d+)\.(\d+) \\$")

    assert service_pin >= redis_floor
    assert aio_pin >= redis_floor
