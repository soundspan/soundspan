"""Future-contract file tests for hardening the CLAP analyzer image."""

from __future__ import annotations

from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"


def test_no_dead_hf_token_secret_mount() -> None:
    """The public model download must not retain a dead build-secret contract."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "hf_token" not in dockerfile
    assert "HF_TOKEN" not in dockerfile
    assert "/run/secrets/hf_token" not in dockerfile


def test_model_integrity_check_retained() -> None:
    """The pinned CLAP model must retain its build-time integrity check."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
        in dockerfile
    )
    assert "sha256sum -c" in dockerfile


def test_runs_as_nonroot() -> None:
    """The CLAP analyzer process must continue to run as its non-root user."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "USER analyzer" in dockerfile
