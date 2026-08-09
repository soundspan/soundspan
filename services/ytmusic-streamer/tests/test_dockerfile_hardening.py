"""Future-contract file tests for hardening the sidecar container startup."""

import os
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"
ENTRYPOINT_SCRIPT = SERVICE_ROOT / "docker-entrypoint.sh"


def test_dockerfile_has_no_world_writable_chmod() -> None:
    """The image build must not grant world-write permission with chmod 777."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "chmod 777" not in dockerfile


def test_dockerfile_uses_entrypoint_script() -> None:
    """The tini entrypoint must delegate startup through docker-entrypoint.sh."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    entrypoint_lines = [
        line for line in dockerfile.splitlines() if line.strip().startswith("ENTRYPOINT")
    ]

    assert any(
        "tini" in line and "docker-entrypoint.sh" in line for line in entrypoint_lines
    )


def test_entrypoint_script_fixes_legacy_volume_ownership() -> None:
    """Startup must repair /data ownership and then support non-root execution."""
    assert ENTRYPOINT_SCRIPT.exists()

    script = ENTRYPOINT_SCRIPT.read_text(encoding="utf-8")
    assert "chown" in script
    assert "setpriv" in script
    assert "/data" in script
    assert 'exec "$@"' in script


def test_entrypoint_script_is_executable() -> None:
    """The startup entrypoint script must have an executable mode bit."""
    assert os.access(ENTRYPOINT_SCRIPT, os.X_OK)
