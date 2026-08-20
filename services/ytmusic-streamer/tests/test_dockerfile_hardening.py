"""Future-contract file tests for hardening the sidecar container startup."""

import os
import re
import subprocess
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"
ENTRYPOINT_SCRIPT = SERVICE_ROOT / "docker-entrypoint.sh"
REQUIREMENTS_LOCK = SERVICE_ROOT / "requirements.lock"


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

    assert any("tini" in line and "docker-entrypoint.sh" in line for line in entrypoint_lines)


def test_exempt_dependencies_are_constrained_and_verified() -> None:
    """The exempt install must retain lock pins and verify dependency consistency."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "requirements.lock > /tmp/lock-constraints.txt" in dockerfile
    assert "-c /tmp/lock-constraints.txt -r requirements-exempt.txt" in dockerfile
    assert "&& pip check" in dockerfile
    assert "&& rm /tmp/lock-constraints.txt" in dockerfile


def test_lock_constraint_sed_preserves_every_pinned_distribution() -> None:
    """The Dockerfile sed program must derive every pinned lock constraint."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    sed_match = re.search(
        r"RUN sed -n '([^']+)' requirements\.lock > /tmp/lock-constraints\.txt",
        dockerfile,
    )
    assert sed_match is not None

    derived = subprocess.run(  # noqa: S603 -- fixed executable and repo-owned sed program
        ["/usr/bin/sed", "-n", sed_match.group(1), str(REQUIREMENTS_LOCK)],
        check=True,
        capture_output=True,
        text=True,
    )
    derived_pins = set(derived.stdout.splitlines())
    lock_lines = REQUIREMENTS_LOCK.read_text(encoding="utf-8").splitlines()
    pinned_distributions = {
        line.split()[0] for line in lock_lines if re.match(r"^[A-Za-z0-9._-]+==", line)
    }

    assert pinned_distributions
    assert derived_pins == pinned_distributions


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
